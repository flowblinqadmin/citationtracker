/**
 * Unit tests for ES-018 — batchId column on geo_sites
 *
 * U-1  Single-domain bulk: inserted row has batchId set
 * U-2  Multi-domain bulk: all rows share the same batchId
 * U-3  batchId matches the generated nanoid value
 * U-4  Single-audit insert: no batchId field (nullable)
 * U-5  Email rate limit path (single-audit) is not affected
 * U-6  verify: site.batchId set → sibling query by batchId
 * U-7  verify: site.batchId null → fallback to [site], no extra DB query
 * U-8  verify: old bulk site (batchId=null, auditMode=bulk) → fallback to [site]
 * U-9  verify: batchId query returns all siblings including self
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

let nanoidCounter = 0;
const BATCH_ID = "test-batch-id-00000";
const PRIMARY_SITE_ID = "test-primary-site-id";
const nanoidSequence = [
  BATCH_ID,         // batchId
  PRIMARY_SITE_ID,  // primarySiteId
  // additional ids for multi-domain
  "domain2-site-id",
  "domain3-site-id",
  // verification code hash id etc.
  "code-hash-1",
];
vi.mock("nanoid", () => ({
  nanoid: vi.fn().mockImplementation(() => {
    const val = nanoidSequence[nanoidCounter % nanoidSequence.length] ?? `nano-${nanoidCounter}`;
    nanoidCounter++;
    return val;
  }),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock("@/lib/email", () => ({
  generateVerificationCode: vi.fn().mockReturnValue("123456"),
  hashCode: vi.fn().mockReturnValue("hashed-otp"),
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
  sendLowCreditsEmail: vi.fn().mockResolvedValue(undefined),
  sendInternalSignupAlert: vi.fn().mockResolvedValue(undefined),
  verifyCode: vi.fn().mockReturnValue(true),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 5, resetAt: Date.now() + 60000 }),
  // HP-239 split primitives.
  checkOtpLock: vi.fn().mockResolvedValue({ allowed: true }),
  incrementOtpAttempt: vi.fn().mockResolvedValue({ lockedOut: false, otpAttempts: 1 }),
  checkAndIncrementOtpAttempt: vi.fn().mockResolvedValue({ allowed: true, attemptsLeft: 4 }),
  clearOtpAttempts: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/qstash", () => ({
  enqueueStage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/utils", () => ({
  normalizeDomain: vi.fn().mockReturnValue("acme.com"),
  slugify: vi.fn().mockImplementation((d: string) => d.replace(/\./g, "-")),
  normalizeUrl: vi.fn().mockImplementation((u: string) => {
    try {
      const parsed = new URL(u.startsWith("http") ? u : `https://${u}`);
      return parsed.href;
    } catch { return null; }
  }),
}));

// Verify-route admin path is opt-in via getSupabaseAdmin(). Without these
// mocks the route tries to fetch NEXT_PUBLIC_SUPABASE_URL (set to a stub
// host in vitest.setup.ts) and the 5s per-test timeout fires before the
// assertion. Added 2026-05-16 during main → integration merge.
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: () => null,
}));

vi.mock("@/lib/services/provision-team", () => ({
  ensureTeamForUser: vi.fn().mockResolvedValue({ teamId: "team-1", userId: "user-1" }),
}));

vi.mock("@/lib/services/exchange-code", () => ({
  generateExchangeCode: vi.fn().mockResolvedValue("exchange-code-mock"),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { POST as postSites } from "@/app/api/sites/route";
import { POST as postVerify } from "@/app/api/sites/[id]/verify/route";
import { db } from "@/lib/db";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSelectChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
  };
}

function makeInsertChain() {
  return {
    values: vi.fn().mockReturnValue({ onConflictDoNothing: vi.fn().mockResolvedValue([]) }),
  };
}

function makeUpdateChain() {
  return {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([]),
  };
}

function makeVerifyTx(creditBalance = TEAM.creditBalance) {
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
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ onConflictDoNothing: vi.fn().mockResolvedValue([]) }) }),
  };
}

function makeSitesRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/sites", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "1.2.3.4" },
    body: JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}

function makeVerifyRequest(id: string, code = "123456") {
  return new Request(`http://localhost/api/sites/${id}/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  }) as unknown as import("next/server").NextRequest;
}

function makeRouteContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

const PRO_MEMBER = { id: "m1", teamId: "team-1", email: "user@acme.com", userId: "user-1" };
const TEAM = { id: "team-1", creditBalance: 50 };

// Valid bulk body for a single domain
function makeBulkBody(urls: string[]) {
  return {
    bulkUrls: urls,
    email: "user@acme.com",
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ES-018: batchId on bulk insert (sites/route.ts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nanoidCounter = 0;

    // Default: pro member + team exist, no existing site
    let selectCount = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return makeSelectChain([PRO_MEMBER]); // teamMembers lookup
      if (selectCount === 2) return makeSelectChain([TEAM]);         // teams lookup
      return makeSelectChain([]);
    });
    const insertChain = makeInsertChain();
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(insertChain);
  });

  it("U-1: single-domain bulk insert includes batchId on the row", async () => {
    const capturedRows: Record<string, unknown>[][] = [];
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue({
      values: vi.fn().mockImplementation((rows: unknown) => {
        capturedRows.push(rows as Record<string, unknown>[]);
        return Promise.resolve([]);
      }),
    });

    const urls = ["https://acme.com/page1", "https://acme.com/page2"];
    const res = await postSites(makeSitesRequest(makeBulkBody(urls)));

    expect(res.status).toBe(201);
    expect(capturedRows.length).toBeGreaterThan(0);
    const rows = capturedRows[0];
    expect(rows[0]).toHaveProperty("batchId");
    expect(typeof rows[0].batchId).toBe("string");
    expect((rows[0].batchId as string).length).toBeGreaterThan(0);
  });

  it("U-2: multi-domain bulk: all rows share the same batchId", async () => {
    const capturedRows: Record<string, unknown>[][] = [];
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue({
      values: vi.fn().mockImplementation((rows: unknown) => {
        capturedRows.push(rows as Record<string, unknown>[]);
        return Promise.resolve([]);
      }),
    });

    const urls = [
      "https://domain-a.com/p1",
      "https://domain-b.com/p2",
      "https://domain-c.com/p3",
    ];
    const res = await postSites(makeSitesRequest(makeBulkBody(urls)));

    expect(res.status).toBe(201);
    const rows = capturedRows[0];
    expect(rows.length).toBe(3);
    const batchIds = rows.map((r) => r.batchId);
    // All rows share the same batchId
    expect(new Set(batchIds).size).toBe(1);
    expect(typeof batchIds[0]).toBe("string");
  });

  it("U-3: batchId on rows matches the generated nanoid value", async () => {
    const capturedRows: Record<string, unknown>[][] = [];
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue({
      values: vi.fn().mockImplementation((rows: unknown) => {
        capturedRows.push(rows as Record<string, unknown>[]);
        return Promise.resolve([]);
      }),
    });

    // nanoid counter starts at 0: first call = BATCH_ID, second = PRIMARY_SITE_ID
    const urls = ["https://acme.com/onlyone"];
    await postSites(makeSitesRequest(makeBulkBody(urls)));

    const rows = capturedRows[0];
    // batchId was assigned from first nanoid() call
    expect(rows[0].batchId).toBe(BATCH_ID);
    // primarySiteId was assigned from second nanoid() call
    expect(rows[0].id).toBe(PRIMARY_SITE_ID);
  });

  it("U-4: single-audit insert does NOT include batchId field", async () => {
    // Pro gate removed (TS-033) — all selects return [] (no existing site, no cached domain)
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => makeSelectChain([]));

    const capturedRows: Record<string, unknown>[][] = [];
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue({
      values: vi.fn().mockImplementation((rows: unknown) => {
        const r = Array.isArray(rows) ? rows : [rows];
        capturedRows.push(r as Record<string, unknown>[]);
        return Promise.resolve([]);
      }),
    });

    const res = await postSites(
      makeSitesRequest({ url: "https://acme.com", email: "user@acme.com" })
    );

    expect([200, 201]).toContain(res.status);
    // At least one insert should have happened
    expect(capturedRows.length).toBeGreaterThan(0);
    const lastInsert = capturedRows[capturedRows.length - 1];
    // Single-audit rows should NOT have batchId
    expect(lastInsert[0]).not.toHaveProperty("batchId");
  });

  it("U-5: single-audit email rate limit path is not affected by batchId change", async () => {
    // Pro gate removed (TS-033) — all selects return [] (no existing site, no cached domain)
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => makeSelectChain([]));
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(makeInsertChain());

    const res = await postSites(
      makeSitesRequest({ url: "https://acme.com", email: "user@acme.com" })
    );

    // Should succeed without errors related to batchId
    expect([200, 201]).toContain(res.status);
  });
});

describe("ES-018: batchId sibling query (verify/route.ts)", () => {
  const BATCH_ID_VAL = "stable-batch-id-xyz";
  const SITE_ID = "site-primary-1";

  function makeBulkSite(overrides: Record<string, unknown> = {}) {
    return {
      id: SITE_ID,
      domain: "acme.com",
      auditMode: "bulk",
      bulkUrls: ["https://acme.com/p1"],
      teamId: "team-1",
      emailVerified: false,
      pipelineStatus: "pending",
      geoScorecard: null,
      accessToken: null,
      verificationCode: "hashed-otp",
      codeExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
      batchId: BATCH_ID_VAL,
      otpAttempts: 0,
      otpLockedUntil: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    nanoidCounter = 0;
  });

  it("U-6: site.batchId set → sibling query uses eq(geoSites.batchId, batchId)", async () => {
    const sibling = { id: "site-sibling-1", domain: "acme.com", bulkUrls: ["https://acme.com/p2"], batchId: BATCH_ID_VAL };
    let selectCount = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return makeSelectChain([makeBulkSite()]);         // primary site
      if (selectCount === 2) return makeSelectChain([TEAM]);                   // team
      return makeSelectChain([makeBulkSite(), sibling]);                       // batchSites
    });
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue(makeUpdateChain());
    (db.transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: (tx: unknown) => Promise<void>) => {
        const tx = makeVerifyTx();
        await fn(tx);
      }
    );

    const res = await postVerify(makeVerifyRequest(SITE_ID), makeRouteContext(SITE_ID));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    // Third select call was the batchSites query — triggered because batchId is set
    expect(selectCount).toBeGreaterThanOrEqual(3);
  });

  it("U-7: site.batchId=null → fallback to [site], no extra DB query for siblings", async () => {
    const siteNoBatch = makeBulkSite({ batchId: null });
    let selectCount = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return makeSelectChain([siteNoBatch]); // primary site
      if (selectCount === 2) return makeSelectChain([TEAM]);         // team
      return makeSelectChain([]);                                    // should not be called
    });
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue(makeUpdateChain());
    (db.transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: (tx: unknown) => Promise<void>) => {
        const tx = makeVerifyTx();
        await fn(tx);
      }
    );

    const res = await postVerify(makeVerifyRequest(SITE_ID), makeRouteContext(SITE_ID));

    expect(res.status).toBe(200);
    // Only 2 selects: primary site + team. No 3rd select for siblings (null batchId → fallback).
    expect(selectCount).toBe(2);
  });

  it("U-8: old bulk site (batchId=null, auditMode=bulk) → fallback [site], credits for 1", async () => {
    const oldSite = makeBulkSite({ batchId: null });
    let selectCount = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return makeSelectChain([oldSite]);
      if (selectCount === 2) return makeSelectChain([TEAM]);
      return makeSelectChain([]);
    });
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue(makeUpdateChain());
    (db.transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: (tx: unknown) => Promise<void>) => {
        const tx = makeVerifyTx();
        await fn(tx);
      }
    );

    const res = await postVerify(makeVerifyRequest(SITE_ID), makeRouteContext(SITE_ID));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    // Should NOT have siblings in response (only 1 site in batch)
    expect(body.siblings).toBeUndefined();
  });

  it("U-9: batchId query returns all siblings including self → all get enqueued", async () => {
    const s2 = { id: "site-2", domain: "beta.com", bulkUrls: ["https://beta.com/p1"], batchId: BATCH_ID_VAL };
    const s3 = { id: "site-3", domain: "gamma.com", bulkUrls: ["https://gamma.com/p1"], batchId: BATCH_ID_VAL };

    let selectCount = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return makeSelectChain([makeBulkSite()]);         // primary
      if (selectCount === 2) return makeSelectChain([TEAM]);                   // team
      return makeSelectChain([makeBulkSite(), s2, s3]);                        // all 3 siblings
    });
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue(makeUpdateChain());

    const { enqueueStage } = await import("@/lib/qstash");
    const enqueueMock = vi.mocked(enqueueStage);
    enqueueMock.mockResolvedValue(undefined);

    (db.transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: (tx: unknown) => Promise<void>) => {
        const tx = makeVerifyTx();
        await fn(tx);
      }
    );

    const res = await postVerify(makeVerifyRequest(SITE_ID), makeRouteContext(SITE_ID));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    // All 3 sites should have been enqueued
    expect(enqueueMock).toHaveBeenCalledTimes(3);
    // Response should include 2 siblings
    expect(body.siblings).toHaveLength(2);
  });
});
