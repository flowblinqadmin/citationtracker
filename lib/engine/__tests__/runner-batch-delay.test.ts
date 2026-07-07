/**
 * R31 — inter-batch throttle: TRACKER_BATCH_DELAY_MS is applied between batches.
 *
 * Uses fake timers so no real wall-clock time elapses in CI.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TRACKER_BATCH_DELAY_MS } from "@/lib/config";

// ── DB mock ───────────────────────────────────────────────────────────────────
// We return just enough to let executeTrackerRun proceed without a real DB.
// The runner makes these calls in order:
//   1. db.select trackerRuns (run row)
//   2. db.update trackerRuns (mark running)
//   3. db.select trackerClients (client row)
//   4. db.select trackerArticles (articles list)
//   5. db.select trackerResponses (existing rows — resume guard)
//   6. db.transaction × N (response + citations per work item)
//   7. db.update trackerRuns (mark complete)
//
// We use a selectCallN counter per test invocation; the counter is reset in a
// beforeEach via a module-level reset function.

let selectCallN = 0;

vi.mock("@/lib/db", () => {
  return {
    db: {
      select: () => ({
        from: () => ({
          where: () => {
            selectCallN++;
            if (selectCallN === 1) {
              // trackerRuns → return a pending run row
              return Promise.resolve([{
                id: "fake-run-id",
                status: "pending",
                startedAt: null,
                modelsUsed: {},
              }]);
            }
            if (selectCallN === 2) {
              // trackerClients → return a client
              return Promise.resolve([{
                id: "fake-client",
                domain: "client.com",
                brandKeywords: null,
                competitors: [],
              }]);
            }
            // trackerArticles (3rd) and trackerResponses (4th) → empty
            return Promise.resolve([]);
          },
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => Promise.resolve(),
        }),
      }),
      transaction: async (fn: (tx: any) => Promise<any>) => {
        const tx = {
          insert: () => ({
            values: () => ({
              onConflictDoNothing: () => ({
                returning: () => Promise.resolve([{ id: `resp-${Math.random()}` }]),
              }),
            }),
          }),
        };
        return fn(tx);
      },
    },
  };
});

// ── run-create mock ───────────────────────────────────────────────────────────
// 11 prompt versions → worklist = 11 × 3 = 33 items → ≥ 3 inter-batch sleeps.
vi.mock("@/lib/engine/run-create", () => ({
  getActivePromptVersions: async () =>
    Array.from({ length: 11 }, (_, i) => ({
      promptVersionId: `pv_${String(i).padStart(2, "0")}`,
      text: `prompt ${i}`,
      version: 1,
    })),
}));

// ── run-metrics mock ──────────────────────────────────────────────────────────
vi.mock("@/lib/engine/run-metrics", () => ({
  recomputeAndStoreRunMetrics: async () => {},
}));

// ── url-matcher mock ──────────────────────────────────────────────────────────
vi.mock("@/lib/engine/url-matcher", () => ({
  buildMatchContext: () => ({}),
  matchCitation: () => ({ matchType: "unmatched", normalizedUrl: "x", domain: "x" }),
  resolveRedirects: async (u: string) => u,
  isBrandMentioned: () => false,
}));

// ── citation-checker mock ─────────────────────────────────────────────────────
vi.mock("@/lib/engine/providers", () => ({
  queryOpenAI: async () => ({ text: "", responseTimeMs: 1, citedUrls: [] }),
  queryPerplexity: async () => ({ text: "", responseTimeMs: 1, citedUrls: [] }),
  queryGoogle: async () => ({ text: "", responseTimeMs: 1, citedUrls: [] }),
  queryAnthropic: async () => ({ text: "", responseTimeMs: 1, citedUrls: [] }),
  MODELS: { openai: "gpt-4o-mini", perplexity: "pplx-online", google: "gemini-2.0-flash", anthropic: "claude-haiku-4-5" },
}));

// ─────────────────────────────────────────────────────────────────────────────

describe("R31 — runner inter-batch throttle", () => {
  beforeEach(() => {
    selectCallN = 0;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("TRACKER_BATCH_DELAY_MS is a positive finite number exported from lib/config", () => {
    expect(typeof TRACKER_BATCH_DELAY_MS).toBe("number");
    expect(Number.isFinite(TRACKER_BATCH_DELAY_MS)).toBe(true);
    expect(TRACKER_BATCH_DELAY_MS).toBeGreaterThan(0);
  });

  it("setTimeout is called with TRACKER_BATCH_DELAY_MS between batches", async () => {
    const { executeTrackerRun } = await import("@/lib/engine/runner");

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    // Zero-citation providers (no attempt-2 triggered) to keep the execution simple.
    const stubQuery = async () => ({ text: "", responseTimeMs: 1, citedUrls: [] as string[] });
    const deps = {
      queryFns: { perplexity: stubQuery, openai: stubQuery, google: stubQuery },
      resolveRedirectsFn: async (u: string) => u,
    };

    // Start the run — it will block on the first inter-batch setTimeout.
    const runPromise = executeTrackerRun(
      "fake-run-id",
      "fake-client",
      0,
      Date.now() + 10_000_000,
      () => Date.now(),
      deps as any,
    );

    // Advance fake timers to drain all pending setTimeout calls.
    await vi.runAllTimersAsync();
    await runPromise;

    // Verify that setTimeout was called with exactly TRACKER_BATCH_DELAY_MS.
    // With 11 pvs × 3 platforms = 33 items and TRACKER_BATCH_SIZE=10 →
    // batches at i=0,10,20,30 → 3 inter-batch sleeps.
    const delayedCalls = setTimeoutSpy.mock.calls.filter(
      ([_fn, ms]) => ms === TRACKER_BATCH_DELAY_MS,
    );
    expect(
      delayedCalls.length,
      `expected at least 1 setTimeout(resolve, ${TRACKER_BATCH_DELAY_MS}) call`,
    ).toBeGreaterThanOrEqual(1);

    setTimeoutSpy.mockRestore();
  });
});
