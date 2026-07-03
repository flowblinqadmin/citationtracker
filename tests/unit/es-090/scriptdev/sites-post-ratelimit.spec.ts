/**
 * ES-090 Phase 1 (ScriptDev) — CRIT-4 sites-POST rate-limit.
 *
 * ChangedSpec §b.5 — insert in single-audit flow:
 *
 *   const rl = await checkRateLimit(`sites_create:${ip}`, 10, 60_000);
 *   if (!rl.allowed) return 429 + Retry-After + retryAfterMs;
 *
 * Spec-critical invariants:
 * - Bulk path (bulkUrls branch) returns BEFORE this guard — unguarded.
 * - Key is `sites_create:${ip}`, NOT `sites_create:${email}`. IP-keyed.
 * - Unknown IP becomes the literal string "unknown" (shared bucket — spec
 *   accepts this; see U26 in ChangedSpec §c.4).
 *
 * U23-U26 equivalents:
 * - U23  10 single-audit calls from same IP in 60s all pass
 * - U24  11th returns 429 (covered here by mocking checkRateLimit → allowed:false
 *        rather than driving 11 real calls)
 * - U25  bulk POST is NOT blocked by IP limit (bulk path exits before guard)
 * - U26  unknown IP keyed as "unknown"
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    })),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    }),
  },
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/email", () => ({
  generateVerificationCode: vi.fn().mockReturnValue("123456"),
  hashCode: vi.fn().mockReturnValue("hashed"),
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
  sendLowCreditsEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/qstash", () => ({
  enqueueStage: vi.fn().mockResolvedValue({ messageId: "mock-msg" }),
}));

vi.mock("@/lib/utils", async () => {
  const actual = await vi.importActual<typeof import("@/lib/utils")>("@/lib/utils");
  return {
    ...actual,
    normalizeDomain: vi.fn((d: string) => d.toLowerCase()),
    slugify: vi.fn((s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-")),
    normalizeUrl: vi.fn((u: string) => {
      try {
        return new URL(u.startsWith("http") ? u : `https://${u}`).toString();
      } catch {
        return null;
      }
    }),
  };
});

vi.mock("nanoid", () => ({ nanoid: () => "mock-nanoid" }));

import { POST } from "@/app/api/sites/route";
import { checkRateLimit } from "@/lib/rate-limit";

function buildJsonReq(body: Record<string, unknown>, ip?: string): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  // C4: use Vercel-trusted infra header — raw x-forwarded-for is spoofable
  // and ignored by getClientIp().
  if (ip !== undefined) headers["x-vercel-forwarded-for"] = ip;
  return new NextRequest(new URL("https://app.test/api/sites"), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("ES-090 CRIT-4 / POST /api/sites rate-limit", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls checkRateLimit with key=sites_create:<ip>, limit=10, window=60_000ms (U23)", async () => {
    (checkRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue({
      allowed: true, remaining: 9, resetAt: Date.now() + 60_000,
    });

    await POST(buildJsonReq({ url: "https://example.com", email: "u@example.com" }, "203.0.113.42"));

    expect(checkRateLimit).toHaveBeenCalledWith("sites_create:203.0.113.42", 10, 60_000);
  });

  it("returns 429 with Retry-After + retryAfterMs when limit exceeded (U24)", async () => {
    (checkRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue({
      allowed: false, remaining: 0, resetAt: Date.now() + 45_000,
    });

    const res = await POST(buildJsonReq({ url: "https://example.com", email: "u@example.com" }, "203.0.113.42"));

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
    const body = await res.json();
    expect(body).toMatchObject({ error: expect.stringMatching(/Too Many Requests/i) });
    expect(typeof body.retryAfterMs).toBe("number");
  });

  it("bulk path (bulkUrls present) is NOT blocked by single-audit rate-limit (U25)", async () => {
    // The bulk branch returns before the rate-limit check. Even if the
    // limiter would deny, the bulk path must go through. We assert the
    // limiter is never consulted on a bulk request.
    (checkRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue({
      allowed: false, remaining: 0, resetAt: Date.now() + 60_000,
    });

    const res = await POST(
      buildJsonReq(
        { bulkUrls: ["https://a.com", "https://b.com"], email: "u@example.com" },
        "203.0.113.42",
      ),
    );

    // Bulk path will fail downstream on missing team/credits (402/400/etc.)
    // but what we're asserting is ONLY that the rate limiter was not called
    // with the single-audit key.
    const calledWithSingleAuditKey = (checkRateLimit as ReturnType<typeof vi.fn>).mock.calls.some(
      (call) => typeof call[0] === "string" && call[0].startsWith("sites_create:"),
    );
    expect(calledWithSingleAuditKey).toBe(false);
    // Sanity: not a 429 from our guard.
    expect(res.status).not.toBe(429);
  });

  it("missing IP source keys as 'unknown' (U26)", async () => {
    (checkRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue({
      allowed: true, remaining: 9, resetAt: Date.now() + 60_000,
    });

    await POST(buildJsonReq({ url: "https://example.com", email: "u@example.com" })); // no IP header

    expect(checkRateLimit).toHaveBeenCalledWith("sites_create:unknown", 10, 60_000);
  });

  it("429 path does NOT insert a new site (guard precedes write)", async () => {
    (checkRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue({
      allowed: false, remaining: 0, resetAt: Date.now() + 60_000,
    });

    const { db } = await import("@/lib/db");
    await POST(buildJsonReq({ url: "https://example.com", email: "u@example.com" }, "203.0.113.42"));

    expect(db.insert).not.toHaveBeenCalled();
  });
});
