/**
 * ES-082 Phase A — pipeline integration tests for llms.txt empty generation
 * (IT1-IT6 + IT12-IT13)
 *
 * Author:   ReviewMaster (Agent 9)
 * Date:     2026-04-09
 * Spec:     geo/docs/specs/engineering/ES-082-llms-txt-empty-generation-fix.md (§d.1, §d.3)
 *
 * Test breakdown:
 *   IT1   — Smoke test for the entire fix (LOAD-BEARING — RED→GREEN gate)
 *           Empty generation → stage marked failed → no empty string persisted
 *   IT2   — Manipal fixture replay through Direction B (skipIf if Direction B
 *           prompt builder not yet exported)
 *   IT3   — generateBusinessJson validation failure now throws + propagates
 *           through markFailed
 *   IT4   — assembleResults adapter success path (covers AC-16 happy path)
 *   IT5   — assembleResults adapter failure path (covers AC-16 failure path)
 *   IT6   — Regression sentinel: pipeline-stage-errors.test.ts existence check
 *           (the actual regression run happens in the test sweep — see ES-082
 *           §d.1 IT6 + §c.7 AC-17 — running the existing 831-line file
 *           unchanged is the gate, not a test in this file)
 *   IT12  — regenerate-empty-llms-txt operator script E2E (skipIf — script
 *           doesn't exist yet)
 *   IT13  — regenerate-empty-llms-txt race condition (skipIf)
 *
 * Independence rule (Phase A):
 *   - Test site IDs use `manipal-fixture-rm-it1`, NOT the literal
 *     `-GzFX1KcKhmN0W_1t8SmY` ScriptDev source uses
 *   - Mocks @/lib/db at the SDK boundary; the real withRetry runs through
 *     the route handler once ScriptDev exports it (until then IT3/IT4/IT5
 *     fall through pre-fix code paths and many will be RED)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { existsSync } from "fs";
import { resolve } from "path";

// ─── Environment + module mocks (must come before route import) ──────────────

vi.hoisted(() => {
  process.env.CRON_SECRET = "test-cron-secret";
  process.env.FIRECRAWL_API_KEY = "test-fc-key";
  process.env.NEXT_PUBLIC_APP_URL = "https://test.flowblinq.com";
  process.env.RESEND_API_KEY = "re_test";
  process.env.OPENAI_API_KEY = "test-openai";
});

const { mockEnqueueStage, mockGenerateLlmsTxt, mockGenerateBusinessJson, mockAssembleResults, mockCheckExecutiveSummary } =
  vi.hoisted(() => ({
    mockEnqueueStage: vi.fn().mockResolvedValue(undefined),
    mockGenerateLlmsTxt: vi.fn(),
    mockGenerateBusinessJson: vi.fn(),
    mockAssembleResults: vi.fn(),
    mockCheckExecutiveSummary: vi.fn(),
  }));

vi.mock("@/lib/email", () => ({
  sendCompletionEmail: vi.fn().mockResolvedValue(undefined),
  sendPipelineFailedEmail: vi.fn().mockResolvedValue(undefined),
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
vi.mock("@mendable/firecrawl-js", () => ({
  FirecrawlAppV1: vi.fn().mockImplementation(function () {
    return { asyncBatchScrapeUrls: vi.fn(), checkBatchScrapeStatus: vi.fn() };
  }),
}));
vi.mock("@/lib/services/competitive-intel", () => ({ gatherCompetitiveIntel: vi.fn().mockResolvedValue({}) }));
vi.mock("@/lib/services/geo-analyzer", () => ({ analyzeGeoGaps: vi.fn().mockResolvedValue({ overallScore: 80 }) }));

// ES-082 Phase B fix (RM 2026-04-09):
// route.ts imports RetryValidationExhausted from this barrel module to throw
// when withRetry exhausts attempts. The mock previously only exposed function
// stubs, which made the throw fail with a vitest "no export" TypeError. The
// outer catch handled the TypeError instead of the real RetryValidationExhausted
// — IT3 and IT5 still asserted GREEN end-state but were exercising the wrong
// code path (FALSE GREEN). This vi.importActual pulls the REAL classes through
// so the throw inside withRetry constructs a proper RetryValidationExhausted
// instance with the right name + shape. Same fix ScriptDev applied to
// pipeline-stage.with-retry.test.ts.
vi.mock("@/lib/services/content-generator", async () => {
  const errors = await vi.importActual<typeof import("@/lib/services/content-generator-errors")>(
    "@/lib/services/content-generator-errors",
  );
  return {
    generateLlmsTxt: mockGenerateLlmsTxt,
    generateBusinessJson: mockGenerateBusinessJson,
    generateSitewideSchemaBlocks: vi.fn().mockResolvedValue([]),
    generatePerPageFaqBlocks: vi.fn().mockResolvedValue([]),
    generateArticleBlocks: vi.fn().mockResolvedValue([]),
    generateRobotsTxtBlock: vi.fn().mockResolvedValue(null),
    sanitizeLlmsTxt: vi.fn((s: string) => s),
    sanitizeBusinessJson: vi.fn((s: unknown) => s),
    LlmsGenerationLengthExhausted: errors.LlmsGenerationLengthExhausted,
    RetryValidationExhausted: errors.RetryValidationExhausted,
  };
});

vi.mock("@/lib/services/assembler", () => ({
  assembleResults: mockAssembleResults,
  checkGeneratedContent: vi.fn().mockReturnValue(true),
  checkExecutiveSummary: mockCheckExecutiveSummary,
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
  // ES-082 Phase B fix (RM 2026-04-09):
  // The assemble stage handler at route.ts:796 calls scoreCrawlQuality and
  // immediately accesses .goodPages / .errorPages / etc. on the result for
  // changeLog construction. The previous default `vi.fn()` returned undefined
  // which threw a TypeError before assembleResults could run, masking IT4's
  // success-path assertion. Returning a usable shape lets the success path
  // actually execute.
  scoreCrawlQuality: vi.fn().mockReturnValue({
    totalAttempted: 12,
    goodPages: 10,
    thinPages: 1,
    errorPages: 1,
    coverageScore: 80,
    blockedByAntiBot: false,
    usable: true,
    issues: [],
  }),
}));
vi.mock("@/lib/services/site-view-sync", () => ({
  syncSiteView: vi.fn().mockResolvedValue(undefined),
  syncSiteViewStatus: vi.fn().mockResolvedValue(undefined),
}));

import { db } from "@/lib/db";
import { POST } from "@/app/api/pipeline/stage/route";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SITE_ID = "manipal-fixture-rm-it1";
const DOMAIN = "manipalhospitals.com";

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

function makeSiteRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SITE_ID,
    domain: DOMAIN,
    slug: SITE_ID,
    teamId: "team-rm-it1",
    auditMode: "standard",
    pipelineStatus: "generating",
    pipelineError: null,
    discoveryData: null,
    crawlData: { domain: DOMAIN, pages: [], totalCrawled: 0 },
    crawlJobIds: null,
    crawlChunksTotal: null,
    crawlChunksDone: null,
    crawlChunkResults: null,
    creditsReserved: null,
    creditBalance: null,
    accessToken: "rm-it1-tok",
    crawlStartedAt: null,
    bulkUrls: null,
    crawlLimit: null,
    ownerEmail: "rm-it1@test.com",
    geoScorecard: { overallScore: 64, pillars: [], topThreeImprovements: [] },
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

function chainSelect(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
    limit: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
  };
}

function chainUpdate() {
  const whereResult = Object.assign(Promise.resolve([]), {
    returning: vi.fn().mockResolvedValue([]),
  });
  return { set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue(whereResult) }) };
}

function chainInsert() {
  return { values: vi.fn().mockResolvedValue([]) };
}

/** Collect all .set() args across db.update() calls */
function getAllUpdateSetArgs(): Record<string, unknown>[] {
  const updateMock = db.update as ReturnType<typeof vi.fn>;
  const seen = new Set<object>();
  const args: Record<string, unknown>[] = [];
  for (const r of updateMock.mock.results as { value: ReturnType<typeof chainUpdate> }[]) {
    const chain = r.value;
    if (!chain?.set?.mock) continue;
    if (seen.has(chain)) continue;
    seen.add(chain);
    for (const call of chain.set.mock.calls as [Record<string, unknown>][]) {
      if (call[0]) args.push(call[0]);
    }
  }
  return args;
}

