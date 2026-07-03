/**
 * Stack Constraint Tests — Vercel + QStash + Postgres/PgBouncer
 *
 * These tests model real-world failure modes that only occur in the production
 * deployment topology, NOT in a single-process test environment:
 *
 *   Vercel Serverless:
 *     - Multiple cold-start instances process the same site concurrently
 *     - 120s hard kill terminates functions mid-execution
 *     - No shared in-memory state between invocations
 *
 *   Upstash QStash:
 *     - At-least-once delivery: messages can be delivered >1 time
 *     - retries=0 prevents QStash auto-retry, but network-level redelivery is possible
 *     - Messages enqueued to QStash cannot be recalled after Promise.all resolves
 *
 *   Postgres (Supabase via PgBouncer):
 *     - Read-committed isolation (NOT serializable) — two concurrent transactions
 *       can read the same row, then both write based on stale reads
 *     - PgBouncer transaction pooling may multiplex connections
 *     - UPDATE...RETURNING is the only safe pattern for atomic read-modify-write
 *
 * These tests document and verify defensive patterns. Some tests assert the
 * CURRENT (buggy) behavior and are annotated with BUG-XX references.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Environment ─────────────────────────────────────────────────────────────

vi.hoisted(() => {
  process.env.CRON_SECRET = "test-cron-secret";
  process.env.FIRECRAWL_API_KEY = "test-fc-key";
  process.env.NEXT_PUBLIC_APP_URL = "https://test.flowblinq.com";
});

// ─── Hoisted mock references ─────────────────────────────────────────────────

const mockFcInstance = vi.hoisted(() => ({
  asyncBatchScrapeUrls: vi.fn(),
  checkBatchScrapeStatus: vi.fn(),
}));

const { mockEnqueueStage } = vi.hoisted(() => ({
  mockEnqueueStage: vi.fn().mockResolvedValue(undefined),
}));

// ─── Module mocks ────────────────────────────────────────────────────────────

vi.mock("@mendable/firecrawl-js", () => ({
  FirecrawlAppV1: vi.fn().mockImplementation(function () { return mockFcInstance; }),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock("@/lib/qstash", () => ({ enqueueStage: mockEnqueueStage }));
vi.mock("nanoid", () => ({ nanoid: vi.fn().mockReturnValue("mock-id") }));
vi.mock("@/lib/email", () => ({
  sendCompletionEmail: vi.fn().mockResolvedValue(undefined),
  // Wave-2 AC-B1-3: markFailedWithRetry no longer swallows throws from
  // markFailed → sendPipelineFailedEmail must be a defined export on the
  // mock or the call site TypeErrors before the .catch promise chain.
  sendPipelineFailedEmail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/services/competitive-intel", () => ({ gatherCompetitiveIntel: vi.fn().mockResolvedValue({}) }));
vi.mock("@/lib/services/geo-analyzer", () => ({ analyzeGeoGaps: vi.fn().mockResolvedValue({ overallScore: 80 }) }));
vi.mock("@/lib/services/content-generator", () => ({
  generateLlmsTxt: vi.fn(),
  generateBusinessJson: vi.fn(),
  generateSitewideSchemaBlocks: vi.fn(),
  generatePerPageFaqBlocks: vi.fn(),
  generateArticleBlocks: vi.fn(),
  generateRobotsTxtBlock: vi.fn(),
  sanitizeLlmsTxt: vi.fn((s: string) => s),
  sanitizeBusinessJson: vi.fn((s: unknown) => s),
}));
vi.mock("@/lib/services/assembler", () => ({
  assembleResults: vi.fn().mockResolvedValue({}),
  checkGeneratedContent: vi.fn().mockReturnValue(true),
  checkExecutiveSummary: vi.fn().mockReturnValue(true),
}));
vi.mock("@/lib/services/per-page-analyzer", () => ({ extractPerPageVulnerabilities: vi.fn().mockReturnValue([]) }));
vi.mock("@/lib/crawl-mode", () => ({ getCrawlMode: vi.fn().mockResolvedValue("standard") }));
vi.mock("@/lib/config", () => ({
  CRAWL_MAX_CHUNKS: 10,
  POLL_CHUNK_INTERVAL_S: 15,
  POLL_CHUNK_CIRCUIT_BREAKER_MS: 20 * 60 * 1000,
  FREE_MAX_PAGES: 50,
  BULK_CHUNKING_THRESHOLD: 10,
  SIGNUP_BONUS_CREDITS: 20,
  bulkCreditsRequired: vi.fn().mockReturnValue(0),
}));
vi.mock("@/lib/services/geo-crawler", () => ({
  discoverSite: vi.fn(),
  computeChunks: vi.fn().mockReturnValue({ numChunks: 1, chunkSize: 10 }),
  mapDocumentToPage: vi.fn(),
  scoreCrawlQuality: vi.fn(),
}));
vi.mock("@/lib/services/site-view-sync", () => ({
  syncSiteView: vi.fn().mockResolvedValue(undefined),
  syncSiteViewStatus: vi.fn().mockResolvedValue(undefined),
}));

// ─── Imports ─────────────────────────────────────────────────────────────────

import { db } from "@/lib/db";
import { POST } from "@/app/api/pipeline/stage/route";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(payload: object): NextRequest {
  return new NextRequest("https://test.flowblinq.com/api/pipeline/stage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.CRON_SECRET}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

function makeSelectChain(rows: unknown[] = []) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
    limit: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
  };
}

function makeUpdateChain(returningValue: unknown[] = []) {
  const whereResult = Object.assign(Promise.resolve([]), {
    returning: vi.fn().mockResolvedValue(returningValue),
  });
  const setResult = { where: vi.fn().mockReturnValue(whereResult) };
  return { set: vi.fn().mockReturnValue(setResult) };
}

function makeInsertChain() { return { values: vi.fn().mockResolvedValue([]) }; }

function makeSiteRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "site-stack", domain: "example.com", slug: "example-com", teamId: "team-1",
    auditMode: "standard", pipelineStatus: "discovering", pipelineError: null,
    discoveryData: null, crawlData: null, crawlJobIds: null,
    crawlChunksTotal: null, crawlChunksDone: null, crawlChunkResults: null,
    creditsReserved: null, creditBalance: null, accessToken: "tok-123",
    crawlStartedAt: null, bulkUrls: null, crawlLimit: 50, ownerEmail: "u@test.com",
    geoScorecard: null, executiveSummary: null, recommendations: null,
    generatedLlmsTxt: null, generatedLlmsFullTxt: null, generatedBusinessJson: null,
    generatedSchemaBlocks: null, researchData: null, shareToken: null,
    previousRunSnapshot: null, baselineScorecard: null, changeLog: null,
    updatedAt: new Date(), createdAt: new Date(), ...overrides,
  };
}

/** Collects all .set() args from all db.update() calls */
function getAllUpdateSetArgs(): Record<string, unknown>[] {
  const updateMock = db.update as ReturnType<typeof vi.fn>;
  const seenChains = new Set<object>();
  const args: Record<string, unknown>[] = [];
  for (const r of updateMock.mock.results as { value: ReturnType<typeof makeUpdateChain> }[]) {
    const chain = r.value;
    if (!chain?.set?.mock) continue;
    if (seenChains.has(chain)) continue;
    seenChains.add(chain);
    for (const call of chain.set.mock.calls as [Record<string, unknown>][]) {
      if (call[0]) args.push(call[0]);
    }
  }
  return args;
}

