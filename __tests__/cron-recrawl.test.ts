/**
 * Tests for GET /api/cron/recrawl (GEO-007 + FIX-023).
 *
 * The scheduled-recrawl cron was built but never fired (no vercel.json entry,
 * disabled 2026-02-24 in 9c6f8d3). FIX-023 made it durable + tier-correct:
 *   - auth enforcement (503 / 401 / 200) via assertCronAuth
 *   - only active-subscription, due sites are processed; inactive/unknown-tier
 *     rows are skipped
 *   - the budget reservation (page/credit debit + ledger + status flip) is
 *     atomic via db.transaction; the kickoff is a synchronous, durable
 *     enqueueStage({stage:"discover"}) — NOT after(() => startCrawl(...)),
 *     which never ran on Vercel
 *   - the page budget is derived from the tier per-audit cap via the shared
 *     resolveFirstAuditMaxPages (Pro/Growth no longer capped at 100)
 *   - the per-tier frequency ceiling is enforced: a daily site on a weekly tier
 *     recrawls weekly; a non-manual site on a manual-only tier is parked; an
 *     out-of-union crawlFrequency is parked + skipped
 *   - a subscription-funded recrawl writes NO ledger row (creditsToReserve = 0)
 *   - a credit-funded recrawl (no subscription headroom) writes a
 *     `recrawl_reserve` ledger row with correct balanceBefore/After
 *   - a budget-denied recrawl is skipped, pushed forward, surfaced to the user
 *     via sendLowCreditsEmail, and starts no crawl
 *   - a kickoff (enqueue) failure reverses the reservation + marks the site failed
 *   - DB throw → 500
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockEnqueueStage, mockSendLowCreditsEmail } = vi.hoisted(() => ({
  mockEnqueueStage: vi.fn().mockResolvedValue(undefined),
  mockSendLowCreditsEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock("@/lib/qstash", () => ({
  enqueueStage: mockEnqueueStage,
}));

vi.mock("@/lib/email", () => ({
  sendLowCreditsEmail: mockSendLowCreditsEmail,
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn(),
  lt: vi.fn(),
  ne: vi.fn(),
  sql: vi.fn(),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { db } from "@/lib/db";
import { GET } from "@/app/api/cron/recrawl/route";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BASE_URL = "https://test.com/api/cron/recrawl";
// C3: lib/cron-auth.ts requires ≥32 chars.
const TEST_SECRET = "test-cron-secret-xyz-padded-to-32+chars-aaaaaaaa";

function makeRequest(secret?: string): NextRequest {
  return new NextRequest(BASE_URL, {
    method: "GET",
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

type SiteRow = {
  siteId: string;
  domain: string;
  ownerEmail: string;
  crawlFrequency: string;
  teamId: string | null;
  subscriptionTier: string;
  subscriptionStatus: string;
  monthlyPageAllowance: number;
  monthlyPagesUsed: number;
  creditBalance: number;
};

function makeRow(overrides: Partial<SiteRow> = {}): SiteRow {
  return {
    siteId: "site-1",
    domain: "example.com",
    ownerEmail: "owner@example.com",
    crawlFrequency: "daily",
    teamId: "team-1",
    subscriptionTier: "growth",
    subscriptionStatus: "active",
    monthlyPageAllowance: 5000,
    monthlyPagesUsed: 0,
    creditBalance: 0,
    ...overrides,
  };
}

// Captured DB side-effects for assertions. Both direct db.* writes and writes
// made inside db.transaction(tx => ...) funnel into these same captures.
let setPayloads: Record<string, unknown>[];
let insertValues: ReturnType<typeof vi.fn>;
let deleteCalls: unknown[];
// When set, the reservation transaction throws to simulate a mid-debit failure.
let failTransaction: boolean;

function makeSelectChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
}

function makeUpdate() {
  return {
    set: vi.fn((payload: Record<string, unknown>) => {
      setPayloads.push(payload);
      return { where: vi.fn().mockResolvedValue(undefined) };
    }),
  };
}

function makeDelete() {
  return {
    where: vi.fn((arg: unknown) => {
      deleteCalls.push(arg);
      return Promise.resolve(undefined);
    }),
  };
}

function setupDb(rows: SiteRow[]) {
  (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => makeSelectChain(rows));

  (db.update as ReturnType<typeof vi.fn>).mockImplementation(() => makeUpdate());

  insertValues = vi.fn().mockResolvedValue(undefined);
  (db.insert as ReturnType<typeof vi.fn>).mockImplementation(() => ({ values: insertValues }));

  (db.delete as ReturnType<typeof vi.fn>).mockImplementation(() => makeDelete());

  // Passthrough transaction: run the callback against a tx that funnels writes
  // into the same captures as direct db.* calls.
  (db.transaction as ReturnType<typeof vi.fn>).mockImplementation(
    async (cb: (tx: unknown) => Promise<void>) => {
      if (failTransaction) throw new Error("tx write failed");
      const tx = {
        update: () => makeUpdate(),
        insert: () => ({ values: insertValues }),
        delete: () => makeDelete(),
      };
      return cb(tx);
    },
  );
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("GET /api/cron/recrawl (GEO-007 + FIX-023)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnqueueStage.mockReset();
    mockEnqueueStage.mockResolvedValue(undefined);
    mockSendLowCreditsEmail.mockReset();
    mockSendLowCreditsEmail.mockResolvedValue(undefined);
    setPayloads = [];
    deleteCalls = [];
    failTransaction = false;
    process.env.CRON_SECRET = TEST_SECRET;
    setupDb([]);
  });

  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  // ── Auth ──────────────────────────────────────────────────────────────────

  it("missing CRON_SECRET env → 503", async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(makeRequest(TEST_SECRET));
    expect(res.status).toBe(503);
  });

  it("no Authorization header → 401", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it("wrong secret → 401", async () => {
    const res = await GET(makeRequest("definitely-wrong-secret-also-32+chars-xx"));
    expect(res.status).toBe(401);
  });

  it("valid secret, no sites due → processed 0", async () => {
    const res = await GET(makeRequest(TEST_SECRET));
    expect(res.status).toBe(200);
    const body = await res.json() as { processed: number };
    expect(body.processed).toBe(0);
  });

  // ── Eligibility filtering ───────────────────────────────────────────────────

  it("inactive subscription → skipped, not processed, no crawl started", async () => {
    setupDb([makeRow({ subscriptionStatus: "canceled" })]);
    const res = await GET(makeRequest(TEST_SECRET));
    const body = await res.json() as { processed: number; skipped: number };
    expect(body.processed).toBe(0);
    expect(body.skipped).toBe(1);
    expect(mockEnqueueStage).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("unknown tier → skipped", async () => {
    setupDb([makeRow({ subscriptionTier: "enterprise-typo" })]);
    const res = await GET(makeRequest(TEST_SECRET));
    const body = await res.json() as { processed: number; skipped: number };
    expect(body.processed).toBe(0);
    expect(body.skipped).toBe(1);
    expect(mockEnqueueStage).not.toHaveBeenCalled();
  });

  it("unknown crawlFrequency (out of union) → parked + skipped, no crawl", async () => {
    setupDb([makeRow({ crawlFrequency: "hourly" })]);
    const res = await GET(makeRequest(TEST_SECRET));
    const body = await res.json() as { processed: number; skipped: number };
    expect(body.processed).toBe(0);
    expect(body.skipped).toBe(1);
    expect(mockEnqueueStage).not.toHaveBeenCalled();
    // parked, never flipped to discovery.
    expect(setPayloads.some((p) => p.pipelineStatus === "discovery")).toBe(false);
    expect(setPayloads.some((p) => p.nextCrawlAt instanceof Date)).toBe(true);
  });

  // ── Durable, tier-correct kickoff ──────────────────────────────────────────

  it("active sub with subscription headroom → enqueues discover at the tier per-audit cap, NO ledger row", async () => {
    // growth: maxAuditPages 500; allowance 5000, used 0 → maxPages = min(5000, 500) = 500.
    setupDb([makeRow({ monthlyPageAllowance: 5000, monthlyPagesUsed: 0, creditBalance: 0 })]);
    const res = await GET(makeRequest(TEST_SECRET));
    const body = await res.json() as { processed: number };

    expect(body.processed).toBe(1);
    // Durable kickoff via enqueueStage (NOT after()/startCrawl); budget from tier, not 100.
    expect(mockEnqueueStage).toHaveBeenCalledWith({
      siteId: "site-1",
      domain: "example.com",
      stage: "discover",
      maxPages: 500,
    });
    // creditsToReserve = 0 → no ledger row written.
    expect(insertValues).not.toHaveBeenCalled();
    // site advanced to discovery with a future nextCrawlAt.
    const discovery = setPayloads.find((p) => p.pipelineStatus === "discovery");
    expect(discovery).toBeDefined();
    expect(discovery!.nextCrawlAt).toBeInstanceOf(Date);
  });

  it("Pro tier recrawl is NOT capped at 100 (uncapped per-audit, bounded by allowance)", async () => {
    // pro: maxAuditPages null (uncapped); allowance 10000, used 0 → maxPages = 10000.
    setupDb([makeRow({ subscriptionTier: "pro", monthlyPageAllowance: 10000, monthlyPagesUsed: 0 })]);
    const res = await GET(makeRequest(TEST_SECRET));
    const body = await res.json() as { processed: number };

    expect(body.processed).toBe(1);
    expect(mockEnqueueStage).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "discover", maxPages: 10000 }),
    );
  });

  it("advances nextCrawlAt by frequency — daily ≈ +1 day, weekly ≈ +7 days", async () => {
    // daily on growth (maxFrequency daily) → daily cadence preserved.
    setupDb([makeRow({ crawlFrequency: "daily" })]);
    const before = Date.now();
    await GET(makeRequest(TEST_SECRET));
    const daily = setPayloads.find((p) => p.pipelineStatus === "discovery")!.nextCrawlAt as Date;
    const dailyDeltaH = (daily.getTime() - before) / 3_600_000;
    expect(dailyDeltaH).toBeGreaterThan(23);
    expect(dailyDeltaH).toBeLessThan(25);

    // weekly
    setPayloads = [];
    setupDb([makeRow({ crawlFrequency: "weekly" })]);
    const before2 = Date.now();
    await GET(makeRequest(TEST_SECRET));
    const weekly = setPayloads.find((p) => p.pipelineStatus === "discovery")!.nextCrawlAt as Date;
    const weeklyDeltaD = (weekly.getTime() - before2) / 86_400_000;
    expect(weeklyDeltaD).toBeGreaterThan(6.9);
    expect(weeklyDeltaD).toBeLessThan(7.1);
  });

  // ── Per-tier frequency ceiling ─────────────────────────────────────────────

  it("daily site on a weekly-max tier is clamped to weekly cadence", async () => {
    // starter: maxFrequency weekly, maxAuditPages 100; site asks for daily.
    setupDb([makeRow({
      subscriptionTier: "starter",
      monthlyPageAllowance: 1000,
      monthlyPagesUsed: 0,
      crawlFrequency: "daily",
    })]);
    const before = Date.now();
    const res = await GET(makeRequest(TEST_SECRET));
    const body = await res.json() as { processed: number };

    expect(body.processed).toBe(1);
    // budget clamped to starter per-audit cap (100).
    expect(mockEnqueueStage).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "discover", maxPages: 100 }),
    );
    // nextCrawlAt advanced by the clamped (weekly) cadence, not daily.
    const next = setPayloads.find((p) => p.pipelineStatus === "discovery")!.nextCrawlAt as Date;
    const deltaD = (next.getTime() - before) / 86_400_000;
    expect(deltaD).toBeGreaterThan(6.9);
    expect(deltaD).toBeLessThan(7.1);
  });

  it("non-manual site on a manual-only tier is parked (skipped, no crawl, pushed far forward)", async () => {
    // free: maxFrequency manual → effective frequency clamps to manual → parked.
    setupDb([makeRow({
      subscriptionTier: "free",
      subscriptionStatus: "active",
      monthlyPageAllowance: 20,
      crawlFrequency: "daily",
    })]);
    const before = Date.now();
    const res = await GET(makeRequest(TEST_SECRET));
    const body = await res.json() as { processed: number; skipped: number };

    expect(body.processed).toBe(0);
    expect(body.skipped).toBe(1);
    expect(mockEnqueueStage).not.toHaveBeenCalled();
    // parked far in the future, never flipped to discovery.
    expect(setPayloads.some((p) => p.pipelineStatus === "discovery")).toBe(false);
    const parked = setPayloads.find((p) => p.nextCrawlAt instanceof Date)!.nextCrawlAt as Date;
    const deltaYears = (parked.getTime() - before) / (365 * 86_400_000);
    expect(deltaYears).toBeGreaterThan(50);
  });

  // ── Credit-funded recrawl → ledgered ───────────────────────────────────────

  it("no subscription headroom + credits → credit-funded, recrawl_reserve ledger row written", async () => {
    // allowance 5000 fully used (remaining 0) → resolver draws from credits:
    // creditBalance 10 → fromCredits = min(100, PAID_MAX_PAGES 100) = 100 pages,
    // creditsToReserve = ceil(100/10) = 10.
    setupDb([makeRow({ monthlyPageAllowance: 5000, monthlyPagesUsed: 5000, creditBalance: 10 })]);
    const res = await GET(makeRequest(TEST_SECRET));
    const body = await res.json() as { processed: number };

    expect(body.processed).toBe(1);
    expect(mockEnqueueStage).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "discover", maxPages: 100 }),
    );

    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: "team-1",
        siteId: "site-1",
        type: "recrawl_reserve",
        pagesConsumed: 100,     // credit-funded portion (all of it)
        creditsChanged: -10,    // creditsToReserve
        balanceBefore: 10,
        balanceAfter: 0,
      }),
    );
    expect(insertValues.mock.calls[0][0].id).toBeTruthy(); // nanoid present
    // kickoff succeeded → ledger row is NOT reversed.
    expect(deleteCalls.length).toBe(0);
  });

  // ── Budget-denied → surfaced ───────────────────────────────────────────────

  it("no subscription headroom + zero credits → denied, pushed forward, surfaced via email, no crawl", async () => {
    setupDb([makeRow({ monthlyPageAllowance: 5000, monthlyPagesUsed: 5000, creditBalance: 0 })]);
    const res = await GET(makeRequest(TEST_SECRET));
    const body = await res.json() as { processed: number; skipped: number };

    expect(body.processed).toBe(0);
    expect(body.skipped).toBe(1);
    expect(mockEnqueueStage).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
    // surfaced to the user rather than only logged.
    expect(mockSendLowCreditsEmail).toHaveBeenCalledWith(
      "owner@example.com",
      expect.objectContaining({ creditsRemaining: 0 }),
    );
    // denied branch pushes nextCrawlAt forward but does NOT flip to discovery.
    expect(setPayloads.some((p) => p.pipelineStatus === "discovery")).toBe(false);
    const pushed = setPayloads.find((p) => p.nextCrawlAt instanceof Date);
    expect(pushed).toBeDefined();
  });

  // ── Reservation atomicity ──────────────────────────────────────────────────

  it("reservation transaction throws → nothing committed, errors counted, no crawl", async () => {
    setupDb([makeRow({ monthlyPageAllowance: 5000, monthlyPagesUsed: 0, creditBalance: 0 })]);
    failTransaction = true;

    const res = await GET(makeRequest(TEST_SECRET));
    const body = await res.json() as { processed: number; errors: number };

    expect(body.processed).toBe(0);
    expect(body.errors).toBe(1);
    // tx rolled back by the DB → no crawl enqueued, no captured writes from the tx.
    expect(mockEnqueueStage).not.toHaveBeenCalled();
    expect(setPayloads.some((p) => p.pipelineStatus === "discovery")).toBe(false);
  });

  // ── Kickoff failure → reservation reversed ─────────────────────────────────

  it("enqueue failure → reservation reversed, site marked failed, errors counted", async () => {
    setupDb([makeRow({ monthlyPageAllowance: 5000, monthlyPagesUsed: 0, creditBalance: 0 })]);
    mockEnqueueStage.mockRejectedValueOnce(new Error("QStash down"));

    const res = await GET(makeRequest(TEST_SECRET));
    const body = await res.json() as { processed: number; errors: number };

    expect(body.processed).toBe(0);
    expect(body.errors).toBe(1);
    // compensating transaction flips the site to failed with a surfaced error.
    const failed = setPayloads.find((p) => p.pipelineStatus === "failed");
    expect(failed).toBeDefined();
    expect(typeof failed!.pipelineError).toBe("string");
  });

  // ── Error handling ─────────────────────────────────────────────────────────

  it("DB query throws → 500", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("Connection refused");
    });
    const res = await GET(makeRequest(TEST_SECRET));
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Internal server error");
  });
});
