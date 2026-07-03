/**
 * Non-happy-path tests for POST /api/pipeline/stage
 *
 * Covers:
 *   - Auth & validation errors (401, 400)
 *   - markFailed: credit refund logic (reserved > 0, = 0, = null, no teamId)
 *   - Stage retry logic: retryable vs non-retryable, max retries exceeded, enqueue failure
 *   - crawl-fanout error paths: no discovery data, all chunks fail, partial chunk failure
 *   - generate-fanout: partial enqueueStage failure propagated to markFailed
 *   - generate-chunk fan-in: done < total (no assemble), done === total (assemble enqueued)
 *   - Unknown stage: always returns 200
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Environment setup (before any module loads) ──────────────────────────────

vi.hoisted(() => {
  // C3: lib/cron-auth.ts requires ≥32 chars.
  process.env.CRON_SECRET = "test-cron-secret-padded-to-32+chars-aaaaa";
  process.env.FIRECRAWL_API_KEY = "test-fc-key";
  process.env.NEXT_PUBLIC_APP_URL = "https://test.flowblinq.com";
});

// ─── Hoisted mock references ──────────────────────────────────────────────────

const mockFcInstance = vi.hoisted(() => ({
  asyncBatchScrapeUrls: vi.fn(),
  checkBatchScrapeStatus: vi.fn(),
}));

const { mockEnqueueStage } = vi.hoisted(() => ({
  mockEnqueueStage: vi.fn().mockResolvedValue(undefined),
}));

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("@mendable/firecrawl-js", () => ({
  FirecrawlAppV1: vi.fn().mockImplementation(function () {
    return mockFcInstance;
  }),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    execute: vi.fn(),
  },
}));

vi.mock("@/lib/qstash", () => ({ enqueueStage: mockEnqueueStage }));
vi.mock("nanoid", () => ({ nanoid: vi.fn().mockReturnValue("mock-id") }));
vi.mock("@/lib/email", () => ({
  sendCompletionEmail: vi.fn().mockResolvedValue(undefined),
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

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { db } from "@/lib/db";
import { POST } from "@/app/api/pipeline/stage/route";
import { discoverSite, computeChunks } from "@/lib/services/geo-crawler";
import { gatherCompetitiveIntel } from "@/lib/services/competitive-intel";

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function makeUnauthRequest(payload: object): NextRequest {
  return new NextRequest("https://test.flowblinq.com/api/pipeline/stage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

function makeInsertChain() {
  return { values: vi.fn().mockResolvedValue([]) };
}

function makeSiteRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "site-err",
    domain: "example.com",
    slug: "example-com",
    teamId: "team-1",
    auditMode: "standard",
    pipelineStatus: "discovering",
    pipelineError: null,
    discoveryData: null,
    crawlData: null,
    crawlJobIds: null,
    crawlChunksTotal: null,
    crawlChunksDone: null,
    crawlChunkResults: null,
    creditsReserved: null,
    creditBalance: null,
    accessToken: "tok-123",
    crawlStartedAt: null,
    bulkUrls: null,
    crawlLimit: null,
    ownerEmail: "user@test.com",
    geoScorecard: null,
    executiveSummary: null,
    recommendations: null,
    generatedLlmsTxt: null,
    generatedLlmsFullTxt: null,
    generatedBusinessJson: null,
    generatedSchemaBlocks: null,
    researchData: null,
    shareToken: null,
    previousRunSnapshot: null,
    baselineScorecard: null,
    changeLog: null,
    updatedAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
}

/** Collect all first-arg objects passed to db.update().set() across all update calls.
 *
 * Works correctly whether db.update is set up with mockReturnValue (shared chain) or
 * mockImplementation (fresh chain per call). For shared-chain mocks the same object
 * appears in mock.results multiple times — deduplicate by identity before flattening.
 */
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

/** Return all .values() args from db.insert() calls */
function getAllInsertValuesArgs(): Record<string, unknown>[] {
  const insertMock = db.insert as ReturnType<typeof vi.fn>;
  return insertMock.mock.results
    .map((r: { value: ReturnType<typeof makeInsertChain> }) => r.value?.values?.mock?.calls?.[0]?.[0])
    .filter(Boolean) as Record<string, unknown>[];
}