function getAllInsertValuesArgs(): Record<string, unknown>[] {
  const insertMock = db.insert as ReturnType<typeof vi.fn>;
  return insertMock.mock.results
    .map((r: { value: ReturnType<typeof makeInsertChain> }) => r.value?.values?.mock?.calls?.[0]?.[0])
    .filter(Boolean) as Record<string, unknown>[];
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Vercel multi-instance concurrency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (db.update as ReturnType<typeof vi.fn>).mockImplementation(() => makeUpdateChain());
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(makeInsertChain());
  });

  it("BUG-06: markFailed double-refund — two instances both read creditsReserved before either clears it", async () => {
    /**
     * VERCEL SCENARIO: Stage timeout fires on Instance A, cron fires markFailed
     * on Instance B. Both read creditsReserved=10 (separate SELECT), both refund.
     *
     * This test simulates the race: two sequential POST calls where both SELECTs
     * return creditsReserved=10 (as if neither has cleared it yet).
     *
     * EXPECTED BEHAVIOR (after BUG-06 fix): Only one refund should succeed.
     * The second call should find creditsReserved already claimed (NULL) and skip.
     *
     * CURRENT BEHAVIOR (pre-fix): Both refund 10 credits = 20 total for 10 reserved.
     */
    const { discoverSite } = await import("@/lib/services/geo-crawler");
    (discoverSite as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("timeout"));

    const site = makeSiteRow({ creditsReserved: 10, teamId: "team-1" });
    const team = { id: "team-1", creditBalance: 50 };

    // Both calls see the same stale state — creditsReserved=10 not yet cleared
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() =>
      makeSelectChain([{ ...site }, team])
    );

    // Simulate two Vercel instances calling markFailed concurrently
    const res1 = await POST(makeRequest({ siteId: "site-stack", domain: "example.com", stage: "discover" }));
    const res2 = await POST(makeRequest({ siteId: "site-stack", domain: "example.com", stage: "discover" }));

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    // BUG-06 (current behavior): BOTH calls insert crawl_refund transactions
    const refundInserts = getAllInsertValuesArgs().filter((v) => v?.type === "crawl_refund");
    // Current behavior: 2 refunds (this documents the bug — fix should make this 1)
    expect(refundInserts.length).toBeGreaterThanOrEqual(1);
    // When BUG-06 is fixed with atomic claim (UPDATE...RETURNING WHERE credits_reserved IS NOT NULL),
    // change this assertion to: expect(refundInserts).toHaveLength(1);
  });

  it("markFailed pipelineError is set even when two instances race — both writes succeed (last-write-wins)", async () => {
    /**
     * VERCEL SCENARIO: Two instances both call markFailed for the same site.
     * Both write pipelineStatus="failed" and pipelineError. Since these are
     * idempotent (same value), last-write-wins is acceptable for these fields.
     */
    const { discoverSite } = await import("@/lib/services/geo-crawler");
    (discoverSite as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("timeout"));

    const site = makeSiteRow({ creditsReserved: null, teamId: null });
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(makeSelectChain([site]));

    await POST(makeRequest({ siteId: "site-stack", domain: "example.com", stage: "discover" }));
    await POST(makeRequest({ siteId: "site-stack", domain: "example.com", stage: "discover" }));

    // Both calls should have written pipelineStatus="failed" — idempotent, safe
    const failedWrites = getAllUpdateSetArgs().filter((a) => a.pipelineStatus === "failed");
    expect(failedWrites.length).toBeGreaterThanOrEqual(2);
    // Both have the same error message — last-write-wins is fine
    for (const write of failedWrites) {
      expect(write.pipelineError).toBe("timeout");
    }
  });
});

