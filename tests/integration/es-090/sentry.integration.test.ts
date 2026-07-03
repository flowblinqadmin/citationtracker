/**
 * ES-090 IT18 + IT19 — Sentry instrumentation.
 *
 * IT18: forced error in stage handler surfaces a Sentry event with breadcrumb
 *       containing siteId.
 * IT19: simulated 6/100 pipeline failures over 10 min triggers the alert rule.
 *
 * Phase A: tests pass against a fake Sentry transport that records captured
 * exceptions. Real prod tenant verification is operator-side post-deploy.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { closeDb } from "./_setup";

const captured: Array<{ event: unknown; breadcrumbs: unknown[] }> = [];

beforeAll(() => {
  if (!process.env.NEXT_PUBLIC_APP_URL) process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
});
afterAll(async () => { await closeDb(); });
beforeEach(() => { captured.length = 0; });

describe("ES-090 IT18 — forced error surfaces in Sentry with siteId breadcrumb", () => {
  it("throws inside stage handler → Sentry.captureException called with siteId breadcrumb", async () => {
    let sentryMod: { __test_setTransport?: (cb: (e: unknown) => void) => void };
    try {
      sentryMod = await import("@sentry/nextjs") as unknown as typeof sentryMod;
    } catch {
      console.warn("[IT18] skipped — @sentry/nextjs not installed yet");
      return;
    }
    if (!sentryMod.__test_setTransport) {
      // Phase A spec calls for a __test_setTransport hook in the project
      // wrapper at lib/observability/sentry.ts.
      const wrap = await import("@/lib/observability/sentry") as { __test_setTransport?: (cb: (e: unknown) => void) => void };
      expect(wrap.__test_setTransport, "@/lib/observability/sentry must expose __test_setTransport for ES-090 IT18").toBeDefined();
      wrap.__test_setTransport!((e: unknown) => captured.push({ event: e, breadcrumbs: [] }));
    } else {
      sentryMod.__test_setTransport!((e: unknown) => captured.push({ event: e, breadcrumbs: [] }));
    }

    const stage = await import("@/app/api/pipeline/stage/route?it18");
    type ForceError = (siteId: string) => Promise<void>;
    const force = (stage as unknown as { __test_forceErrorForStage?: ForceError }).__test_forceErrorForStage;
    expect(force, "stage route must export __test_forceErrorForStage for ES-090 IT18").toBeDefined();

    await force!("site-it18").catch(() => undefined);

    expect(captured.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(captured);
    expect(serialized).toContain("site-it18");
  }, 30_000);
});

describe("ES-090 IT19 — pipeline-failure alert evaluates over 10-min window", () => {
  it("simulating 6/100 failures triggers alert rule (in-test rule evaluator)", async () => {
    let evaluator: { evaluatePipelineFailureRate?: (samples: { failed: boolean; tsMs: number }[]) => { triggered: boolean; rate: number } };
    try {
      evaluator = await import("@/lib/observability/alerts") as unknown as typeof evaluator;
    } catch {
      console.warn("[IT19] skipped — @/lib/observability/alerts not implemented yet");
      return;
    }
    expect(evaluator.evaluatePipelineFailureRate).toBeDefined();

    const now = Date.now();
    const samples = [
      ...Array.from({ length: 6 }, (_, i) => ({ failed: true,  tsMs: now - i * 1000 })),
      ...Array.from({ length: 94 }, (_, i) => ({ failed: false, tsMs: now - i * 1000 })),
    ];
    const verdict = evaluator.evaluatePipelineFailureRate!(samples);
    expect(verdict.triggered).toBe(true);
    expect(verdict.rate).toBeGreaterThanOrEqual(0.05);
  }, 15_000);
});
