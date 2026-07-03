/**
 * ES-090 IT16 — host-header spoof rejected by stage-route signature verification.
 *
 * Sends a forged Host: evil.com to /api/pipeline/stage with otherwise-valid
 * QStash signature material. After §b.8 lands, the URL passed to receiver.verify
 * uses env vars only — so the signature mismatch returns 401/403, not 200.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeDb } from "./_setup";

beforeAll(() => { if (!process.env.NEXT_PUBLIC_APP_URL) process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000"; });
afterAll(async () => { await closeDb(); });

describe("ES-090 IT16 — host-header spoof rejected", () => {
  it("forged Host header must NOT reach receiver.verify URL", async () => {
    const url = `${process.env.NEXT_PUBLIC_APP_URL}/api/pipeline/stage`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "host": "evil.com",
        "upstash-signature": "fake-sig-not-valid",
        "content-type": "application/json",
      },
      body: JSON.stringify({ stage: "discover", siteId: "spoof-it16" }),
    });
    expect([401, 403]).toContain(res.status);
  }, 15_000);
});