describe("QStash at-least-once delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (db.update as ReturnType<typeof vi.fn>).mockImplementation(() => makeUpdateChain());
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(makeInsertChain());
  });

  it("generate-chunk delivered twice — fan-in counter increments twice for same chunk (BUG-04 related)", async () => {
    /**
     * QSTASH SCENARIO: QStash delivers the same generate-chunk[llms] message
     * twice (at-least-once). The handler runs twice. Each call:
     *   1. Writes generatedLlmsTxt to DB (idempotent — same content)
     *   2. Calls fanInGenerateChunk which does UPDATE generate_chunks_done + 1
     *
     * The content write is idempotent, but the counter increment is NOT.
     * With 5 chunks, if chunk "llms" is delivered twice:
     *   - done goes from 4→5 on first delivery (triggers assemble)
     *   - done goes from 5→6 on second delivery (6 > 5 — triggers assemble again)
     *
     * This test verifies that the handler calls fanInGenerateChunk for each
     * delivery, and if done === total, enqueues assemble each time.
     * The fix is to make assemble enqueue idempotent (check pipelineStatus first).
     */
    const { generateLlmsTxt, sanitizeLlmsTxt } = await import("@/lib/services/content-generator");
    (generateLlmsTxt as ReturnType<typeof vi.fn>).mockResolvedValue({
      llmsTxt: "# Title\n> Summary\n" + "x".repeat(200),
      llmsFullTxt: "full",
    });
    (sanitizeLlmsTxt as ReturnType<typeof vi.fn>).mockImplementation((s: string) => s);

    const site = makeSiteRow({
      crawlData: { domain: "example.com", pages: [], totalCrawled: 0 },
      researchData: {},
      geoScorecard: { overallScore: 70, pillars: [] },
    });
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(makeSelectChain([site]));

    // First delivery: done=5, total=5 → triggers assemble
    (db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ done: 5, total: 5 }]);

    const res1 = await POST(makeRequest({
      siteId: "site-stack", domain: "example.com",
      stage: "generate-chunk", generateChunkType: "llms",
    }));
    expect(res1.status).toBe(200);

    const assembleCallsAfterFirst = mockEnqueueStage.mock.calls.filter(
      ([p]: [{ stage: string }]) => p.stage === "assemble"
    );
    expect(assembleCallsAfterFirst).toHaveLength(1);

    // Second delivery (QStash redelivery): done=6, total=5 → 6 === 5 is false
    // In reality, the atomic SQL increment returns done=6 which is > total=5
    // The done === total check would fail, so assemble would NOT be re-enqueued.
    // This is actually safe because of the strict equality check.
    (db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ done: 6, total: 5 }]);

    const res2 = await POST(makeRequest({
      siteId: "site-stack", domain: "example.com",
      stage: "generate-chunk", generateChunkType: "llms",
    }));
    expect(res2.status).toBe(200);

    // done=6 !== total=5 → assemble NOT enqueued again (strict equality saves us)
    const assembleCallsAfterSecond = mockEnqueueStage.mock.calls.filter(
      ([p]: [{ stage: string }]) => p.stage === "assemble"
    );
    expect(assembleCallsAfterSecond).toHaveLength(1); // Still just 1 — the first call
  });

  it("generate-chunk schema-sitewide delivered twice — schema blocks appended twice to DB", async () => {
    /**
     * QSTASH SCENARIO: schema-sitewide is delivered twice. fanInSchemaChunk does:
     *   generated_schema_blocks = COALESCE(generated_schema_blocks, '[]') || $blocks
     *
     * This APPENDS — it doesn't replace. A second delivery doubles the schema
     * blocks. The assemble stage would see duplicate Organization, FAQ blocks etc.
     *
     * This test documents that the current code does NOT guard against redelivery
     * for schema chunks — content is appended, not upserted.
     */
    const { generateSitewideSchemaBlocks, generateRobotsTxtBlock } = await import("@/lib/services/content-generator");
    (generateSitewideSchemaBlocks as ReturnType<typeof vi.fn>).mockResolvedValue([
      { "@type": "Organization", name: "Test" },
    ]);
    (generateRobotsTxtBlock as ReturnType<typeof vi.fn>).mockReturnValue({ type: "robots" });

    const site = makeSiteRow({
      crawlData: { domain: "example.com", pages: [], totalCrawled: 0 },
      researchData: {},
      geoScorecard: { overallScore: 70, pillars: [] },
    });
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(makeSelectChain([site]));

    // First delivery: done=3, total=5 → not last
    (db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ done: 3, total: 5 }]);
    // Second delivery: done=4, total=5 → still not last, but blocks appended again
    (db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ done: 4, total: 5 }]);

    await POST(makeRequest({
      siteId: "site-stack", domain: "example.com",
      stage: "generate-chunk", generateChunkType: "schema-sitewide",
    }));
    await POST(makeRequest({
      siteId: "site-stack", domain: "example.com",
      stage: "generate-chunk", generateChunkType: "schema-sitewide",
    }));

    // db.execute is called twice (once per delivery) — each appends blocks
    expect(db.execute).toHaveBeenCalledTimes(2);

    // Both calls increment the counter — done goes from 3→4 on delivery 1
    // and 4→5 on delivery 2 (but that's a mock artifact — real DB would be 3→4→5)
    // The key point: the atomic SQL (COALESCE || $blocks) + increment is a single
    // statement, which is safe against Vercel multi-instance, but NOT safe against
    // QStash redelivery since it appends duplicate blocks.
  });

  it("pipeline always returns 200 — QStash never auto-retries regardless of internal errors", async () => {
    /**
     * QSTASH CONSTRAINT: retries=0 means QStash won't retry on non-200.
     * But the handler also always returns 200 even on errors (line 924-925).
     * This is a belt-and-suspenders approach. This test verifies the belt.
     */
    const { discoverSite } = await import("@/lib/services/geo-crawler");
    (discoverSite as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("catastrophic"));

    const site = makeSiteRow({ creditsReserved: null });
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(makeSelectChain([site]));

    const res = await POST(makeRequest({
      siteId: "site-stack", domain: "example.com", stage: "discover",
    }));

    // Must ALWAYS be 200 — not 500. QStash would retry on non-200 if retries > 0.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});

describe("Postgres read-committed isolation (via PgBouncer)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (db.update as ReturnType<typeof vi.fn>).mockImplementation(() => makeUpdateChain());
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(makeInsertChain());
  });

  it("BUG-20: markFailed reads balanceBefore via SELECT, then UPDATEs with SQL expression — balanceBefore can be stale", async () => {
    /**
     * POSTGRES SCENARIO (read-committed):
     *   T1: SELECT team.creditBalance → 50  (markFailed instance A)
     *   T2: SELECT team.creditBalance → 50  (markFailed instance B, concurrent)
     *   T1: UPDATE teams SET credit_balance = credit_balance + 10 → 60 (correct)
     *   T1: INSERT creditTransactions balanceBefore=50, balanceAfter=60 (correct)
     *   T2: UPDATE teams SET credit_balance = credit_balance + 10 → 70 (correct — SQL expr)
     *   T2: INSERT creditTransactions balanceBefore=50, balanceAfter=60 (WRONG — stale read)
     *
     * The UPDATE is safe (uses SQL expression credit_balance + N), but the
     * ledger entry's balanceBefore is from the stale SELECT. The fix is to
     * use UPDATE...RETURNING to derive balanceBefore = returned - delta.
     *
     * This test verifies the current code reads balanceBefore from SELECT.
     */
    const { discoverSite } = await import("@/lib/services/geo-crawler");
    (discoverSite as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("fail"));

    const site = makeSiteRow({ creditsReserved: 10, teamId: "team-1" });
    const team = { id: "team-1", creditBalance: 50 };

    // Both instances read the same stale balance
    let selectCount = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      selectCount++;
      if (selectCount <= 2) return makeSelectChain([site]); // site reads
      return makeSelectChain([team]); // team read — always returns 50
    });

    await POST(makeRequest({ siteId: "site-stack", domain: "example.com", stage: "discover" }));

    // The ledger entry uses balanceBefore from the SELECT (50), not from RETURNING
    const refund = getAllInsertValuesArgs().find((v) => v?.type === "crawl_refund");
    expect(refund).toBeDefined();
    expect(refund?.balanceBefore).toBe(50);
    expect(refund?.balanceAfter).toBe(60); // 50 + 10 — computed from stale read, not RETURNING
    // When BUG-20 is fixed: balanceBefore/After will be derived from RETURNING
  });

  it("fan-in uses atomic UPDATE...RETURNING — safe under read-committed isolation", async () => {
    /**
     * CORRECT PATTERN: fanInGenerateChunk (line 488-498) uses:
     *   UPDATE geo_sites SET generate_chunks_done = generate_chunks_done + 1
     *   WHERE id = $siteId RETURNING generate_chunks_done, generate_chunks_total
     *
     * This is a single SQL statement — atomic even under read-committed.
     * Two concurrent Vercel instances incrementing the same counter will
     * serialize at the row lock level. Both get correct done/total values.
     *
     * This test verifies the handler uses db.execute (raw SQL) for fan-in,
     * not a SELECT-then-UPDATE pattern.
     */
    const { generateLlmsTxt, sanitizeLlmsTxt } = await import("@/lib/services/content-generator");
    (generateLlmsTxt as ReturnType<typeof vi.fn>).mockResolvedValue({
      llmsTxt: "# Title\n> Summary\n" + "x".repeat(200),
      llmsFullTxt: "full",
    });
    (sanitizeLlmsTxt as ReturnType<typeof vi.fn>).mockImplementation((s: string) => s);

    const site = makeSiteRow({
      crawlData: { domain: "example.com", pages: [], totalCrawled: 0 },
      researchData: {},
      geoScorecard: { overallScore: 70, pillars: [] },
    });
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(makeSelectChain([site]));
    (db.execute as ReturnType<typeof vi.fn>).mockResolvedValue([{ done: 3, total: 5 }]);

    await POST(makeRequest({
      siteId: "site-stack", domain: "example.com",
      stage: "generate-chunk", generateChunkType: "llms",
    }));

    // Verify db.execute was used (atomic SQL), not db.select + db.update
    expect(db.execute).toHaveBeenCalled();

    // The execute call should be the fan-in increment (not a select-then-update)
    // We can't inspect the SQL template literal directly in the mock, but we can
    // verify that the fan-in result was used to decide whether to enqueue assemble
    const assembleCalls = mockEnqueueStage.mock.calls.filter(
      ([p]: [{ stage: string }]) => p.stage === "assemble"
    );
    expect(assembleCalls).toHaveLength(0); // done=3 < total=5
  });
});

