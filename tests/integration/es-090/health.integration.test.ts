/**
 * ES-090 IT11 + IT12 — /api/health public + DB-down 503.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeDb } from "./_setup";

beforeAll(() => { if (!process.env.NEXT_PUBLIC_APP_URL) process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000"; });
afterAll(async () => { await closeDb(); });

describe("ES-090 IT11 — /api/health reachable unauthenticated", () => {
  it("GET /api/health without cookies → 200", async () => {
    const res = await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; db: string; version?: string };
    expect(body.ok).toBe(true);
    expect(body.db).toBe("ok");
  }, 15_000);
});

describe("ES-090 IT12 — /api/health returns 503 when DB unreachable", () => {
  it("with DB shut down → 503 + { ok:false, db:'fail' }", async () => {
    // Operator must stop the Postgres container BEFORE this test — we cannot
    // safely stop the DB from inside the test process. Tests that require DB
    // teardown should be tagged for the manual-only IT tier.
    if (!process.env.ES090_DB_DOWN_PROBE) {
      // Skip when the operator has not signaled the failure injection.
      console.warn("[IT12] skipped — set ES090_DB_DOWN_PROBE=1 + stop Postgres before running");
      return;
    }
    const res = await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/health`);
    expect(res.status).toBe(503);
    const body = await res.json() as { ok: boolean; db: string };
    expect(body.ok).toBe(false);
    expect(body.db).toBe("fail");
  }, 15_000);
});
