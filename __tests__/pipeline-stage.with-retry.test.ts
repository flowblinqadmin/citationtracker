/**
 * ES-082 Phase A — pipeline-stage.with-retry tests (U15-U21)
 *
 * Author:   ReviewMaster (Agent 9)
 * Date:     2026-04-09
 * Spec:     geo/docs/specs/engineering/ES-082-llms-txt-empty-generation-fix.md (§c.2, §b.4)
 *
 * U17 is the LOAD-BEARING RED test in this file:
 *   it asserts withRetry({maxAttempts:1}) THROWS RetryValidationExhausted on
 *   validator failure. Today withRetry returns the failing result silently
 *   ("using best result" path at route.ts:165), so this test will be RED
 *   until ScriptDev's fix lands.
 *
 * Required ScriptDev exports for these tests to even compile-run:
 *   - `withRetry`                (currently module-private at route.ts:148)
 *   - `RetryValidationExhausted` (re-exported from content-generator.ts per §b.1)
 *
 * Suggested approach: ScriptDev adds a test-internals named export OR
 * promotes withRetry to a regular export when restructuring the file in
 * Direction A. ReviewMaster's test file uses a namespace import with optional
 * access so the file LOADS even when the export is missing — but the
 * dependent tests will fail (RED) at runtime, not at import time.
 *
 * Separate file from `pipeline-stage-errors.test.ts` per ES-082 §c.2 to
 * avoid merge friction with the existing 831-line file.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Environment + module mocks ───────────────────────────────────────────────
//
// Loading `app/api/pipeline/stage/route.ts` pulls in lib/email.ts which
// constructs `new Resend(process.env.RESEND_API_KEY!)` at module load. We
// must satisfy that BEFORE the import resolves. We also mock the broader
// transitive dependency tree so the namespace import is side-effect-free
// (matches the same hoisted-mock pattern as pipeline-stage-errors.test.ts).

vi.hoisted(() => {
  process.env.CRON_SECRET = "test-cron-secret";
  process.env.FIRECRAWL_API_KEY = "test-fc-key";
  process.env.NEXT_PUBLIC_APP_URL = "https://test.flowblinq.com";
  process.env.RESEND_API_KEY = "re_test";
  process.env.OPENAI_API_KEY = "test-openai";
});

vi.mock("@/lib/email", () => ({
  sendCompletionEmail: vi.fn().mockResolvedValue(undefined),
  sendPipelineFailedEmail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/db", () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), execute: vi.fn() },
}));
vi.mock("@/lib/qstash", () => ({ enqueueStage: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@mendable/firecrawl-js", () => ({
  FirecrawlAppV1: vi.fn().mockImplementation(function () {
    return { asyncBatchScrapeUrls: vi.fn(), checkBatchScrapeStatus: vi.fn() };
  }),
}));
vi.mock("nanoid", () => ({ nanoid: vi.fn().mockReturnValue("mock-id") }));
vi.mock("@/lib/services/competitive-intel", () => ({ gatherCompetitiveIntel: vi.fn().mockResolvedValue({}) }));
vi.mock("@/lib/services/geo-analyzer", () => ({ analyzeGeoGaps: vi.fn().mockResolvedValue({ overallScore: 80 }) }));
// ES-082: route.ts imports RetryValidationExhausted from this barrel module
// to throw when withRetry exhausts attempts. Pull the REAL class through so
// the throw inside withRetry actually constructs an instance with the right
// name and shape — vi.importActual sidesteps the module-mock replacement.
vi.mock("@/lib/services/content-generator", async () => {
  const errors = await vi.importActual<typeof import("@/lib/services/content-generator-errors")>(
    "@/lib/services/content-generator-errors",
  );
  return {
    generateLlmsTxt: vi.fn(),
    generateBusinessJson: vi.fn(),
    generateSitewideSchemaBlocks: vi.fn(),
    generatePerPageFaqBlocks: vi.fn(),
    generateArticleBlocks: vi.fn(),
    generateRobotsTxtBlock: vi.fn(),
    sanitizeLlmsTxt: vi.fn((s: string) => s),
    sanitizeBusinessJson: vi.fn((s: unknown) => s),
    LlmsGenerationLengthExhausted: errors.LlmsGenerationLengthExhausted,
    RetryValidationExhausted: errors.RetryValidationExhausted,
  };
});
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

import * as stageRoute from "@/app/api/pipeline/stage/route";

// withRetry is currently module-private. After ScriptDev's Direction A fix
// lands, it should be exported from route.ts. The namespace-import + optional
// access pattern lets this test file LOAD even when the export is missing —
// the dependent tests then fail at runtime with a clear error.
type CheckResult = { passed: boolean; failures: string[] };
type WithRetryFn = <T>(
  label: string,
  fn: () => Promise<T>,
  check: (result: T) => CheckResult,
  maxAttempts?: number,
) => Promise<T>;

const withRetry: WithRetryFn | undefined =
  (stageRoute as unknown as { withRetry?: WithRetryFn }).withRetry;

// We deliberately do NOT import RetryValidationExhausted from
// content-generator at file load time — vitest's strict mock validation
// would block the namespace access since the export doesn't exist yet.
// Instead, instanceof checks are replaced with name-based assertions
// (`error.name === "RetryValidationExhausted"`), which is robust to module
// identity issues and works regardless of whether the class exists yet.
const isRetryValidationExhausted = (e: unknown): boolean =>
  e instanceof Error && e.name === "RetryValidationExhausted";

beforeEach(() => {
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
// §c.2 — withRetry unified throw semantics (U15-U21)
// ═══════════════════════════════════════════════════════════════════════════

describe("ES-082 §c.2 — withRetry unified throw semantics (RM independent)", () => {
  it("U15: returns result on first-attempt success (no retry, single fn() call)", async () => {
    if (!withRetry) throw new Error("withRetry export missing — ScriptDev must export it from route.ts");

    const fn = vi.fn().mockResolvedValue({ kind: "good", value: 42 });
    const check = vi.fn().mockReturnValue({ passed: true, failures: [] });

    const result = await withRetry("test-u15", fn, check, 3);

    expect(result).toEqual({ kind: "good", value: 42 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("U16: returns result after one retry (first fail, second pass)", async () => {
    if (!withRetry) throw new Error("withRetry export missing");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fn = vi
      .fn()
      .mockResolvedValueOnce({ kind: "bad" })
      .mockResolvedValueOnce({ kind: "good" });
    const check = vi
      .fn()
      .mockReturnValueOnce({ passed: false, failures: ["too short on attempt 1"] })
      .mockReturnValueOnce({ passed: true, failures: [] });

    const result = await withRetry("test-u16", fn, check, 3);

    expect(result).toEqual({ kind: "good" });
    expect(fn).toHaveBeenCalledTimes(2);
    // The "passed on attempt 2" warn should fire per route.ts:159.
    const warnTexts = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnTexts.some((t) => /passed on attempt 2/.test(t))).toBe(true);

    warnSpy.mockRestore();
  });

  it("U17: **RED until fix** — withRetry({maxAttempts:1}) THROWS RetryValidationExhausted on validator failure (no silent fallthrough)", async () => {
    // ES-082 §c.2 + §b.4 (load-bearing): the silent "using best result"
    // fall-through at route.ts:165-166 is the root cause of the Manipal data
    // corruption. This test pins the post-fix contract:
    //   - withRetry must REJECT (not resolve) when the validator fails on
    //     the final attempt, regardless of maxAttempts (1 included).
    //   - The thrown error must be a RetryValidationExhausted instance
    //     carrying { label, attempts, failures }.
    //
    // Pre-fix: withRetry resolves with the failing result. .rejects.toThrow()
    // fails because the promise resolved successfully → RED.
    // Post-fix: .rejects.toThrow() passes → GREEN.
    if (!withRetry) throw new Error("withRetry export missing");

    const fn = vi.fn().mockResolvedValue({ kind: "bad", llmsTxt: "" });
    const check = vi.fn().mockReturnValue({ passed: false, failures: ["too short"] });

    await expect(withRetry("u17-label", fn, check, 1)).rejects.toThrow();

    // Detailed shape assertion: the thrown error must include label, attempts,
    // and failures from the LAST attempt.
    let caught: any;
    try {
      await withRetry("u17-label", fn, check, 1);
    } catch (e) {
      caught = e;
    }
    expect(isRetryValidationExhausted(caught)).toBe(true);
    expect(caught.label).toBe("u17-label");
    expect(caught.attempts).toBe(1);
    expect(caught.failures).toEqual(["too short"]);
    // fn must have been called exactly once (single attempt, no retries)
    expect(fn).toHaveBeenCalledTimes(2); // 1 from .rejects.toThrow + 1 from try/catch
  });

  it("U18: throws RetryValidationExhausted after maxAttempts:3 exhausted", async () => {
    if (!withRetry) throw new Error("withRetry export missing");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fn = vi.fn().mockResolvedValue({ kind: "bad" });
    const check = vi.fn().mockReturnValue({ passed: false, failures: ["always-fail"] });

    let caught: any;
    try {
      await withRetry("u18-label", fn, check, 3);
    } catch (e) {
      caught = e;
    }

    expect(isRetryValidationExhausted(caught)).toBe(true);
    expect(caught.attempts).toBe(3);
    expect(fn).toHaveBeenCalledTimes(3);

    warnSpy.mockRestore();
  });

  it("U19: throws after maxAttempts:2 exhausted", async () => {
    if (!withRetry) throw new Error("withRetry export missing");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fn = vi.fn().mockResolvedValue({ kind: "bad" });
    const check = vi.fn().mockReturnValue({ passed: false, failures: ["fail-2"] });

    let caught: any;
    try {
      await withRetry("u19-label", fn, check, 2);
    } catch (e) {
      caught = e;
    }

    expect(isRetryValidationExhausted(caught)).toBe(true);
    expect(caught.attempts).toBe(2);
    expect(fn).toHaveBeenCalledTimes(2);

    warnSpy.mockRestore();
  });

  it("U20: each retry waits the documented backoff (≥1000 ms × attempt)", async () => {
    if (!withRetry) throw new Error("withRetry export missing");

    // Use real timers but a mocked timing source. We capture wall-clock
    // deltas around the second invocation to confirm the backoff fired.
    // Avoiding fake timers here because they interact poorly with the
    // promise-based delay in route.ts:163.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const callTimes: number[] = [];
    const fn = vi
      .fn<() => Promise<{ kind: string }>>()
      .mockImplementation(async () => {
        callTimes.push(Date.now());
        return { kind: "bad" };
      });
    const check = vi
      .fn()
      .mockReturnValueOnce({ passed: false, failures: ["a"] })
      .mockReturnValueOnce({ passed: true, failures: [] });

    await withRetry("u20-label", fn, check, 3);

    expect(callTimes.length).toBeGreaterThanOrEqual(2);
    const delta = callTimes[1] - callTimes[0];
    // route.ts:163 awaits `1000 * attempt` ms before the next attempt.
    // First failure → 1000 ms backoff. Allow 50 ms slop for scheduler jitter.
    expect(delta).toBeGreaterThanOrEqual(950);

    warnSpy.mockRestore();
  }, 10000);

  it("U21: thrown error carries failures from the FINAL attempt only (not aggregated)", async () => {
    if (!withRetry) throw new Error("withRetry export missing");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fn = vi.fn().mockResolvedValue({ kind: "bad" });
    const check = vi
      .fn()
      .mockReturnValueOnce({ passed: false, failures: ["a"] })
      .mockReturnValueOnce({ passed: false, failures: ["b", "c"] });

    let caught: any;
    try {
      await withRetry("u21-label", fn, check, 2);
    } catch (e) {
      caught = e;
    }

    expect(isRetryValidationExhausted(caught)).toBe(true);
    expect(caught.failures).toEqual(["b", "c"]);
    // Specifically, "a" must NOT appear in the final failures list.
    expect(caught.failures).not.toContain("a");

    warnSpy.mockRestore();
  });
});