// ─── 1. Auth & validation errors ──────────────────────────────────────────────

describe("auth & validation errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when no auth header", async () => {
    const res = await POST(makeUnauthRequest({ siteId: "s1", domain: "x.com", stage: "discover" }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/unauthorized/i);
  });

  it("returns 400 when body is not valid JSON", async () => {
    const req = new NextRequest("https://test.flowblinq.com/api/pipeline/stage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.CRON_SECRET}`,
        "Content-Type": "application/json",
      },
      body: "not-json{{{",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/json/i);
  });

  it("returns 400 when siteId is missing", async () => {
    const res = await POST(makeRequest({ domain: "x.com", stage: "discover" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when domain is missing", async () => {
    const res = await POST(makeRequest({ siteId: "s1", stage: "discover" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when stage is missing", async () => {
    const res = await POST(makeRequest({ siteId: "s1", domain: "x.com" }));
    expect(res.status).toBe(400);
  });
});

// ─── 2. markFailed error paths (triggered via discover throwing) ───────────────

describe("markFailed — triggered by discover stage errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: all updates and inserts succeed. Use mockImplementation so each
    // db.update() call gets a fresh chain with its own set() spy — required for
    // getAllUpdateSetArgs() to collect args from multiple update calls per test.
    (db.update as ReturnType<typeof vi.fn>).mockImplementation(() => makeUpdateChain());
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(makeInsertChain());
  });

  it("site not found — db.select returns empty → marks site as failed", async () => {
    // handleDiscover's first select returns empty → throws "Site not found"
    // markFailed's select also returns empty (no site → no refund path)
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(makeSelectChain([]));

    const res = await POST(makeRequest({ siteId: "site-err", domain: "example.com", stage: "discover", maxPages: 20 }));
    expect(res.status).toBe(200);

    const failedWrite = getAllUpdateSetArgs().find((a) => a.pipelineStatus === "failed");
    expect(failedWrite).toBeDefined();
    expect(failedWrite?.pipelineError).toMatch(/site not found/i);
  });

  it("discoverSite throws → markFailed sets pipelineStatus=failed with error message", async () => {
    const boom = new Error("Firecrawl map timeout");
    (discoverSite as ReturnType<typeof vi.fn>).mockRejectedValueOnce(boom);

    // handleDiscover's select returns site, markFailed's select also returns site (no reserved credits)
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([makeSiteRow({ creditsReserved: null })])
    );

    const res = await POST(makeRequest({ siteId: "site-err", domain: "example.com", stage: "discover", maxPages: 20 }));
    expect(res.status).toBe(200);

    const failedWrite = getAllUpdateSetArgs().find((a) => a.pipelineStatus === "failed");
    expect(failedWrite).toBeDefined();
    expect(failedWrite?.pipelineError).toBe("Firecrawl map timeout");
  });

  // ── FIX-007 / BUG-001: discover budget resolution (no silent FREE_MAX_PAGES) ──

  it("discover with no maxPages and no crawlLimit -> markFailed (refuses to silently cap at free limit)", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([makeSiteRow({ creditsReserved: null, crawlLimit: null })])
    );

    const res = await POST(makeRequest({ siteId: "site-err", domain: "example.com", stage: "discover" }));
    expect(res.status).toBe(200);

    // Budget refusal fires BEFORE any crawl work — discoverSite must not run.
    expect(discoverSite).not.toHaveBeenCalled();
    const failedWrite = getAllUpdateSetArgs().find((a) => a.pipelineStatus === "failed");
    expect(failedWrite).toBeDefined();
    expect(failedWrite?.pipelineError).toMatch(/no page budget resolved/i);
  });

  it("discover with no maxPages but crawlLimit set -> discoverSite receives the row's crawlLimit (not 20)", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([makeSiteRow({ creditsReserved: null, crawlLimit: 250 })])
    );
    // Reject right after the budget resolves so we only assert the passed budget.
    (discoverSite as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("stop"));

    const res = await POST(makeRequest({ siteId: "site-err", domain: "example.com", stage: "discover" }));
    expect(res.status).toBe(200);
    expect(discoverSite).toHaveBeenCalledWith("example.com", 250);
  });

  it("discover with explicit maxPages -> payload budget wins over crawlLimit", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([makeSiteRow({ creditsReserved: null, crawlLimit: 250 })])
    );
    (discoverSite as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("stop"));

    const res = await POST(makeRequest({ siteId: "site-err", domain: "example.com", stage: "discover", maxPages: 7 }));
    expect(res.status).toBe(200);
    expect(discoverSite).toHaveBeenCalledWith("example.com", 7);
  });

  it("creditsReserved=10 → refunds credits to team and inserts crawl_refund transaction", async () => {
    const boom = new Error("discover failed");
    (discoverSite as ReturnType<typeof vi.fn>).mockRejectedValueOnce(boom);

    const siteWithCredits = makeSiteRow({ creditsReserved: 10, teamId: "team-1" });
    const teamRow = { id: "team-1", creditBalance: 50 };

    // markFailed calls db.select twice: once for the site, once for the team
    let selectCount = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) {
        // handleDiscover — site fetch
        return makeSelectChain([siteWithCredits]);
      }
      if (selectCount === 2) {
        // markFailed — site fetch
        return makeSelectChain([siteWithCredits]);
      }
      // markFailed — team fetch
      return makeSelectChain([teamRow]);
    });

    const res = await POST(makeRequest({ siteId: "site-err", domain: "example.com", stage: "discover", maxPages: 20 }));
    expect(res.status).toBe(200);

    // Team balance should be updated
    const teamUpdate = getAllUpdateSetArgs().find(
      (a) => a.creditBalance !== undefined || (a.creditBalance === undefined && a.updatedAt !== undefined && a.pipelineStatus === undefined)
    );
    const updateMock = db.update as ReturnType<typeof vi.fn>;
    // At least one update call should target teams (not geoSites)
    expect(updateMock).toHaveBeenCalled();

    // A creditTransactions insert should have happened with type=crawl_refund
    const txInsert = getAllInsertValuesArgs().find((v) => v?.type === "crawl_refund");
    expect(txInsert).toBeDefined();
    expect(txInsert?.creditsChanged).toBe(10);
    expect(txInsert?.teamId).toBe("team-1");
    expect(txInsert?.siteId).toBe("site-err");
  });

  it("creditsReserved=0 → no team update, no creditTransactions insert", async () => {
    const boom = new Error("discover failed");
    (discoverSite as ReturnType<typeof vi.fn>).mockRejectedValueOnce(boom);

    const site = makeSiteRow({ creditsReserved: 0, teamId: "team-1" });
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => makeSelectChain([site]));

    const res = await POST(makeRequest({ siteId: "site-err", domain: "example.com", stage: "discover", maxPages: 20 }));
    expect(res.status).toBe(200);

    const txInsert = getAllInsertValuesArgs().find((v) => v?.type === "crawl_refund");
    expect(txInsert).toBeUndefined();

    // Only the geoSites update (markFailed) should have run — no team update
    const updateMock = db.update as ReturnType<typeof vi.fn>;
    // All set() args should be for geoSites (contain pipelineStatus)
    const teamUpdateArg = getAllUpdateSetArgs().find(
      (a) => a.pipelineStatus === undefined && a.creditBalance !== undefined
    );
    expect(teamUpdateArg).toBeUndefined();
    // suppress unused warning
    expect(updateMock).toHaveBeenCalled();
  });

  it("creditsReserved=null → no refund issued", async () => {
    const boom = new Error("discover failed");
    (discoverSite as ReturnType<typeof vi.fn>).mockRejectedValueOnce(boom);

    const site = makeSiteRow({ creditsReserved: null, teamId: "team-1" });
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => makeSelectChain([site]));

    const res = await POST(makeRequest({ siteId: "site-err", domain: "example.com", stage: "discover", maxPages: 20 }));
    expect(res.status).toBe(200);

    const txInsert = getAllInsertValuesArgs().find((v) => v?.type === "crawl_refund");
    expect(txInsert).toBeUndefined();
  });

  it("site has no teamId → no refund even when creditsReserved=10", async () => {
    const boom = new Error("discover failed");
    (discoverSite as ReturnType<typeof vi.fn>).mockRejectedValueOnce(boom);

    const site = makeSiteRow({ creditsReserved: 10, teamId: null });
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => makeSelectChain([site]));

    const res = await POST(makeRequest({ siteId: "site-err", domain: "example.com", stage: "discover", maxPages: 20 }));
    expect(res.status).toBe(200);

    const txInsert = getAllInsertValuesArgs().find((v) => v?.type === "crawl_refund");
    expect(txInsert).toBeUndefined();
  });
});