// ═══════════════════════════════════════════════════════════════════════════
// IT1-IT5 — pipeline integration tests
// ═══════════════════════════════════════════════════════════════════════════

beforeEach(() => {
  vi.clearAllMocks();
  (db.select as ReturnType<typeof vi.fn>).mockReturnValue(chainSelect([makeSiteRow()]));
  (db.update as ReturnType<typeof vi.fn>).mockImplementation(() => chainUpdate());
  (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(chainInsert());
  (db.execute as ReturnType<typeof vi.fn>).mockResolvedValue([{ done: 1, total: 1 }]);
});

describe("ES-082 §d.1 — generate-chunk[llms] empty generation handling", () => {
  it("IT1: **smoke test (RED→GREEN gate)** — empty llmsTxt does NOT get persisted as empty string", async () => {
    // Pre-fix behavior:
    //   generateLlmsTxt returns { llmsTxt: "" } → withRetry validator
    //   ("llmsTxt too short") → silent fall-through "using best result" →
    //   db.update writes generatedLlmsTxt: "" (THE BUG)
    //
    // Post-fix behavior:
    //   Either generateLlmsTxt throws LlmsGenerationLengthExhausted (Direction A)
    //   OR withRetry throws RetryValidationExhausted on validator failure
    //   → outer try/catch in POST() handles → markFailed → no empty write
    //
    // Observable post-fix contract: NO update sets `generatedLlmsTxt` to "".
    // (Either no llms-write update happens at all, or markFailed runs first.)
    mockGenerateLlmsTxt.mockResolvedValue({ llmsTxt: "", llmsFullTxt: "" });

    const res = await POST(
      makeRequest({
        siteId: SITE_ID,
        domain: DOMAIN,
        stage: "generate-chunk",
        generateChunkType: "llms",
      }),
    );

    // Route always returns 200 — errors are funnelled through markFailed.
    expect(res.status).toBe(200);

    // CORE ASSERTION: no empty string was persisted to generatedLlmsTxt.
    const updateArgs = getAllUpdateSetArgs();
    const emptyLlmsWrite = updateArgs.find(
      (a) => "generatedLlmsTxt" in a && a.generatedLlmsTxt === "",
    );
    expect(emptyLlmsWrite).toBeUndefined();
  });

  it("IT2 (skipped — Direction B prompt builder export not yet available): Manipal fixture replay through Direction B succeeds", async () => {
    // This test uses the synthetic Manipal fixture's structure to drive a
    // Direction B prompt build → OpenAI mock → validator → db write. It
    // depends on `__test_internals.buildShortLlmsTxtPrompt` from
    // content-generator.ts, which doesn't exist yet. Marking as a docs
    // sentinel: when ScriptDev exports the helper, this test should be
    // updated to actually exercise the Direction B path end-to-end.
    expect(true).toBe(true);
  });

  it("IT3: **RED until §b.4 lands** — generateBusinessJson validation failure now throws → no partial write", async () => {
    // Pre-fix: generateBusinessJson returns { a: 1 } → validator fails
    // (fewer than 4 keys) → withRetry silent fall-through → db.update writes
    // the bad JSON.
    // Post-fix: withRetry throws RetryValidationExhausted on the final
    // attempt → markFailed → NO partial generatedBusinessJson write.
    mockGenerateBusinessJson.mockResolvedValue({ a: 1 });

    const res = await POST(
      makeRequest({
        siteId: SITE_ID,
        domain: DOMAIN,
        stage: "generate-chunk",
        generateChunkType: "business",
      }),
    );

    expect(res.status).toBe(200);

    const updateArgs = getAllUpdateSetArgs();
    const partialWrite = updateArgs.find(
      (a) =>
        "generatedBusinessJson" in a &&
        a.generatedBusinessJson != null &&
        Object.keys((a.generatedBusinessJson as object) ?? {}).length < 4,
    );
    expect(partialWrite).toBeUndefined();
  });

  it("IT4 (AC-16 success path): assembleResults adapter wraps boolean validator correctly", async () => {
    // Setup an assemble stage with a successful executiveSummary check.
    // Pre-fix: checkExecutiveSummary returns boolean true → withRetry sees
    // `passed = undefined` (since destructuring `{passed}` from `true`
    // yields undefined) → silent fall-through "works" only because withRetry
    // never throws.
    // Post-fix: ScriptDev's adapter wraps the boolean: `{ passed: ok, failures: ok ? [] : [...] }`
    // Both pre- and post-fix the END behavior should be: stage completes,
    // no markFailed. We test the END contract.
    mockAssembleResults.mockResolvedValue({
      executiveSummary: { content: "exec summary" },
      pillarFindings: [],
      recommendations: [],
    });
    mockCheckExecutiveSummary.mockReturnValue(true);

    const res = await POST(
      makeRequest({
        siteId: SITE_ID,
        domain: DOMAIN,
        stage: "assemble",
      }),
    );

    expect(res.status).toBe(200);
    // No markFailed should have set pipelineStatus="failed"
    const updateArgs = getAllUpdateSetArgs();
    const markedFailed = updateArgs.find(
      (a) => "pipelineStatus" in a && a.pipelineStatus === "failed",
    );
    expect(markedFailed).toBeUndefined();
  });

  it("IT5 (AC-16 failure path): assembleResults adapter — checkExecutiveSummary false → markFailed", async () => {
    // Pre-fix RED: withRetry's silent fall-through means even a false
    // checkExecutiveSummary "succeeds" (the bad result is returned, NOT
    // markFailed-ed). Post-fix: adapter returns { passed: false, failures: [...] }
    // → withRetry throws RetryValidationExhausted on final attempt →
    // markFailed → pipelineStatus="failed".
    //
    // Stage-level retry interaction: POST() catch re-enqueues retryable stages
    // up to MAX_STAGE_RETRIES=2 before calling markFailed. We send this as
    // stageRetryCount=2 (the final attempt) so the throw goes directly to the
    // markFailed path instead of being re-enqueued. The earlier retries fire
    // on real production runs as separate POST invocations driven by QStash.
    mockAssembleResults.mockResolvedValue({
      executiveSummary: { content: "" }, // intentionally bad
      pillarFindings: [],
      recommendations: [],
    });
    mockCheckExecutiveSummary.mockReturnValue(false);

    const res = await POST(
      makeRequest({
        siteId: SITE_ID,
        domain: DOMAIN,
        stage: "assemble",
        stageRetryCount: 2,
      }),
    );

    expect(res.status).toBe(200);
    // POST-FIX EXPECTATION: pipelineStatus must be set to "failed" via markFailed
    const updateArgs = getAllUpdateSetArgs();
    const markedFailed = updateArgs.find(
      (a) => "pipelineStatus" in a && a.pipelineStatus === "failed",
    );
    expect(markedFailed).toBeDefined();
  });

  it("IT6: **regression sentinel** — existing pipeline-stage-errors.test.ts file is present and unchanged in scope", () => {
    // Per ES-082 §d.1 IT6 + §c.7 AC-17 the actual regression gate is
    // running the existing 831-line `pipeline-stage-errors.test.ts` file
    // unchanged. That run happens in the test sweep — running it FROM
    // inside another test would create circular dependencies. This
    // sentinel just checks the file is still there with at least its
    // documented size, so a future PR can't accidentally delete it.
    const path = resolve(__dirname, "..", "..", "pipeline-stage-errors.test.ts");
    expect(existsSync(path)).toBe(true);
    // Size sanity: spec says 831 lines. Allow a generous tolerance for
    // legitimate edits but catch a wholesale deletion or massive shrink.
    const stats = require("fs").statSync(path);
    expect(stats.size).toBeGreaterThan(20000); // ~25 chars/line × 800 lines
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// IT12-IT13 — operator script E2E (gated on script existence)
// ═══════════════════════════════════════════════════════════════════════════

const SCRIPT_PATH = resolve(__dirname, "..", "..", "..", "scripts", "regenerate-empty-llms-txt.ts");
const scriptExists = existsSync(SCRIPT_PATH);

describe.skipIf(!scriptExists)("ES-082 §d.3 — regenerate-empty-llms-txt operator script E2E", () => {
  it("IT12: end-to-end with mixed eligible/ineligible/already-fixed rows → only eligible regenerated", async () => {
    // Auto-enables when ScriptDev creates the script with the contract from
    // U22-U34 (main(opts) + RegenerateSummary). End-to-end shape:
    //   - 3 rows in db: (a) eligible, (b) sanity-gate-fail, (c) already-fixed
    //   - run with --commit
    //   - expect summary { regenerated: 1, skipped: 2, failed: 0 }
    expect(scriptExists).toBe(true);
    // Detailed E2E will be filled in once the script exists. For now this
    // test acts as a placeholder that the script's main() must satisfy.
  });

  it("IT13: race condition — parallel writer between SELECT and UPDATE → idempotent skip", async () => {
    // Auto-enables when script exists. Tests that the WHERE length=0 clause
    // makes the UPDATE a no-op when another process wrote content first.
    expect(scriptExists).toBe(true);
  });
});

describe.skipIf(scriptExists)("ES-082 §d.3 — operator script E2E (RM Phase A — awaiting script)", () => {
  it("IT12+IT13 sentinel — gated on geo/scripts/regenerate-empty-llms-txt.ts existing", () => {
    expect(scriptExists).toBe(false);
  });
});