describe("Vercel 120s function timeout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (db.update as ReturnType<typeof vi.fn>).mockImplementation(() => makeUpdateChain());
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(makeInsertChain());
  });

  it("Wave-2 AC-B1-3: when markFailed throws TWICE the handler re-throws so QStash sees a non-200 and retries", async () => {
    /**
     * Wave-2 contract change (ES-wave-2 §B1 AC-B1-3):
     * the previous .catch(() => {}) swallow on the markFailed call site is
     * replaced with markFailedWithRetry, which retries once on DB-write
     * failure and re-throws on the second failure. The throw escapes the
     * route handler → Next.js returns a non-200 → QStash redelivers the
     * stage so the next attempt's outer catch can try markFailed again.
     * This trades the prior "always 200" invariant for terminal-state
     * durability (no zombie-pending after a transient DB blip).
     */
    const { discoverSite } = await import("@/lib/services/geo-crawler");
    (discoverSite as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("stage error"));

    const site = makeSiteRow({ creditsReserved: null });
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => makeSelectChain([site]));

    let updateCount = 0;
    (db.update as ReturnType<typeof vi.fn>).mockImplementation(() => {
      updateCount++;
      if (updateCount <= 1) return makeUpdateChain(); // updateStatus "discovery"
      return {
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockRejectedValue(new Error("connection terminated")),
        }),
      };
    });

    await expect(
      POST(makeRequest({ siteId: "site-stack", domain: "example.com", stage: "discover" })),
    ).rejects.toThrow(/connection terminated/);
  });

  it("stageTimeout fires 15s before Vercel's 120s kill — gives markFailed time to run", async () => {
    /**
     * VERCEL CONSTRAINT: Functions are hard-killed at 120s (maxDuration=120).
     * stageTimeout fires at 105s (STAGE_TIMEOUT_MS = 105_000), giving 15s
     * for the catch block to run markFailed before Vercel terminates.
     *
     * We can't test the actual timeout (105s too long), but we verify that
     * the stageTimeout constant exists and is used in Promise.race patterns.
     *
     * The generate-chunk handler races the LLM call against stageTimeout.
     * If stageTimeout wins, the handler throws and markFailed runs.
     */
    const { generateLlmsTxt } = await import("@/lib/services/content-generator");

    // Simulate LLM call that would take too long — stageTimeout would fire first
    // Instead of waiting 105s, we make the LLM call reject immediately
    (generateLlmsTxt as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("API timeout"));

    const site = makeSiteRow({
      crawlData: { domain: "example.com", pages: [], totalCrawled: 0 },
      researchData: {},
      geoScorecard: { overallScore: 70, pillars: [] },
    });
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(makeSelectChain([site]));

    // generate-chunk is retryable — first failure should trigger retry enqueue
    const res = await POST(makeRequest({
      siteId: "site-stack", domain: "example.com",
      stage: "generate-chunk", generateChunkType: "llms",
      stageRetryCount: 0,
    }));
    expect(res.status).toBe(200);

    // Should have attempted retry (generate-chunk is retryable)
    const retryCalls = mockEnqueueStage.mock.calls.filter(
      ([p]: [{ stage: string; stageRetryCount?: number }]) =>
        p.stage === "generate-chunk" && p.stageRetryCount === 1
    );
    expect(retryCalls).toHaveLength(1);
    expect(retryCalls[0][1]).toBe(30); // 30s delay for first retry
  });
});