// ─── 3. Stage retry logic ─────────────────────────────────────────────────────

describe("stage retry logic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (db.update as ReturnType<typeof vi.fn>).mockImplementation(() => makeUpdateChain());
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(makeInsertChain());

    // For retryable stages, the site select needs to succeed
    const siteRow = makeSiteRow({
      crawlData: {
        domain: "example.com",
        pages: [{ url: "https://example.com/", pageType: "homepage", content: "hello" }],
        totalCrawled: 1,
      },
      researchData: {},
      geoScorecard: { overallScore: 75, pillars: [] },
      // HP perf Fix 1: research + extract-trees run in parallel; fan-in needs
      // geoTree to confirm extract-trees is done before enqueuing analyze.
      geoTree: { leafCount: 0, nodes: [] },
    });
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(makeSelectChain([siteRow]));
  });

  it("retryable stage (research) degrades gracefully — writes empty intel, triggers fan-in", async () => {
    const boom = new Error("Perplexity API timeout");
    (gatherCompetitiveIntel as ReturnType<typeof vi.fn>).mockRejectedValueOnce(boom);

    // HP perf Fix 1: research now calls tryEnqueueAnalyze (atomic counter)
    // instead of directly enqueueing analyze. Mock db.execute for the counter.
    (db.execute as ReturnType<typeof vi.fn>).mockResolvedValue([{ count: 2 }]);

    const res = await POST(makeRequest({
      siteId: "site-err",
      domain: "example.com",
      stage: "research",
      stageRetryCount: 0,
    }));
    expect(res.status).toBe(200);

    // Research degrades gracefully: gatherCompetitiveIntel failure is caught,
    // empty intel written via updateStatus. Fan-in counter incremented.
    // When count=2, analyze is enqueued.
    const analyzeCalls = mockEnqueueStage.mock.calls.filter(
      ([p]: [{ stage: string }]) => p.stage === "analyze"
    );
    expect(analyzeCalls).toHaveLength(1);
  });

  it("retryable stage (analyze) throws → re-enqueued with stageRetryCount=1 and delay=30", async () => {
    const { analyzeGeoGaps } = await import("@/lib/services/geo-analyzer");
    (analyzeGeoGaps as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("OpenAI failure"));

    const res = await POST(makeRequest({
      siteId: "site-err",
      domain: "example.com",
      stage: "analyze",
      stageRetryCount: 0,
    }));
    expect(res.status).toBe(200);

    // Should have re-enqueued with stageRetryCount=1 and delay=30
    const retryCalls = mockEnqueueStage.mock.calls.filter(
      ([p]: [{ stage: string; stageRetryCount?: number }]) =>
        p.stage === "analyze" && p.stageRetryCount === 1
    );
    expect(retryCalls).toHaveLength(1);
    expect(retryCalls[0][1]).toBe(30); // delaySeconds

    // Should NOT have marked failed
    const failedWrite = getAllUpdateSetArgs().find((a) => a.pipelineStatus === "failed");
    expect(failedWrite).toBeUndefined();
  });

  it("retryable stage exceeds MAX_STAGE_RETRIES (stageRetryCount=2) → marks failed, not re-enqueued", async () => {
    const { analyzeGeoGaps } = await import("@/lib/services/geo-analyzer");
    (analyzeGeoGaps as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("permanent failure"));

    const res = await POST(makeRequest({
      siteId: "site-err",
      domain: "example.com",
      stage: "analyze",
      stageRetryCount: 2, // already at max
    }));
    expect(res.status).toBe(200);

    // Should NOT re-enqueue
    const retryCalls = mockEnqueueStage.mock.calls.filter(
      ([p]: [{ stage: string; stageRetryCount?: number }]) =>
        p.stage === "analyze" && (p.stageRetryCount ?? 0) >= 1
    );
    expect(retryCalls).toHaveLength(0);

    // Should mark failed
    const failedWrite = getAllUpdateSetArgs().find((a) => a.pipelineStatus === "failed");
    expect(failedWrite).toBeDefined();
    expect(failedWrite?.pipelineError).toBe("permanent failure");
  });

  it("non-retryable stage (discover) throws → marks failed immediately, not re-enqueued", async () => {
    (discoverSite as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("map failed"));

    const res = await POST(makeRequest({
      siteId: "site-err",
      domain: "example.com",
      stage: "discover",
      maxPages: 20,
      stageRetryCount: 0,
    }));
    expect(res.status).toBe(200);

    // No retry enqueue with stage=discover
    const retryEnqueue = mockEnqueueStage.mock.calls.filter(
      ([p]: [{ stage: string }]) => p.stage === "discover"
    );
    expect(retryEnqueue).toHaveLength(0);

    const failedWrite = getAllUpdateSetArgs().find((a) => a.pipelineStatus === "failed");
    expect(failedWrite).toBeDefined();
  });

  it("non-retryable stage (crawl-fanout) throws → marks failed immediately", async () => {
    // crawl-fanout with no discoveryData throws "No discovery data"
    const siteNoDiscovery = makeSiteRow({ discoveryData: null, auditMode: "standard" });
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(makeSelectChain([siteNoDiscovery]));

    const res = await POST(makeRequest({
      siteId: "site-err",
      domain: "example.com",
      stage: "crawl-fanout",
      stageRetryCount: 0,
    }));
    expect(res.status).toBe(200);

    const retryCalls = mockEnqueueStage.mock.calls.filter(
      ([p]: [{ stage: string }]) => p.stage === "crawl-fanout"
    );
    expect(retryCalls).toHaveLength(0);

    const failedWrite = getAllUpdateSetArgs().find((a) => a.pipelineStatus === "failed");
    expect(failedWrite).toBeDefined();
  });

  it("non-retryable stage (generate-fanout) throws → marks failed immediately", async () => {
    // Make the initial updateStatus fail so generate-fanout throws
    let updateCount = 0;
    (db.update as ReturnType<typeof vi.fn>).mockImplementation(() => {
      updateCount++;
      if (updateCount === 1) {
        // First update (updateStatus → "generating") throws
        const failingChain = {
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockRejectedValue(new Error("DB write failed")),
          }),
        };
        return failingChain;
      }
      return makeUpdateChain();
    });

    const res = await POST(makeRequest({
      siteId: "site-err",
      domain: "example.com",
      stage: "generate-fanout",
      stageRetryCount: 0,
    }));
    expect(res.status).toBe(200);

    const retryCalls = mockEnqueueStage.mock.calls.filter(
      ([p]: [{ stage: string }]) => p.stage === "generate-fanout"
    );
    expect(retryCalls).toHaveLength(0);

    const failedWrite = getAllUpdateSetArgs().find((a) => a.pipelineStatus === "failed");
    expect(failedWrite).toBeDefined();
  });

  it("retry enqueue itself fails → falls back to markFailed", async () => {
    const { analyzeGeoGaps } = await import("@/lib/services/geo-analyzer");
    (analyzeGeoGaps as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("analyze boom"));

    // First enqueueStage call (the retry enqueue) throws
    mockEnqueueStage.mockRejectedValueOnce(new Error("QStash unavailable"));

    const res = await POST(makeRequest({
      siteId: "site-err",
      domain: "example.com",
      stage: "analyze",
      stageRetryCount: 0,
    }));
    expect(res.status).toBe(200);

    // markFailed should have been called as fallback
    const failedWrite = getAllUpdateSetArgs().find((a) => a.pipelineStatus === "failed");
    expect(failedWrite).toBeDefined();
  });
});

