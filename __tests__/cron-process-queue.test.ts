/**
 * Non-happy-path tests for GET /api/cron/process-queue
 *
 * The existing api-routes.test.ts covers:
 *   - auth enforcement (401/503)
 *   - basic enqueueStage call for crawling/researching/processing/analyzing/generating
 *   - DB throw → 500
 *   - empty queue → checked=0
 *
 * This file covers the remaining edge cases for the in-progress restart branch
 * AND the pending-restart branch:
 *   - every status→stage mapping not already tested
 *   - partial enqueueStage failures (one fails, rest succeed)
 *   - all enqueueStage calls fail
 *   - checked count accuracy with N sites
 *   - sites with different statuses in the same batch
 *   - unknown pipelineStatus slipping through → skipped via !stage guard
 *   - pending sites: eligible row → restarted, status flipped, discover enqueued
 *   - pending sites: CAS-loser (UPDATE returns []) → silently skipped
 *   - pending sites: enqueueStage throws after status flip → errors++
 *   - pending sites: maxPages from crawlLimit, from team credits, fallback to FREE_MAX_PAGES
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockEnqueueStage } = vi.hoisted(() => ({
  mockEnqueueStage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    selectDistinct: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("@/lib/qstash", () => ({
  enqueueStage: mockEnqueueStage,
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => args),
  asc: vi.fn(),
  eq: vi.fn(),
  inArray: vi.fn(),
  isNotNull: vi.fn(),
  lt: vi.fn(),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { db } from "@/lib/db";
import { GET } from "@/app/api/cron/process-queue/route";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BASE_URL = "https://test.com/api/cron/process-queue";
// C3: lib/cron-auth.ts requires ≥32 chars.
const TEST_SECRET = "test-cron-secret-xyz-padded-to-32+chars-aaaaaaaa";

function makeRequest(secret?: string): NextRequest {
  return new NextRequest(BASE_URL, {
    method: "GET",
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

function makeSelectChain(rows: unknown[] = []) {
  const chain: any = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  return chain;
}

// Per-call team SELECT chain (no .limit — the route awaits the .where(...) directly).
function makeTeamSelectChain(rows: unknown[]) {
  const chain: any = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
  };
  return chain;
}

function makeUpdateChain(returningRows: unknown[]) {
  const chain: any = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(returningRows),
  };
  return chain;
}

type SiteRow = {
  id: string;
  domain: string;
  pipelineStatus: string;
  auditMode: string;
};

function makeSite(overrides: Partial<SiteRow> = {}): SiteRow {
  return {
    id: "site-1",
    domain: "example.com",
    pipelineStatus: "crawling",
    auditMode: "single",
    ...overrides,
  };
}

type PendingRow = {
  id: string;
  domain: string;
  teamId: string | null;
  crawlLimit: number | null;
};

function makePending(overrides: Partial<PendingRow> = {}): PendingRow {
  return {
    id: "pending-1",
    domain: "pending.com",
    teamId: "team-1",
    crawlLimit: null,
    ...overrides,
  };
}

/**
 * Wire up db.select / db.selectDistinct / db.update for a single GET invocation.
 *   - inProgressRows: returned by the first db.select(...) (in-progress branch).
 *   - pendingRows:    returned by db.selectDistinct(...) (pending branch).
 *   - teamRowsByCallIndex: per-call team lookup; consumed in order for pending rows
 *                          that have crawlLimit=null. Use [] to simulate "no team row".
 *   - updateReturnsByCallIndex: per-call CAS UPDATE return; defaults to [{id}] (winner).
 */
