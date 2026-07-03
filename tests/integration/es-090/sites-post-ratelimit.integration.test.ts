/**
 * ES-090 IT5, IT6 — sites-POST IP rate limit + bulk path unaffected.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeDb } from "./_setup";

beforeAll(() => { if (!process.env.NEXT_PUBLIC_APP_URL) process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000"; });
afterAll(async () => { await closeDb(); });

describe("ES-090 IT5 — POST /api/sites IP rate limit", () => {
  it("15 parallel single-audit POSTs from same IP → 10×200, 5×429", async () => {
    const ip = "203.0.113.99";
    const url = `${process.env.NEXT_PUBLIC_APP_URL}/api/sites`;
    const calls = Array.from({ length: 15 }, (_, i) =>
      fetch(url, {
        method: "POST",
        headers: { "x-forwarded-for": ip, "content-type": "application/json" },
        body: JSON.stringify({ url: `https://it5-${i}.example.test`, email: `it5+${i}@example.test` }),
      }),
    );
    const responses = await Promise.all(calls);
    const ok = responses.filter((r) => r.status === 200).length;
    const blocked = responses.filter((r) => r.status === 429).length;
    expect(ok).toBe(10);
    expect(blocked).toBe(5);
  }, 60_000);
});

describe("ES-090 IT6 — bulk POST not blocked by IP limit", () => {
  it("bulk audit succeeds even after IP cooldown", async () => {
    const ip = "203.0.113.100";
    const url = `${process.env.NEXT_PUBLIC_APP_URL}/api/sites`;

    // First exhaust the IP bucket with single POSTs.
    await Promise.all(Array.from({ length: 11 }, (_, i) =>
      fetch(url, {
        method: "POST",
        headers: { "x-forwarded-for": ip, "content-type": "application/json" },
        body: JSON.stringify({ url: `https://it6-${i}.example.test`, email: `it6+${i}@example.test` }),
      }),
    ));

    // Now a bulk POST from the same IP — should NOT 429.
    const bulk = await fetch(url, {
      method: "POST",
      headers: { "x-forwarded-for": ip, "content-type": "application/json" },
      body: JSON.stringify({
        bulkUrls: Array.from({ length: 12 }, (_, i) => `https://it6bulk-${i}.example.test`),
        email: "it6+bulk@example.test",
      }),
    });
    expect(bulk.status).not.toBe(429);
  }, 60_000);
});