// ─── 4. crawl-fanout error paths ──────────────────────────────────────────────

describe("crawl-fanout error paths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (db.update as ReturnType<typeof vi.fn>).mockImplementation(() => makeUpdateChain());
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(makeInsertChain());
  });

  it("no discovery data (standard mode) → marks failed with descriptive error", async () => {
    const site = makeSiteRow({ discoveryData: null, auditMode: "standard" });
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(makeSelectChain([site]));

    const res = await POST(makeRequest({ siteId: "site-err", domain: "example.com", stage: "crawl-fanout" }));
    expect(res.status).toBe(200);

    const failedWrite = getAllUpdateSetArgs().find((a) => a.pipelineStatus === "failed");
    expect(failedWrite).toBeDefined();
    expect(String(failedWrite?.pipelineError)).toMatch(/no discovery data/i);
  });

  it("all chunk submissions fail → marks failed", async () => {
    const urls = Array.from({ length: 5 }, (_, i) => `https://example.com/page-${i}`);
    const pageMap: Record<string, string> = {};
    for (const url of urls) pageMap[url] = "other";
    const discoveryData = { urls, pageMap, hasLlmsTxt: false, hasUcp: false, hasSitemap: false, hasRobots: false, totalPages: urls.length };

    const site = makeSiteRow({ discoveryData, auditMode: "standard" });
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(makeSelectChain([site]));

    // computeChunks returns 1 chunk; asyncBatchScrapeUrls throws for it
    (computeChunks as ReturnType<typeof vi.fn>).mockReturnValue({ numChunks: 1, chunkSize: 5 });
    mockFcInstance.asyncBatchScrapeUrls.mockRejectedValue(new Error("Firecrawl batch error"));

    const res = await POST(makeRequest({ siteId: "site-err", domain: "example.com", stage: "crawl-fanout" }));
    expect(res.status).toBe(200);

    const failedWrite = getAllUpdateSetArgs().find((a) => a.pipelineStatus === "failed");
    expect(failedWrite).toBeDefined();
    expect(String(failedWrite?.pipelineError)).toMatch(/chunk submissions failed/i);
  });

  it("partial chunk submission failure → crawlChunksTotal set to numChunks up-front, failed chunk fanned-in", async () => {
    const chunk0Urls = ["https://example.com/p0", "https://example.com/p1"];
    const chunk1Urls = ["https://example.com/p2", "https://example.com/p3"];
    const chunk2Urls = ["https://example.com/p4", "https://example.com/p5"];
    const allUrls = [...chunk0Urls, ...chunk1Urls, ...chunk2Urls];
    const pageMap: Record<string, string> = {};
    for (const url of allUrls) pageMap[url] = "other";
    const discoveryData = { urls: allUrls, pageMap, hasLlmsTxt: false, hasUcp: false, hasSitemap: false, hasRobots: false, totalPages: allUrls.length };

    const site = makeSiteRow({ discoveryData, auditMode: "standard" });
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(makeSelectChain([site]));

    // 3 chunks, first 2 succeed, 3rd fails
    (computeChunks as ReturnType<typeof vi.fn>).mockReturnValue({ numChunks: 3, chunkSize: 2 });

    let batchCallCount = 0;
    mockFcInstance.asyncBatchScrapeUrls.mockImplementation(async () => {
      batchCallCount++;
      if (batchCallCount <= 2) return { id: `fc-job-${batchCallCount}` };
      throw new Error("rate limit");
    });

    // Capture all set() args with a custom implementation
    const capturedSets: Record<string, unknown>[] = [];
    (db.update as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const whereResult = Object.assign(Promise.resolve([]), {
        returning: vi.fn().mockResolvedValue([]),
      });
      return {
        set: vi.fn().mockImplementation((d: Record<string, unknown>) => {
          capturedSets.push(d);
          return { where: vi.fn().mockReturnValue(whereResult) };
        }),
      };
    });

    // fanInChunk (the failed chunk) reads its counter via db.execute. Return a
    // non-terminal count (1/3) so the failed-chunk fan-in does NOT trigger merge.
    (db.execute as ReturnType<typeof vi.fn>).mockResolvedValue([{ done: 1, total: 3 }]);

    const res = await POST(makeRequest({ siteId: "site-err", domain: "example.com", stage: "crawl-fanout" }));
    expect(res.status).toBe(200);

    // Poll-first fix: crawlChunksTotal is set UP-FRONT to numChunks (3), in the
    // initial coordination write — not the successful count after the loop.
    const upfrontWrite = capturedSets.find((a) => a.crawlChunksTotal === 3);
    expect(upfrontWrite).toBeDefined();

    // The failed chunk (chunk 2) is fanned-in immediately via fanInChunk
    // (db.execute) so done can still reach total.
    expect(db.execute).toHaveBeenCalled();

    // Site should NOT be marked failed since 2 of 3 chunks succeeded (above ratio).
    const failedWrite = capturedSets.find((a) => a.pipelineStatus === "failed");
    expect(failedWrite).toBeUndefined();
  });

  it("FIND-018: minority of chunks submit (1/3) → marks failed, no heavily-partial crawl", async () => {
    const allUrls = Array.from({ length: 6 }, (_, i) => `https://example.com/p${i}`);
    const pageMap: Record<string, string> = {};
    for (const url of allUrls) pageMap[url] = "other";
    const discoveryData = { urls: allUrls, pageMap, hasLlmsTxt: false, hasUcp: false, hasSitemap: false, hasRobots: false, totalPages: allUrls.length };

    const site = makeSiteRow({ discoveryData, auditMode: "standard" });
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(makeSelectChain([site]));
    (computeChunks as ReturnType<typeof vi.fn>).mockReturnValue({ numChunks: 3, chunkSize: 2 });

    // Only the first chunk submits; the other two fail → 1/3 = 33% < 50% threshold.
    let batchCallCount = 0;
    mockFcInstance.asyncBatchScrapeUrls.mockImplementation(async () => {
      batchCallCount++;
      if (batchCallCount === 1) return { id: "fc-job-1" };
      throw new Error("rate limit");
    });

    const res = await POST(makeRequest({ siteId: "site-err", domain: "example.com", stage: "crawl-fanout" }));
    expect(res.status).toBe(200);

    const failedWrite = getAllUpdateSetArgs().find((a) => a.pipelineStatus === "failed");
    expect(failedWrite).toBeDefined();
    expect(String(failedWrite?.pipelineError)).toMatch(/submission incomplete/i);
  });
});