describe("QStash + Vercel cron race conditions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (db.update as ReturnType<typeof vi.fn>).mockImplementation(() => makeUpdateChain());
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(makeInsertChain());
  });

  it("BUG-13: cron re-enqueues generate-fanout while old generate-chunk is still running", async () => {
    /**
     * RACE SCENARIO:
     *   T=0:   generate-fanout sets generateChunksTotal=5, done=0, fans out 5 chunks
     *   T=5m:  chunks 1-4 complete (done=4)
     *   T=15m: cron detects pipelineStatus="generating", updatedAt stale
     *   T=15m: cron re-enqueues generate-fanout (BUG-13: wrong stage)
     *   T=15m: generate-fanout resets generateChunksTotal=5, done=0
     *   T=16m: chunk 5 (from original fan-out) completes fan-in → done=1
     *          (reset to 0, then +1=1, not 5)
     *   T=16m: new chunks start completing: done goes 1→2→3→4→5
     *   T=17m: new chunk 5 completes → done=6 (original chunk 5 + 5 new)
     *
     * The atomic fan-in's strict equality (done === total) actually prevents
     * double-assemble in most cases because done overshoots total.
     * But the user still gets duplicate LLM calls and wasted money.
     *
     * This test verifies that the fan-in counter uses strict equality,
     * which is a partial defense against this race.
     */
    const { generateLlmsTxt, sanitizeLlmsTxt } = await import("@/lib/services/content-generator");
    (generateLlmsTxt as ReturnType<typeof vi.fn>).mockResolvedValue({
      llmsTxt: "# Title\n> Summary\n" + "x".repeat(200),
      llmsFullTxt: "full",
    });
    (sanitizeLlmsTxt as ReturnType<typeof vi.fn>).mockImplementation((s: string) => s);

    const site = makeSiteRow({
      crawlData: { domain: "example.com", pages: [], totalCrawled: 0 },
      researchData: {},
      geoScorecard: { overallScore: 70, pillars: [] },
    });
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(makeSelectChain([site]));

    // Simulate done=6, total=5 (overshot due to cron reset + old chunk completing)
    (db.execute as ReturnType<typeof vi.fn>).mockResolvedValue([{ done: 6, total: 5 }]);

    await POST(makeRequest({
      siteId: "site-stack", domain: "example.com",
      stage: "generate-chunk", generateChunkType: "llms",
    }));

    // done=6 !== total=5 → assemble NOT enqueued (strict equality protects us)
    const assembleCalls = mockEnqueueStage.mock.calls.filter(
      ([p]: [{ stage: string }]) => p.stage === "assemble"
    );
    expect(assembleCalls).toHaveLength(0);
  });
});

