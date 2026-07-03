/**
 * ES-090 CRIT-3 — citation-check rate limit (U18-U22).
 *
 * Phase A (RED): main @ 70645cba `app/api/sites/[id]/citation-check/route.ts`
 * does NOT call `checkRateLimit`. Spec b.4 inserts the call with key
 * `citation_check:${siteId}` (limit 1 per 30s).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { state, dbMock, checkRateLimitMock } = vi.hoisted(() => {
  const state = {
    site: {
      id: "site-a",
      accessToken: "tok",
      tokenExpiresAt: new Date(Date.now() + 86_400_000),
      teamId: "team-a",
      geoScorecard: { foo: 1 },
    } as Record<string, unknown> | null,
    teamCredits: 100,
    rateLimitAllowed: true,
    rateLimitResetAt: Date.now() + 30_000,
  };
  const dbMock = {
    select: vi.fn(() => ({
      from: vi.fn((tbl: { __name?: string }) => ({
        where: vi.fn(async () => {
          if (tbl?.__name === "teams") return [{ creditBalance: state.teamCredits, id: "team-a" }];
          return state.site ? [state.site] : [];
        }),
      })),
    })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) })),
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
  };
  const checkRateLimitMock = vi.fn(async () => ({
    allowed: state.rateLimitAllowed,
    remaining: state.rateLimitAllowed ? 0 : 0,
    resetAt: state.rateLimitResetAt,
  }));
  return { state, dbMock, checkRateLimitMock };
});

vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/db/schema", () => ({
  geoSites: { __name: "geo_sites", id: "id", accessToken: "access_token" },
  teams: { __name: "teams", id: "id" },
  creditTransactions: { __name: "credit_transactions" },
  citationCheckResponses: {},
  citationCheckScores: {},
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn(), sql: (s: TemplateStringsArray) => s.join(""), gte: vi.fn(), and: vi.fn(), isNull: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: checkRateLimitMock }));
vi.mock("@/lib/services/citation-prompt-generator", () => ({ generatePrompts: vi.fn(), extractTopCityNames: vi.fn() }));
vi.mock("@/lib/services/citation-checker", () => ({ runCitationCheck: vi.fn(), aggregateByDimension: vi.fn(), aggregateCompetitorsByDimension: vi.fn(), generateDominanceInsights: vi.fn() }));
vi.mock("@/lib/services/real-prompt-discoverer", () => ({ discoverRealPrompts: vi.fn() }));
vi.mock("@/lib/services/crawl-coverage-validator", () => ({ validateCrawlCoverage: vi.fn() }));
vi.mock("@/lib/services/engine-preference-analyzer", () => ({ analyzeEnginePreferences: vi.fn() }));
vi.mock("@/lib/services/tree-extractor", () => ({ extractTrees: vi.fn() }));
vi.mock("@/lib/services/brand-detector", () => ({ extractBrandKeywords: vi.fn() }));
vi.mock("@/lib/services/category-extractor", () => ({ extractCategoriesViaHaiku: vi.fn() }));

beforeEach(() => {
  state.rateLimitAllowed = true;
  state.rateLimitResetAt = Date.now() + 30_000;
  state.teamCredits = 100;
  checkRateLimitMock.mockClear();
  dbMock.insert.mockClear();
});

function req(token: string): NextRequest {
  return new NextRequest(`https://geo.flowblinq.com/api/sites/site-a/citation-check?token=${token}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("ES-090 CRIT-3 — citation-check rate limit", () => {
  it("U18: first call invokes checkRateLimit with citation_check:<siteId>", async () => {
    const { POST } = await import("@/app/api/sites/[id]/citation-check/route?u18");
    await POST(req("tok"), { params: Promise.resolve({ id: "site-a" }) });
    expect(checkRateLimitMock).toHaveBeenCalledWith("citation_check:site-a", 1, 30_000);
  });

  it("U19: second call within 30s returns 429 with Retry-After header", async () => {
    state.rateLimitAllowed = false;
    state.rateLimitResetAt = Date.now() + 25_000;
    const { POST } = await import("@/app/api/sites/[id]/citation-check/route?u19");
    const res = await POST(req("tok"), { params: Promise.resolve({ id: "site-a" }) });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    const body = await res.json();
    expect(body.retryAfterMs).toBeGreaterThan(0);
  });

  it("U20: call after window expiry allowed AND checkRateLimit invoked (anti-false-green)", async () => {
    state.rateLimitAllowed = true;
    const { POST } = await import("@/app/api/sites/[id]/citation-check/route?u20");
    const res = await POST(req("tok"), { params: Promise.resolve({ id: "site-a" }) });
    expect(res.status).not.toBe(429);
    // Anti-false-green: pre-fix code does NOT call the limiter, so this fails today.
    expect(checkRateLimitMock).toHaveBeenCalled();
  });

  it("U21: 429 path does NOT write a credit transaction row AND limiter was actually called", async () => {
    state.rateLimitAllowed = false;
    const { POST } = await import("@/app/api/sites/[id]/citation-check/route?u21");
    const res = await POST(req("tok"), { params: Promise.resolve({ id: "site-a" }) });
    // Anti-false-green: must have actually entered the 429 branch.
    expect(res.status).toBe(429);
    expect(checkRateLimitMock).toHaveBeenCalled();
    // And NO credit-debit row was written.
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("U22: rate-limit key is per-siteId — siteB not blocked when siteA blocked", async () => {
    // Two sequential calls with different siteIds — both should exercise their
    // own bucket, so the mock receives two distinct keys.
    state.rateLimitAllowed = true;
    const { POST } = await import("@/app/api/sites/[id]/citation-check/route?u22");
    state.site = { id: "site-a", accessToken: "tok", tokenExpiresAt: new Date(Date.now() + 86_400_000), teamId: "t1", geoScorecard: { x: 1 } };
    await POST(req("tok"), { params: Promise.resolve({ id: "site-a" }) });
    state.site = { id: "site-b", accessToken: "tok", tokenExpiresAt: new Date(Date.now() + 86_400_000), teamId: "t1", geoScorecard: { x: 1 } };
    await POST(req("tok"), { params: Promise.resolve({ id: "site-b" }) });
    const keys = checkRateLimitMock.mock.calls.map((c) => c[0]);
    expect(keys).toContain("citation_check:site-a");
    expect(keys).toContain("citation_check:site-b");
  });
});
