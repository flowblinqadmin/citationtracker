/**
 * Tests for POST /api/sites/[id]/verify — bulk branch — ES-005 Task 5
 *
 * 9 test cases covering:
 *   - Valid bulk verify → 200, accessToken returned
 *   - Atomic credit reservation transaction executed
 *   - startBulkCrawl called with sliced URLs up to crawlLimit
 *   - 402 when team has 0 credits at verify time
 *   - Single-audit path: startCrawl called (not startBulkCrawl)
 *   - Single-audit: maxPages derived from creditBalance × PAGES_PER_CREDIT
 *   - Single-audit: maxPages capped at PAID_MAX_PAGES (resolveFirstAuditMaxPages) for high credit balances
 *   - Invalid code format → 400
 *   - Site not found → 404
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock("@/lib/email", () => ({
  verifyCode: vi.fn().mockReturnValue(true),
}));

vi.mock("nanoid", () => ({ nanoid: vi.fn().mockReturnValue("new-access-token-xyz") }));

vi.mock("@/lib/rate-limit", () => ({
  // HP-239 split primitives.
  checkOtpLock: vi.fn().mockResolvedValue({ allowed: true }),
  incrementOtpAttempt: vi.fn().mockResolvedValue({ lockedOut: false, otpAttempts: 1 }),
  checkAndIncrementOtpAttempt: vi.fn().mockResolvedValue({ allowed: true, attemptsLeft: 4 }),
  clearOtpAttempts: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/qstash", () => ({
  enqueueStage: vi.fn().mockResolvedValue(undefined),
}));

// Supabase admin is opt-in inside the verify route — when it returns null,
// the admin path (createUser + generateLink) is skipped. Without this mock
// the route hits a real fetch to NEXT_PUBLIC_SUPABASE_URL and the per-test
// timeout fires before the assertion can run. Added 2026-05-16 during the
// merge from main, where the admin code path was exercised more aggressively
// under the post-merge full-suite worker assignment.
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: () => null,
}));

vi.mock("@/lib/services/provision-team", () => ({
  ensureTeamForUser: vi.fn().mockResolvedValue({ teamId: "team-acme-1", userId: "user-1" }),
}));

vi.mock("@/lib/services/exchange-code", () => ({
  generateExchangeCode: vi.fn().mockResolvedValue("exchange-code-mock"),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import { POST } from "@/app/api/sites/[id]/verify/route";
import { db } from "@/lib/db";
import { enqueueStage } from "@/lib/qstash";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSelectChain(rows: unknown[] = []) {
  return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue(rows) };
}

function makeUpdateChain() {
  // .where() is awaitable ([] for callers that don't read rows-affected) AND
  // exposes .returning() (FIX-014 rows-affected guard) resolving to one row so
  // the guarded credit reserve treats the deduction as applied.
  const whereResult = Object.assign(Promise.resolve([]), {
    returning: vi.fn().mockResolvedValue([{ id: "team-1" }]),
  });
  return {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnValue(whereResult),
  };
}

function makeRequest(siteId: string, code = "123456"): import("next/server").NextRequest {
  return new Request(`http://localhost/api/sites/${siteId}/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  }) as unknown as import("next/server").NextRequest;
}

function makeRouteContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

const SITE_ID = "site-bulk-abc";
const BULK_URLS = Array.from({ length: 7 }, (_, i) => `https://acme.io/page${i}`);

function makeBulkSite(overrides: Record<string, unknown> = {}) {
  return {
    id: SITE_ID,
    domain: "acme.io",
    auditMode: "bulk",
    bulkUrls: BULK_URLS,
    teamId: "team-acme-1",
    emailVerified: false,
    pipelineStatus: "pending",
    geoScorecard: null,
    accessToken: null,
    verificationCode: "hashed-code",
    codeExpiresAt: new Date(Date.now() + 10 * 60 * 1000), // valid
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("POST /api/sites/[id]/verify — bulk branch", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    let selectCount = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return makeSelectChain([makeBulkSite()]); // primary site
      if (selectCount === 2) return makeSelectChain([{ id: "team-acme-1", creditBalance: 20 }]); // team
      return makeSelectChain([makeBulkSite()]); // batch sites (3rd call — same domain = 1 site)
    });
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue(makeUpdateChain());
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue({ values: vi.fn().mockReturnValue({ onConflictDoNothing: vi.fn().mockResolvedValue(undefined) }) });
    (db.transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: (tx: unknown) => Promise<void>) => {
        const teamData = [{ creditBalance: 20 }];
        const whereResult = Object.assign(Promise.resolve(teamData), {
          for: vi.fn().mockResolvedValue(teamData),
        });
        const tx = {
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnValue(whereResult),
          }),
          update: vi.fn().mockReturnValue(makeUpdateChain()),
          insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue([]) }),
        };
        await fn(tx);
      }
    );
  });

  it("returns 200 with accessToken on valid bulk OTP", async () => {
    const res = await POST(makeRequest(SITE_ID), makeRouteContext(SITE_ID));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.accessToken).toBeDefined();
    expect(body.siteId).toBe(SITE_ID);
  });

  it("executes the credit reservation transaction", async () => {
    await POST(makeRequest(SITE_ID), makeRouteContext(SITE_ID));
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it("deducts exactly bulkCreditsRequired(crawlLimit) from team creditBalance and writes a ledger entry", async () => {
    const capturedSets: Record<string, unknown>[] = [];
    const capturedInserts: Record<string, unknown>[] = [];

    (db.transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: (tx: unknown) => Promise<void>) => {
        const makeChain = () => {
          const chain: Record<string, ReturnType<typeof vi.fn>> = {} as never;
          chain.set = vi.fn().mockImplementation((d: Record<string, unknown>) => {
            capturedSets.push(d);
            return chain;
          });
          chain.where = vi.fn().mockResolvedValue([]);
          return chain;
        };
        const teamData = [{ creditBalance: 20 }];
        const whereResult = Object.assign(Promise.resolve(teamData), {
          for: vi.fn().mockResolvedValue(teamData),
        });
        const tx = {
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnValue(whereResult),
          }),
          update: vi.fn().mockImplementation(() => makeChain()),
          insert: vi.fn().mockImplementation(() => ({
            values: vi.fn().mockImplementation((d: Record<string, unknown>) => {
              capturedInserts.push(d);
              return Promise.resolve([]);
            }),
          })),
        };
        await fn(tx);
      }
    );

    // Team creditBalance=20, BULK_URLS.length=7
    // crawlLimit = min(7, 20*10, 500) = 7
    // reservedCredits = ceil(7/10) = 1
    await POST(makeRequest(SITE_ID), makeRouteContext(SITE_ID));

    // teams table: creditBalance updated via SQL expression (race-safe subtraction)
    const teamUpdate = capturedSets.find((s) => "creditBalance" in s);
    expect(teamUpdate).toBeDefined();
    // creditBalance is a SQL expression (sql`${teams.creditBalance} - 1`) — numeric result verified via ledger

    // credit ledger: negative creditsChanged, correct balanceAfter
    const ledger = capturedInserts.find((a) => a.type === "bulk_crawl_reserve");
    expect(ledger).toBeDefined();
    expect(ledger!.creditsChanged).toBe(-1);
    expect(ledger!.balanceBefore).toBe(20);
    expect(ledger!.balanceAfter).toBe(19);

    // sites table: creditsReserved set to 1
    const siteUpdate = capturedSets.find((s) => "creditsReserved" in s);
    expect(siteUpdate).toBeDefined();
    expect(siteUpdate!.creditsReserved).toBe(1);
  });

  it("enqueues stage='crawl-fanout' (not startCrawl) for bulk sites", async () => {
    await POST(makeRequest(SITE_ID), makeRouteContext(SITE_ID));

    expect(vi.mocked(enqueueStage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueStage)).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: SITE_ID, domain: "acme.io", stage: "crawl-fanout" })
    );
  });

  it("enqueues without passing URLs (crawler reads from DB)", async () => {
    await POST(makeRequest(SITE_ID), makeRouteContext(SITE_ID));

    const [payload] = vi.mocked(enqueueStage).mock.calls[0];
    expect(payload).not.toHaveProperty("urls");
    expect(payload.stage).toBe("crawl-fanout");
  });

  /**
   * REGRESSION: The outer db.update was clearing verificationCode before the
   * batch-sites query could use it to find sibling domains, causing the batch
   * to return 0 rows and the verify to 402.
   * Fix: bulk audits skip the outer update entirely — the transaction handles
   * emailVerified, verificationCode, accessToken, and pipelineStatus for all sites.
   */
  it("does NOT call the outer db.update for bulk audits (transaction handles all fields)", async () => {
    const outerUpdateSets: Record<string, unknown>[] = [];
    (db.update as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      set: vi.fn().mockImplementation((data: Record<string, unknown>) => {
        outerUpdateSets.push(data);
        return { where: vi.fn().mockResolvedValue([]) };
      }),
    }));

    await POST(makeRequest(SITE_ID), makeRouteContext(SITE_ID));

    // No outer (non-transactional) update should fire for bulk audits.
    // The transaction in the bulk branch sets emailVerified, verificationCode=null,
    // accessToken, crawlLimit, creditsReserved, and pipelineStatus='crawling'.
    expect(outerUpdateSets.length).toBe(0);
  });

  it("returns 200 with free floor crawlLimit when team has 0 credits (BULK_FREE_PAGES floor)", async () => {
    // With 0 credits, effectiveCrawlLimit returns min(urlCount, BULK_FREE_PAGES) = min(7, 10) = 7
    // Credits charged = min(ceil(7/5), max(0, 0)) = min(2, 0) = 0 — free floor, no deduction
    let selectCount = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return makeSelectChain([makeBulkSite()]); // primary site
      if (selectCount === 2) return makeSelectChain([{ id: "team-acme-1", creditBalance: 0 }]); // team (0 credits)
      return makeSelectChain([makeBulkSite()]); // batch sites
    });

    const res = await POST(makeRequest(SITE_ID), makeRouteContext(SITE_ID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("returns 400 for invalid code format (wrong length)", async () => {
    const res = await POST(makeRequest(SITE_ID, "12345"), makeRouteContext(SITE_ID)); // 5 digits
    expect(res.status).toBe(400);
  });

  it("returns 404 when site is not found", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(makeSelectChain([]));
    const res = await POST(makeRequest("nonexistent"), makeRouteContext("nonexistent"));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/sites/[id]/verify — single audit branch (maxPages via credits)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue(makeUpdateChain());
  });

  it("enqueues stage='discover' with credit-derived maxPages for single audit", async () => {
    const singleSite = {
      id: SITE_ID,
      domain: "acme.io",
      auditMode: "single",
      teamId: "team-1",
      emailVerified: false,
      pipelineStatus: "pending",
      geoScorecard: null,
      accessToken: null,
      verificationCode: "hashed",
      codeExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    };

    let selectCount = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return makeSelectChain([singleSite]);
      // Team with 3 credits → 3 * 10 = 30 maxPages
      return makeSelectChain([{ id: "team-1", creditBalance: 3 }]);
    });

    await POST(makeRequest(SITE_ID), makeRouteContext(SITE_ID));

    expect(vi.mocked(enqueueStage)).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: SITE_ID, domain: "acme.io", stage: "discover", maxPages: 30 })
    );
  });

  it("caps maxPages at PAID_MAX_PAGES (100) for very high credit balances", async () => {
    // FIX-013: the single-audit branch now routes through
    // resolveFirstAuditMaxPages, which caps a credit-only (no active
    // subscription) first audit at PAID_MAX_PAGES (100) — the same cap the
    // /api/sites Pro fast-path and regenerate use. Previously the verify
    // route alone capped at ABSOLUTE_MAX_PAGES (500), a 5x divergence for the
    // identical team state.
    const singleSite = {
      id: SITE_ID,
      domain: "acme.io",
      auditMode: "single",
      teamId: "team-1",
      emailVerified: false,
      pipelineStatus: "pending",
      geoScorecard: null,
      accessToken: null,
      verificationCode: "hashed",
      codeExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    };

    let selectCount = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return makeSelectChain([singleSite]);
      // 500 credits → 5000 pages, capped at PAID_MAX_PAGES (100) for a
      // credit-only team with no active subscription.
      return makeSelectChain([{ id: "team-1", creditBalance: 500 }]);
    });

    await POST(makeRequest(SITE_ID), makeRouteContext(SITE_ID));

    const [payload] = vi.mocked(enqueueStage).mock.calls[0];
    expect(payload.maxPages).toBe(100); // PAID_MAX_PAGES (resolveFirstAuditMaxPages cap)
  });

  it("FIX-014: returns 402 + writes no ledger row when the guarded reserve loses a concurrent-debit race", async () => {
    const singleSite = {
      id: SITE_ID,
      domain: "acme.io",
      auditMode: "single",
      teamId: "team-1",
      emailVerified: false,
      pipelineStatus: "pending",
      geoScorecard: null,
      accessToken: null,
      verificationCode: "hashed",
      codeExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    };

    let selectCount = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return makeSelectChain([singleSite]);
      // Snapshot shows 3 credits → resolver wants to reserve, but the guarded
      // UPDATE below matches 0 rows (a concurrent debit drained the balance).
      return makeSelectChain([{ id: "team-1", creditBalance: 3 }]);
    });

    const insertValues = vi.fn().mockResolvedValue([]);
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue({ values: insertValues });

    // Every UPDATE's .returning() reports 0 rows affected.
    (db.update as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const whereResult = Object.assign(Promise.resolve([]), {
        returning: vi.fn().mockResolvedValue([]),
      });
      return { set: vi.fn().mockReturnThis(), where: vi.fn().mockReturnValue(whereResult) };
    });

    const res = await POST(makeRequest(SITE_ID), makeRouteContext(SITE_ID));

    expect(res.status).toBe(402);
    // Pipeline must NOT start and no single_crawl_reserve ledger row is written.
    expect(vi.mocked(enqueueStage)).not.toHaveBeenCalled();
    const reserveLedger = insertValues.mock.calls.find(
      ([v]) => (v as { type?: string })?.type === "single_crawl_reserve",
    );
    expect(reserveLedger).toBeUndefined();
  });
});