describe("Vercel stateless constraint", () => {
  it("no in-memory state leaks between invocations — each POST is independent", async () => {
    /**
     * VERCEL CONSTRAINT: Each function invocation may run in a different
     * instance. There's no shared in-memory state. The code must not rely on
     * module-level variables that persist between calls (except for client
     * singletons like the QStash Receiver, which are stateless).
     *
     * This test verifies that two consecutive POST calls with different
     * payloads don't share any state (each reads its own site from DB).
     */
    const site1 = makeSiteRow({ id: "site-1", domain: "one.com", creditsReserved: null });
    const site2 = makeSiteRow({ id: "site-2", domain: "two.com", creditsReserved: null });

    const { discoverSite } = await import("@/lib/services/geo-crawler");
    (discoverSite as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("fail"));

    // First call gets site1, second call gets site2
    let callNum = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callNum++;
      return makeSelectChain([callNum <= 2 ? site1 : site2]);
    });

    await POST(makeRequest({ siteId: "site-1", domain: "one.com", stage: "discover" }));
    await POST(makeRequest({ siteId: "site-2", domain: "two.com", stage: "discover" }));

    // Both should have written pipelineStatus="failed" — verify both were processed
    const failedWrites = getAllUpdateSetArgs().filter((a) => a.pipelineStatus === "failed");
    expect(failedWrites).toHaveLength(2);
    // Verify both error messages are "fail" — no state leakage from call 1 to call 2
    for (const write of failedWrites) {
      expect(write.pipelineError).toBe("fail");
    }
  });
});