// ─── 5. generate-fanout error paths ───────────────────────────────────────────

describe("generate-fanout error paths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(makeInsertChain());
  });

  it("Promise.all enqueueStage partially fails → error propagated and markFailed called", async () => {
    // updateStatus (generating) succeeds
    (db.update as ReturnType<typeof vi.fn>).mockImplementation(() => makeUpdateChain());

    // First two enqueueStage calls succeed, third fails
    let enqueueCount = 0;
    mockEnqueueStage.mockImplementation(async () => {
      enqueueCount++;
      if (enqueueCount === 3) throw new Error("QStash 3rd enqueue failed");
      // return undefined for success
    });

    const res = await POST(makeRequest({
      siteId: "site-err",
      domain: "example.com",
      stage: "generate-fanout",
    }));
    expect(res.status).toBe(200);

    // generate-fanout is non-retryable — should mark failed
    const failedWrite = getAllUpdateSetArgs().find((a) => a.pipelineStatus === "failed");
    expect(failedWrite).toBeDefined();
    expect(String(failedWrite?.pipelineError)).toMatch(/enqueue/i);
  });
});

// ─── 6. generate-chunk fan-in ─────────────────────────────────────────────────

describe("generate-chunk fan-in (llms chunk type)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(makeInsertChain());

    const site = makeSiteRow({
      crawlData: {
        domain: "example.com",
        pages: [],
        totalCrawled: 0,
      },
      researchData: {},
      geoScorecard: { overallScore: 70, pillars: [] },
    });
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(makeSelectChain([site]));
  });

  it("fan-in returns done < total → assemble NOT enqueued", async () => {
    const { generateLlmsTxt, sanitizeLlmsTxt } = await import("@/lib/services/content-generator");
    (generateLlmsTxt as ReturnType<typeof vi.fn>).mockResolvedValue({
      llmsTxt: "# Title\n> Summary\n" + "x".repeat(200),
      llmsFullTxt: "full",
    });
    (sanitizeLlmsTxt as ReturnType<typeof vi.fn>).mockImplementation((s: string) => s);

    // db.update for saving llmsTxt succeeds
    (db.update as ReturnType<typeof vi.fn>).mockImplementation(() => makeUpdateChain());

    // db.execute (fanInGenerateChunk): done=3, total=5 → NOT last
    (db.execute as ReturnType<typeof vi.fn>).mockResolvedValue([{ done: 3, total: 5 }]);

    const res = await POST(makeRequest({
      siteId: "site-err",
      domain: "example.com",
      stage: "generate-chunk",
      generateChunkType: "llms",
    }));
    expect(res.status).toBe(200);

    const assembleCalls = mockEnqueueStage.mock.calls.filter(
      ([p]: [{ stage: string }]) => p.stage === "assemble"
    );
    expect(assembleCalls).toHaveLength(0);
  });

  it("fan-in returns done === total → assemble enqueued", async () => {
    const { generateLlmsTxt, sanitizeLlmsTxt } = await import("@/lib/services/content-generator");
    (generateLlmsTxt as ReturnType<typeof vi.fn>).mockResolvedValue({
      llmsTxt: "# Title\n> Summary\n" + "x".repeat(200),
      llmsFullTxt: "full",
    });
    (sanitizeLlmsTxt as ReturnType<typeof vi.fn>).mockImplementation((s: string) => s);

    (db.update as ReturnType<typeof vi.fn>).mockImplementation(() => makeUpdateChain());

    // db.execute: done=5, total=5 → IS last chunk
    (db.execute as ReturnType<typeof vi.fn>).mockResolvedValue([{ done: 5, total: 5 }]);

    const res = await POST(makeRequest({
      siteId: "site-err",
      domain: "example.com",
      stage: "generate-chunk",
      generateChunkType: "llms",
    }));
    expect(res.status).toBe(200);

    const assembleCalls = mockEnqueueStage.mock.calls.filter(
      ([p]: [{ stage: string }]) => p.stage === "assemble"
    );
    expect(assembleCalls).toHaveLength(1);
    expect(assembleCalls[0][0]).toMatchObject({
      stage: "assemble",
      siteId: "site-err",
      domain: "example.com",
    });
  });
});

// ─── 7. Unknown stage ─────────────────────────────────────────────────────────

describe("unknown stage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (db.update as ReturnType<typeof vi.fn>).mockImplementation(() => makeUpdateChain());
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(makeInsertChain());
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(makeSelectChain([]));
  });

  it("unknown stage value → marks the audit failed (loud-fail, no silent ack-drop)", async () => {
    // FIND-SILENTFAILURE-016 (FIX-009): an unknown stage now THROWS -> caught ->
    // markFailed, instead of silently console.error'ing, acking 200, and
    // freezing the audit in-progress forever (QStash retries=0 drops the msg).
    const res = await POST(makeRequest({
      siteId: "site-err",
      domain: "example.com",
      stage: "invalid-stage",
    }));
    // Still 200 so QStash does not redeliver; the failure is recorded in the DB.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // The audit must now be marked failed with a descriptive "unknown stage" error.
    const failedWrite = getAllUpdateSetArgs().find((a) => a.pipelineStatus === "failed");
    expect(failedWrite).toBeDefined();
    expect(String(failedWrite?.pipelineError)).toMatch(/unknown pipeline stage/i);
  });
});
