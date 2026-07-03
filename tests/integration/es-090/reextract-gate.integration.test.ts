/**
 * ES-090 IT9 — Cluster-safe reextract counter.
 *
 * 6 concurrent acquire calls across 2 simulated workers; assert global counter
 * never exceeds CAP=3.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeDb } from "./_setup";

beforeAll(() => { /* requires UPSTASH_REDIS_REST_URL/TOKEN */ });
afterAll(async () => { await closeDb(); });

describe("ES-090 IT9 — reextract gate cluster-safe", () => {
  it("6 parallel acquires; counter never exceeds 3; ≥3 acquired, ≥3 rejected", async () => {
    const mod = await import("@/lib/concurrency/reextract-gate");
    const { tryAcquireReextractSlot, __test_internals } = mod;
    await __test_internals.setCount(0);

    let observedMax = 0;
    const acquired: Array<Awaited<ReturnType<typeof tryAcquireReextractSlot>>> = [];

    const acquireOne = async () => {
      const r = await tryAcquireReextractSlot();
      if (r) acquired.push(r);
      const c = await __test_internals.getCount();
      observedMax = Math.max(observedMax, c);
    };

    await Promise.all(Array.from({ length: 6 }, () => acquireOne()));

    expect(observedMax).toBeLessThanOrEqual(3);
    expect(acquired.length).toBeLessThanOrEqual(3);
    expect(acquired.length).toBeGreaterThanOrEqual(3);

    // Cleanup — release acquired slots.
    for (const r of acquired) {
      if (r) await r();
    }
    expect(await __test_internals.getCount()).toBe(0);
  }, 30_000);
});
