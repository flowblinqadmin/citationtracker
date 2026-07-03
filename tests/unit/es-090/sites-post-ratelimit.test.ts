/**
 * ES-090 CRIT-4 — sites POST IP rate limit (U23-U26).
 *
 * Phase A (RED): main @ 70645cba `app/api/sites/route.ts:8` imports
 * `checkRateLimit` but NEVER calls it. Spec b.5 inserts after the bulk
 * branch returns, keyed by `sites_create:${ip}` (10 / 60s).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { state, checkRateLimitMock, dbMock } = vi.hoisted(() => {
  const state = { allowed: true, resetAt: Date.now() + 60_000 };
  const dbMock = {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(async () => []) })) })),
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined), returning: vi.fn(async () => [{ id: "new-site" }]) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) })),
  };
  const checkRateLimitMock = vi.fn(async () => ({
    allowed: state.allowed,
    remaining: state.allowed ? 5 : 0,
    resetAt: state.resetAt,
  }));
  return { state, checkRateLimitMock, dbMock };
});

vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/db/schema", () => ({
  geoSites: { __name: "geo_sites" },
  teamMembers: {},
  teams: {},
  teamDomains: {},
  creditTransactions: {},
}));
vi.mock("drizzle-orm", () => ({ eq: vi.fn(), and: vi.fn(), sql: (s: TemplateStringsArray) => s.join("") }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: checkRateLimitMock }));
vi.mock("@/lib/email", () => ({
  generateVerificationCode: vi.fn(() => "123456"),
  hashCode: vi.fn(() => "hash"),
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
  sendLowCreditsEmail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/qstash", () => ({ enqueueStage: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/services/page-accounting", () => ({ resolveCrawlBudget: vi.fn(() => ({ crawlLimit: 10, credits: 1 })) }));
vi.mock("@/lib/utils", () => ({
  normalizeDomain: (s: string) => s.replace(/^https?:\/\//, "").replace(/\/$/, ""),
  slugify: (s: string) => s.toLowerCase(),
  normalizeUrl: (s: string) => (s.startsWith("http") ? s : `https://${s}`),
}));

beforeEach(() => {
  state.allowed = true;
  state.resetAt = Date.now() + 60_000;
  checkRateLimitMock.mockClear();
});

function singlePost(ip = "203.0.113.5"): NextRequest {
  return new NextRequest("https://geo.flowblinq.com/api/sites", {
    method: "POST",
    // C4: use a trusted infra header — raw x-forwarded-for is spoofable
    // and ignored by getClientIp().
    headers: { "x-vercel-forwarded-for": ip, "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.com", email: "a@b.test" }),
  });
}

function bulkPost(ip = "203.0.113.5"): NextRequest {
  return new NextRequest("https://geo.flowblinq.com/api/sites", {
    method: "POST",
    // C4: use a trusted infra header — raw x-forwarded-for is spoofable
    // and ignored by getClientIp().
    headers: { "x-vercel-forwarded-for": ip, "content-type": "application/json" },
    body: JSON.stringify({ bulkUrls: ["https://a.test", "https://b.test"], email: "a@b.test" }),
  });
}

describe("ES-090 CRIT-4 — POST /api/sites IP rate limit", () => {
  it("U23: single-audit POST invokes checkRateLimit with sites_create:<ip>, 10, 60_000", async () => {
    const { POST } = await import("@/app/api/sites/route?u23");
    await POST(singlePost("203.0.113.5"));
    expect(checkRateLimitMock).toHaveBeenCalledWith("sites_create:203.0.113.5", 10, 60_000);
  });

  it("U24: 11th call (limiter denies) → 429 with Retry-After + retryAfterMs body", async () => {
    state.allowed = false;
    state.resetAt = Date.now() + 45_000;
    const { POST } = await import("@/app/api/sites/route?u24");
    const res = await POST(singlePost("203.0.113.5"));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    const body = await res.json();
    expect(body.retryAfterMs).toBeGreaterThan(0);
  });

  it("U25: single-audit POST DOES call limiter; bulk POST does NOT (split-call assertion)", async () => {
    // Anti-false-green: assert single triggers the limiter (proves wiring exists)
    // BEFORE asserting bulk skips it. A no-op route would falsely pass the bulk
    // assertion alone, so we couple them.
    const { POST } = await import("@/app/api/sites/route?u25");

    state.allowed = true;
    await POST(singlePost("203.0.113.6"));
    expect(checkRateLimitMock).toHaveBeenCalledTimes(1);

    checkRateLimitMock.mockClear();
    await POST(bulkPost("203.0.113.6"));
    expect(checkRateLimitMock).not.toHaveBeenCalled();
  });

  it("U26: missing IP keyed as 'unknown'", async () => {
    const { POST } = await import("@/app/api/sites/route?u26");
    const r = new NextRequest("https://geo.flowblinq.com/api/sites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com", email: "a@b.test" }),
    });
    await POST(r);
    expect(checkRateLimitMock).toHaveBeenCalledWith("sites_create:unknown", 10, 60_000);
  });
});