function setupDb(opts: {
  inProgressRows?: unknown[];
  pendingRows?: unknown[];
  teamRowsByCallIndex?: unknown[][];
  updateReturnsByCallIndex?: unknown[][];
}) {
  let selectCall = 0;
  const teamCalls = opts.teamRowsByCallIndex ?? [];
  const updateReturns = opts.updateReturnsByCallIndex ?? [];

  (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
    if (selectCall === 0) {
      selectCall++;
      return makeSelectChain(opts.inProgressRows ?? []);
    }
    // subsequent calls = team lookups for pending sites
    const idx = selectCall - 1;
    selectCall++;
    return makeTeamSelectChain(teamCalls[idx] ?? []);
  });

  (db.selectDistinct as ReturnType<typeof vi.fn>).mockImplementation(() =>
    makeSelectChain(opts.pendingRows ?? [])
  );

  let updateCall = 0;
  (db.update as ReturnType<typeof vi.fn>).mockImplementation(() => {
    const rows = updateReturns[updateCall] ?? [{ id: `update-${updateCall}` }];
    updateCall++;
    return makeUpdateChain(rows);
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("GET /api/cron/process-queue — non-happy-path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks() does NOT reset chained mockRejectedValue/mockResolvedValue,
    // so a rejection set with .mockRejectedValue in a prior test would bleed into
    // the next. Restore the default per-test.
    mockEnqueueStage.mockReset();
    mockEnqueueStage.mockResolvedValue(undefined);
    process.env.CRON_SECRET = TEST_SECRET;
    setupDb({});
  });

  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  // ── Auth ──────────────────────────────────────────────────────────────────

  it("missing CRON_SECRET env → 503", async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(makeRequest(TEST_SECRET));
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toBeTruthy();
  });

  it("no Authorization header → 401", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Unauthorized");
  });

  it("wrong secret → 401", async () => {
    const res = await GET(makeRequest("definitely-wrong-secret"));
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Unauthorized");
  });

  it("valid secret → proceeds past auth (200)", async () => {
    const res = await GET(makeRequest(TEST_SECRET));
    expect(res.status).toBe(200);
  });

  // ── No stale sites ────────────────────────────────────────────────────────

  it("no stale sites → returns {checked: 0, requeued: 0, restarted: 0, errors: 0}", async () => {
    const res = await GET(makeRequest(TEST_SECRET));
    const body = await res.json() as {
      checked: number; requeued: number; restarted: number; errors: number;
    };
    expect(body.checked).toBe(0);
    expect(body.requeued).toBe(0);
    expect(body.restarted).toBe(0);
    expect(body.errors).toBe(0);
  });

  // ── Stage mapping ─────────────────────────────────────────────────────────

  it("crawling → re-enqueues as crawl-fanout", async () => {
    const site = makeSite({ id: "s1", domain: "crawling.com", pipelineStatus: "crawling" });
    setupDb({ inProgressRows: [site] });

    await GET(makeRequest(TEST_SECRET));

    expect(mockEnqueueStage).toHaveBeenCalledOnce();
    expect(mockEnqueueStage).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: "s1", domain: "crawling.com", stage: "crawl-fanout" })
    );
  });

  it("processing (legacy, dead status) → skipped, not re-enqueued", async () => {
    // FIX-024: 'processing' has no production writer and was removed from
    // IN_PROGRESS_STATUSES + STATUS_TO_STAGE. If a stale row somehow carries it,
    // the !stage guard skips it without enqueueing.
    const site = makeSite({ id: "s2", domain: "processing.com", pipelineStatus: "processing" });
    setupDb({ inProgressRows: [site] });

    const res = await GET(makeRequest(TEST_SECRET));

    expect(mockEnqueueStage).not.toHaveBeenCalled();
    const body = await res.json() as { requeued: number; errors: number };
    expect(body.requeued).toBe(0);
    expect(body.errors).toBe(0);
  });

  it("generating → re-enqueues as generate-fanout", async () => {
    const site = makeSite({ id: "s3", domain: "generating.com", pipelineStatus: "generating" });
    setupDb({ inProgressRows: [site] });

    await GET(makeRequest(TEST_SECRET));

    expect(mockEnqueueStage).toHaveBeenCalledOnce();
    expect(mockEnqueueStage).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "generate-fanout" })
    );
  });

  it("assembling → re-enqueues as assemble", async () => {
    const site = makeSite({ id: "s4", domain: "assembling.com", pipelineStatus: "assembling" });
    setupDb({ inProgressRows: [site] });

    await GET(makeRequest(TEST_SECRET));

    expect(mockEnqueueStage).toHaveBeenCalledOnce();
    expect(mockEnqueueStage).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "assemble" })
    );
  });

  it("discovery → re-enqueues as discover", async () => {
    const site = makeSite({ id: "s5", domain: "discovery.com", pipelineStatus: "discovery" });
    setupDb({ inProgressRows: [site] });

    await GET(makeRequest(TEST_SECRET));

    expect(mockEnqueueStage).toHaveBeenCalledOnce();
    expect(mockEnqueueStage).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "discover" })
    );
  });

  // ── Error handling (in-progress branch) ───────────────────────────────────

  it("enqueueStage throws for one site → error counted, continues to next", async () => {
    const sites = [
      makeSite({ id: "site-ok-1", domain: "ok1.com", pipelineStatus: "crawling" }),
      makeSite({ id: "site-fail", domain: "fail.com", pipelineStatus: "researching" }),
      makeSite({ id: "site-ok-2", domain: "ok2.com", pipelineStatus: "analyzing" }),
    ];
    setupDb({ inProgressRows: sites });

    mockEnqueueStage
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("QStash timeout"))
      .mockResolvedValueOnce(undefined);

    const res = await GET(makeRequest(TEST_SECRET));

    expect(res.status).toBe(200);
    const body = await res.json() as {
      checked: number; requeued: number; restarted: number; errors: number;
    };
    expect(body.checked).toBe(3);
    expect(body.requeued).toBe(2);
    expect(body.restarted).toBe(0);
    expect(body.errors).toBe(1);
    expect(mockEnqueueStage).toHaveBeenCalledTimes(3);
  });

  it("enqueueStage throws for all sites → errors=N, requeued=0", async () => {
    const sites = [
      makeSite({ id: "a", domain: "a.com", pipelineStatus: "crawling" }),
      makeSite({ id: "b", domain: "b.com", pipelineStatus: "discovery" }),
      makeSite({ id: "c", domain: "c.com", pipelineStatus: "assembling" }),
    ];
    setupDb({ inProgressRows: sites });

    mockEnqueueStage.mockRejectedValue(new Error("QStash unavailable"));

    const res = await GET(makeRequest(TEST_SECRET));

    expect(res.status).toBe(200);
    const body = await res.json() as {
      checked: number; requeued: number; restarted: number; errors: number;
    };
    expect(body.checked).toBe(3);
    expect(body.requeued).toBe(0);
    expect(body.restarted).toBe(0);
    expect(body.errors).toBe(3);
  });

  it("DB query throws → 500", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("Connection refused");
    });

    const res = await GET(makeRequest(TEST_SECRET));

    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Internal server error");
  });

  // ── Limit / count accuracy ────────────────────────────────────────────────

  it("returns checked count matching stale sites found", async () => {
    const sites = Array.from({ length: 5 }, (_, i) =>
      makeSite({ id: `site-${i}`, domain: `site${i}.com`, pipelineStatus: "crawling" })
    );
    setupDb({ inProgressRows: sites });

    const res = await GET(makeRequest(TEST_SECRET));
    const body = await res.json() as { checked: number };

    expect(body.checked).toBe(5);
  });

  // ── Mixed statuses ────────────────────────────────────────────────────────

  it("sites with different statuses → each mapped to correct stage", async () => {
    const sites = [
      makeSite({ id: "c1", domain: "crawling.com", pipelineStatus: "crawling" }),
      makeSite({ id: "g1", domain: "generating.com", pipelineStatus: "generating" }),
    ];
    setupDb({ inProgressRows: sites });

    await GET(makeRequest(TEST_SECRET));

    expect(mockEnqueueStage).toHaveBeenCalledTimes(2);
    expect(mockEnqueueStage).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: "c1", stage: "crawl-fanout" })
    );
    expect(mockEnqueueStage).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: "g1", stage: "generate-fanout" })
    );
  });

  // ── Unknown / unmapped status ─────────────────────────────────────────────

  it("site with unknown pipelineStatus → skipped via !stage guard, not enqueued", async () => {
    // "completed" is not in IN_PROGRESS_STATUSES so would not normally appear
    // from the DB query, but if it somehow slips through (e.g. a race or a mock)
    // the !stage guard inside the loop must skip it without throwing.
    const sites = [
      makeSite({ id: "done", domain: "done.com", pipelineStatus: "completed" }),
    ];
    setupDb({ inProgressRows: sites });

    const res = await GET(makeRequest(TEST_SECRET));

    expect(res.status).toBe(200);
    // enqueueStage must not be called — no valid stage to map to
    expect(mockEnqueueStage).not.toHaveBeenCalled();
    const body = await res.json() as {
      checked: number; requeued: number; restarted: number; errors: number;
    };
    // Site was found (checked), but skipped (requeued=0, errors=0)
    expect(body.checked).toBe(1);
    expect(body.requeued).toBe(0);
    expect(body.restarted).toBe(0);
    expect(body.errors).toBe(0);
  });

  // ── Pending-restart branch ────────────────────────────────────────────────

  it("eligible pending site with crawlLimit → restarted, discover enqueued with crawlLimit maxPages", async () => {
    const pending = makePending({ id: "p1", domain: "paid.com", crawlLimit: 250 });
    setupDb({ pendingRows: [pending] });

    const res = await GET(makeRequest(TEST_SECRET));

    expect(res.status).toBe(200);
    const body = await res.json() as {
      checked: number; requeued: number; restarted: number; errors: number;
    };
    expect(body.restarted).toBe(1);
    expect(body.errors).toBe(0);
    expect(body.checked).toBe(1);
    expect(mockEnqueueStage).toHaveBeenCalledOnce();
    expect(mockEnqueueStage).toHaveBeenCalledWith({
      siteId: "p1",
      domain: "paid.com",
      stage: "discover",
      maxPages: 250,
    });
    // CAS update was attempted once
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it("eligible pending site without crawlLimit + team has credits → maxPages from credits", async () => {
    const pending = makePending({ id: "p2", domain: "credit.com", crawlLimit: null, teamId: "team-x" });
    setupDb({
      pendingRows: [pending],
      // free/inactive team → resolver uses credits: 7 × PAGES_PER_CREDIT (10) = 70 pages
      teamRowsByCallIndex: [[{ monthlyPageAllowance: 20, monthlyPagesUsed: 0, creditBalance: 7, subscriptionTier: "free", subscriptionStatus: "inactive" }]],
    });

    await GET(makeRequest(TEST_SECRET));

    expect(mockEnqueueStage).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: "p2", stage: "discover", maxPages: 70 })
    );
  });

  it("eligible pending site without crawlLimit + zero credits → falls back to FREE_MAX_PAGES", async () => {
    const pending = makePending({ id: "p3", domain: "free.com", crawlLimit: null, teamId: "team-y" });
    setupDb({
      pendingRows: [pending],
      teamRowsByCallIndex: [[{ monthlyPageAllowance: 20, monthlyPagesUsed: 0, creditBalance: 0, subscriptionTier: "free", subscriptionStatus: "inactive" }]],
    });

    await GET(makeRequest(TEST_SECRET));

    // FREE_MAX_PAGES = 20 from lib/config.ts
    expect(mockEnqueueStage).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: "p3", maxPages: 20 })
    );
  });

  it("eligible pending site without crawlLimit + subscription allowance → maxPages from tier (not 20)", async () => {
    // FIX-024 core bug: subscription-funded stalls (creditBalance 0 but a paid
    // monthly page allowance) previously restarted at the 20-page free default.
    const pending = makePending({ id: "p-sub", domain: "sub.com", crawlLimit: null, teamId: "team-sub" });
    setupDb({
      pendingRows: [pending],
      teamRowsByCallIndex: [[{ monthlyPageAllowance: 5000, monthlyPagesUsed: 0, creditBalance: 0, subscriptionTier: "growth", subscriptionStatus: "active" }]],
    });

    await GET(makeRequest(TEST_SECRET));

    // growth: maxAuditPages 500; allowance headroom 5000 → min(5000, 500) = 500.
    expect(mockEnqueueStage).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: "p-sub", stage: "discover", maxPages: 500 })
    );
  });

  it("pending site CAS loses race (UPDATE returns []) → silently skipped, no enqueue", async () => {
    const pending = makePending({ id: "p-race", domain: "race.com", crawlLimit: 100 });
    setupDb({
      pendingRows: [pending],
      updateReturnsByCallIndex: [[]], // simulate concurrent winner already flipped status
    });

    const res = await GET(makeRequest(TEST_SECRET));

    expect(res.status).toBe(200);
    expect(mockEnqueueStage).not.toHaveBeenCalled();
    const body = await res.json() as { restarted: number; errors: number };
    expect(body.restarted).toBe(0);
    expect(body.errors).toBe(0);
  });

  it("pending site enqueueStage throws after CAS win → errors++, status stays in 'discovery'", async () => {
    const pending = makePending({ id: "p-fail", domain: "fail-pending.com", crawlLimit: 50 });
    setupDb({ pendingRows: [pending] });

    mockEnqueueStage.mockRejectedValueOnce(new Error("QStash 500"));

    const res = await GET(makeRequest(TEST_SECRET));

    const body = await res.json() as { restarted: number; errors: number };
    expect(body.restarted).toBe(0);
    expect(body.errors).toBe(1);
    // CAS update DID run (status was flipped before the throw)
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it("mixed in-progress + pending in same tick → both branches counted independently", async () => {
    const inProgress = makeSite({ id: "ip1", domain: "ip.com", pipelineStatus: "crawling" });
    const pending = makePending({ id: "p-mix", domain: "mix.com", crawlLimit: 30 });
    setupDb({ inProgressRows: [inProgress], pendingRows: [pending] });

    const res = await GET(makeRequest(TEST_SECRET));

    const body = await res.json() as {
      checked: number; requeued: number; restarted: number; errors: number;
    };
    expect(body.checked).toBe(2);
    expect(body.requeued).toBe(1);
    expect(body.restarted).toBe(1);
    expect(body.errors).toBe(0);
    expect(mockEnqueueStage).toHaveBeenCalledTimes(2);
  });

  it("pending branch errors do not stop remaining pending rows", async () => {
    const sites = [
      makePending({ id: "pa", domain: "a.com", crawlLimit: 10 }),
      makePending({ id: "pb", domain: "b.com", crawlLimit: 20 }),
      makePending({ id: "pc", domain: "c.com", crawlLimit: 30 }),
    ];
    setupDb({ pendingRows: sites });

    mockEnqueueStage
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(undefined);

    const res = await GET(makeRequest(TEST_SECRET));

    const body = await res.json() as { restarted: number; errors: number };
    expect(body.restarted).toBe(2);
    expect(body.errors).toBe(1);
    expect(mockEnqueueStage).toHaveBeenCalledTimes(3);
  });
});
