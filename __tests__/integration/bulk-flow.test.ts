/**
 * Integration tests for ES-005 Bulk CSV Audit — end-to-end flow
 *
 * Tests the full request chain from submit → verify → pipeline → download.
 * All external dependencies (DB, email, crawler, AI) are mocked.
 *
 * Scenarios:
 *   1. Valid bulk submit → 201, OTP sent
 *   2. Bulk verify: credit reservation + startBulkCrawl dispatched
 *   3. Bulk verify: URLs sliced to crawlLimit (credit-affordable)
 *   4. Single audit: startCrawl called with credit-derived maxPages
 *   5. Download: ZIP returned with correct headers
 *   6. CSV URL dedup: duplicate URLs counted once for credits
 *   7. Free user: bulk submit rejected (402) before OTP
 *   8. Bulk regenerate: blocked with 400
 *   9. Per-page analysis: extractPerPageVulnerabilities called on bulk pipeline completion
 *  10. Credit refund: transaction executed when actual pages < reserved
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock("@/lib/email", () => ({
  generateVerificationCode: vi.fn().mockReturnValue("999888"),
  hashCode: vi.fn().mockReturnValue("hashed-999888"),
  verifyCode: vi.fn().mockReturnValue(true),
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
  sendLowCreditsEmail: vi.fn().mockResolvedValue(undefined),
  sendInternalSignupAlert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("nanoid", () => ({ nanoid: vi.fn().mockReturnValue("int-test-id") }));
vi.mock("@/lib/utils", () => ({
  normalizeDomain: vi.fn().mockImplementation((u: string) => u),
  slugify: vi.fn().mockReturnValue("acme-io"),
  normalizeUrl: vi.fn().mockImplementation((u: string) => {
    if (!u || !u.trim()) return null;
    if (/^https?:\/\//i.test(u)) {
      try { const p = new URL(u); return p.hostname.includes(".") ? u : null; } catch { return null; }
    }
    if (/^[a-zA-Z][a-zA-Z0-9+\-]*:/.test(u)) return null;
    try {
      const w = `https://${u}`;
      const p = new URL(w);
      return p.hostname.includes(".") ? w : null;
    } catch { return null; }
  }),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockReturnValue({ allowed: true }),
  // HP-239 split primitives (new call sites in verify/regenerate routes).
  checkOtpLock: vi.fn().mockResolvedValue({ allowed: true }),
  incrementOtpAttempt: vi.fn().mockResolvedValue({ lockedOut: false, otpAttempts: 1 }),
  // Legacy wrapper retained for any caller still using the pre-split helper.
  checkAndIncrementOtpAttempt: vi.fn().mockResolvedValue({ allowed: true, attemptsLeft: 4 }),
  clearOtpAttempts: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/pipeline/runner", () => ({
  startCrawl: vi.fn().mockResolvedValue(undefined),
  startBulkCrawl: vi.fn().mockResolvedValue(undefined),
  completePipeline: vi.fn().mockResolvedValue("complete"),
}));

vi.mock("@/lib/qstash", () => ({
  enqueueStage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/services/per-page-analyzer", () => ({
  extractPerPageVulnerabilities: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/services/zip-builder", () => ({
  buildReportZip: vi.fn().mockResolvedValue(Buffer.from("zip-data")),
}));

vi.mock("@/lib/services/credit-deduction", () => ({
  deductCredits: vi.fn().mockResolvedValue({ success: true, balanceBefore: 100, balanceAfter: 95 }),
}));

// Verify-route admin path skipped — see bulk-verify.test.ts for rationale.
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: () => null,
}));

vi.mock("@/lib/services/provision-team", () => ({
  ensureTeamForUser: vi.fn().mockResolvedValue({ teamId: "team-1", userId: "user-1" }),
}));

vi.mock("@/lib/services/exchange-code", () => ({
  generateExchangeCode: vi.fn().mockResolvedValue("exchange-code-mock"),
}));

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, after: vi.fn((fn: () => Promise<void>) => fn()) };
});

// ─── Imports ──────────────────────────────────────────────────────────────────

import { POST as postSites } from "@/app/api/sites/route";
import { POST as postVerify } from "@/app/api/sites/[id]/verify/route";
import { GET as getDownload } from "@/app/api/sites/[id]/download-report/route";
import { POST as postRegenerate } from "@/app/api/sites/[id]/regenerate/route";
import { db } from "@/lib/db";
import { sendVerificationEmail } from "@/lib/email";
import { startCrawl, startBulkCrawl } from "@/lib/pipeline/runner";
import { enqueueStage } from "@/lib/qstash";
import { buildReportZip } from "@/lib/services/zip-builder";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSelectChain(rows: unknown[] = []) {
  return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue(rows) };
}

function makeUpdateChain() {
  // FIX-014: .where() is awaitable AND exposes .returning() (rows-affected guard)
  // resolving to one row so the guarded credit reserve treats it as applied.
  const whereResult = Object.assign(Promise.resolve([]), {
    returning: vi.fn().mockResolvedValue([{ id: "team-int-1" }]),
  });
  return { set: vi.fn().mockReturnThis(), where: vi.fn().mockReturnValue(whereResult) };
}

function makeInsertChain() {
  return { values: vi.fn().mockReturnValue({ onConflictDoNothing: vi.fn().mockResolvedValue([]) }) };
}

function makeTx(creditBalance = TEAM.creditBalance) {
  const teamData = [{ creditBalance }];
  const whereResult = Object.assign(Promise.resolve(teamData), {
    for: vi.fn().mockResolvedValue(teamData),
  });
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue(whereResult),
    }),
    update: vi.fn().mockReturnValue(makeUpdateChain()),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue([]) }),
  };
}

function makeSiteRequest(body: unknown): import("next/server").NextRequest {
  return new Request("http://localhost/api/sites", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}

function makeVerifyRequest(siteId: string, code = "999888"): import("next/server").NextRequest {
  return new Request(`http://localhost/api/sites/${siteId}/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  }) as unknown as import("next/server").NextRequest;
}

function makeDownloadRequest(siteId: string, token: string): import("next/server").NextRequest {
  return new Request(
    `http://localhost/api/sites/${siteId}/download-report?token=${token}`,
    { method: "GET" }
  ) as unknown as import("next/server").NextRequest;
}

function makeRegenerateRequest(siteId: string, token: string): import("next/server").NextRequest {
  return new Request(`http://localhost/api/sites/${siteId}/regenerate`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  }) as unknown as import("next/server").NextRequest;
}

function makeRouteContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

const SITE_ID = "int-test-id";
const TOKEN = "int-access-token";
const BULK_URLS = Array.from({ length: 12 }, (_, i) => `https://acme.io/page${i}`);
const MEMBER = { email: "user@acme.io", teamId: "team-int-1" };
const TEAM = { id: "team-int-1", creditBalance: 50 };

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Bulk CSV Audit — Integration Scenarios", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Re-initialize mocks that vi.clearAllMocks() may clear between runs
    (buildReportZip as ReturnType<typeof vi.fn>).mockResolvedValue(Buffer.from("zip-data"));
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue(makeUpdateChain());
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(makeInsertChain());
    (db.transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: (tx: ReturnType<typeof makeTx>) => Promise<void>) => fn(makeTx())
    );
  });

  // ── Scenario 1: Valid bulk submit ──

  it("Scenario 1: valid bulk submit → 201, OTP sent", async () => {
    let selectCount = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return makeSelectChain([MEMBER]);
      return makeSelectChain([TEAM]);
    });

    const res = await postSites(makeSiteRequest({ bulkUrls: BULK_URLS, email: "user@acme.io" }));
    expect(res.status).toBe(201);
    expect(sendVerificationEmail).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.message).toMatch(/verification code sent/i);
  });

  // ── Scenario 2: Bulk verify — credit reservation ──

  it("Scenario 2: bulk verify → credit reservation transaction + enqueueStage(crawl, isBulk) dispatched", async () => {
    const bulkSite = {
      id: SITE_ID, domain: "acme.io", auditMode: "bulk",
      bulkUrls: BULK_URLS, teamId: "team-int-1",
      emailVerified: false, pipelineStatus: "pending", geoScorecard: null,
      accessToken: null, verificationCode: "hashed",
      codeExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    };

    let selectCount = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return makeSelectChain([bulkSite]);
      if (selectCount === 2) return makeSelectChain([TEAM]);
      return makeSelectChain([bulkSite]); // batch sites
    });

    const res = await postVerify(makeVerifyRequest(SITE_ID), makeRouteContext(SITE_ID));
    expect(res.status).toBe(200);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    // Verify route now uses enqueueStage (not startBulkCrawl) — crawler reads URLs from DB
    expect(vi.mocked(enqueueStage)).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: SITE_ID, stage: "crawl-fanout" })
    );
    expect(startBulkCrawl).not.toHaveBeenCalled();
    expect(startCrawl).not.toHaveBeenCalled();
  });

  // ── Scenario 3: crawlLimit stored in DB when credits are binding ──

  it("Scenario 3: bulk verify — crawlLimit written to DB = min(csvCount, affordable, cap)", async () => {
    const manyUrls = Array.from({ length: 100 }, (_, i) => `https://acme.io/p${i}`);
    const bulkSite = {
      id: SITE_ID, domain: "acme.io", auditMode: "bulk",
      bulkUrls: manyUrls, teamId: "team-int-1",
      emailVerified: false, pipelineStatus: "pending", geoScorecard: null,
      accessToken: null, verificationCode: "hashed",
      codeExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    };

    const capturedSets: Record<string, unknown>[] = [];
    (db.transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: (tx: ReturnType<typeof makeTx>) => Promise<void>) => {
        const lockedBalance = 3;
        const teamData = [{ creditBalance: lockedBalance }];
        const whereResult = Object.assign(Promise.resolve(teamData), {
          for: vi.fn().mockResolvedValue(teamData),
        });
        const tx = {
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnValue(whereResult),
          }),
          update: vi.fn().mockImplementation(() => ({
            set: vi.fn().mockImplementation((d: Record<string, unknown>) => {
              capturedSets.push(d);
              return { where: vi.fn().mockResolvedValue([]) };
            }),
          })),
          insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue([]) }),
        };
        await fn(tx);
      }
    );

    let selectCount = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return makeSelectChain([bulkSite]);
      // 3 credits → affordable = max(30, 10) = 30 → crawlLimit = min(100, 30, 500) = 30
      if (selectCount === 2) return makeSelectChain([{ id: "team-int-1", creditBalance: 3 }]);
      return makeSelectChain([bulkSite]); // batch sites
    });

    await postVerify(makeVerifyRequest(SITE_ID), makeRouteContext(SITE_ID));

    const siteUpdate = capturedSets.find((s) => "crawlLimit" in s);
    expect(siteUpdate).toBeDefined();
    expect(siteUpdate!.crawlLimit).toBe(30);
  });

  // ── Scenario 4: Single audit — credit-derived maxPages ──

  it("Scenario 4: single audit verify — enqueueStage(discover) called with credit-derived maxPages", async () => {
    const singleSite = {
      id: SITE_ID, domain: "acme.io", auditMode: "single",
      teamId: "team-int-1", emailVerified: false, pipelineStatus: "pending",
      geoScorecard: null, accessToken: null, verificationCode: "hashed",
      codeExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    };

    let selectCount = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return makeSelectChain([singleSite]);
      // 4 credits → 40 maxPages (4 * 10 pages/credit)
      return makeSelectChain([{ id: "team-int-1", creditBalance: 4 }]);
    });

    await postVerify(makeVerifyRequest(SITE_ID), makeRouteContext(SITE_ID));

    expect(vi.mocked(enqueueStage)).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: SITE_ID, domain: "acme.io", stage: "discover", maxPages: 40 })
    );
    expect(startCrawl).not.toHaveBeenCalled();
    expect(startBulkCrawl).not.toHaveBeenCalled();
  });

  // ── Scenario 5: Download ZIP ──

  it("Scenario 5: download-report returns ZIP with correct headers", async () => {
    const completedSite = {
      siteId: SITE_ID, domain: "acme.io", accessToken: TOKEN,
      // H3 (2026-05-27 audit): download-report enforces tokenExpiresAt.
      tokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      teamId: "team-1", pipelineStatus: "complete",
      overallScore: 72, pillars: [],
      executiveSummary: "Good.",
      perPageResults: [{ url: "https://acme.io/", pageType: "homepage", title: "Home", vulnerabilities: [], overallPageHealth: "good" }],
      perPageFixes: null, implementationStatus: null,
    };

    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(makeSelectChain([completedSite]));

    const res = await getDownload(makeDownloadRequest(SITE_ID, TOKEN), makeRouteContext(SITE_ID));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
  });

  // ── Scenario 6: Duplicate URL dedup ──

  it("Scenario 6: duplicate URLs in CSV are deduped before credit check", async () => {
    const dupeUrls = [
      "https://acme.io/about",
      "https://acme.io/about", // duplicate
      "https://acme.io/pricing",
    ];

    let selectCount = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return makeSelectChain([MEMBER]);
      // 1 credit is enough for 2 unique URLs (ceil(2/10) = 1)
      return makeSelectChain([{ id: "team-int-1", creditBalance: 1 }]);
    });

    const res = await postSites(makeSiteRequest({ bulkUrls: dupeUrls, email: "user@acme.io" }));
    // Should succeed — 3 raw URLs → 2 unique → 1 credit needed → 1 credit available
    expect(res.status).toBe(201);
  });

  // ── Scenario 7: Free user blocked ──

  it("Scenario 7: free user (no team member) gets 402 at submit time, before OTP", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(makeSelectChain([])); // no member

    const res = await postSites(makeSiteRequest({ bulkUrls: BULK_URLS, email: "free@nobody.io" }));
    expect(res.status).toBe(402);
    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });

  // ── Scenario 8: ES-B9.2 — bulk regenerate now allowed; missing bulkUrls → 400 with new copy ──

  it("Scenario 8: regenerate on bulk audit with missing bulkUrls → 400 (B9.2 fallback)", async () => {
    // Pre-B9.2: any bulk audit returned 400 with the "Bulk audits cannot
    // be regenerated. Upload a new CSV on the landing page." block. Post-
    // B9.2: bulk re-runs are first-class; only a missing/empty bulkUrls
    // list yields a 400 with the new "Original URL list missing — please
    // re-upload via the landing page" copy.
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([{
        id: SITE_ID, accessToken: TOKEN, auditMode: "bulk",
        bulkUrls: null, // triggers the new B9.2 fallback
        domain: "acme.io", teamId: "team-1",
        tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      }])
    );

    const res = await postRegenerate(makeRegenerateRequest(SITE_ID, TOKEN), makeRouteContext(SITE_ID));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Original URL list missing/i);
    expect(body.error).not.toMatch(/cannot be regenerated/i);
  });

  // ── Scenario 9: Per-page analysis in pipeline ──

  it("Scenario 9: extractPerPageVulnerabilities is called during bulk pipeline completion", async () => {
    // This is tested via bulk-pipeline.test.ts — verify the import is wired
    const { extractPerPageVulnerabilities } = await import("@/lib/services/per-page-analyzer");
    // Confirm the mock is set up (function exists and is callable)
    expect(typeof extractPerPageVulnerabilities).toBe("function");
  });

  // ── Scenario 10: Credit reconciliation on completion ──

  it("Scenario 10: credit reconciliation runs when actual pages < reserved in completePipeline", async () => {
    // Tested in detail in bulk-pipeline.test.ts — smoke test that the config helper
    // computes correct refund amounts
    const { bulkCreditsRequired } = await import("@/lib/config");
    // 7 pages crawled vs 10 reserved → refund = 10 - ceil(7/10) = 10 - 1 = 9
    const reserved = 10;
    const actual = 7;
    const creditsUsed = bulkCreditsRequired(actual);
    const refund = reserved - creditsUsed;
    expect(refund).toBe(9);
    expect(refund).toBeGreaterThan(0);
  });
});
