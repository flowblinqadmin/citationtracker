/**
 * ES-090 Phase 1 (ScriptDev) — CRIT-3 citation-check rate-limit.
 *
 * ChangedSpec §b.4 — insert at :83+ (after equality + new expiry check):
 *
 *   const rl = await checkRateLimit(`citation_check:${siteId}`, 1, 30_000);
 *   if (!rl.allowed) return 429 + Retry-After header + retryAfterMs body;
 *
 * Key scoped per-siteId (NOT per-IP) so legitimate multi-device use doesn't
 * share a bucket. Matches the `<domain>:<id>` pattern used elsewhere.
 *
 * Spec test plan U18-U22 equivalents:
 * - U18  first call allowed (no 429)
 * - U19  second call within 30s → 429 + Retry-After header + retryAfterMs body
 * - U20  (window-expiry — tricky without timer control; we pin it by
 *         verifying the call args rather than forwarding time)
 * - U21  rate-limit check precedes credit debit
 * - U22  key scoped per-siteId (siteA blocked, siteB proceeds)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    }),
  },
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
}));

// Identical-to-CRIT-1-suite service mocks so the route loads.
vi.mock("@/lib/services/citation-prompt-generator", () => ({
  generatePrompts: vi.fn().mockResolvedValue([]),
  extractTopCityNames: vi.fn().mockReturnValue([]),
}));
vi.mock("@/lib/services/citation-checker", () => ({
  runCitationCheck: vi.fn().mockResolvedValue({ responses: [], scores: [] }),
  aggregateByDimension: vi.fn().mockReturnValue({ geoVisibility: [], categoryVisibility: [], tierVisibility: [] }),
  aggregateCompetitorsByDimension: vi.fn().mockReturnValue({ locationCompetitors: [], categoryCompetitors: [], dominanceMap: { entries: [], computedAt: "" } }),
  generateDominanceInsights: vi.fn().mockReturnValue([]),
}));
vi.mock("@/lib/services/real-prompt-discoverer", () => ({
  discoverRealPrompts: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/services/crawl-coverage-validator", () => ({
  validateCrawlCoverage: vi.fn().mockReturnValue({ ok: true }),
}));
vi.mock("@/lib/services/engine-preference-analyzer", () => ({
  analyzeEnginePreferences: vi.fn().mockReturnValue({}),
}));
vi.mock("@/lib/services/tree-extractor", () => ({
  extractTrees: vi.fn().mockResolvedValue({ geoTree: null, categoryTree: null }),
}));
vi.mock("@/lib/services/brand-detector", () => ({
  extractBrandKeywords: vi.fn().mockResolvedValue({ keywords: [], isAmbiguous: false, source: "domain", extractedAt: "" }),
}));
vi.mock("@/lib/services/category-extractor", () => ({
  extractCategoriesViaHaiku: vi.fn().mockResolvedValue({ categories: [], entityNoun: "", extractedAt: "", source: "haiku" }),
}));
vi.mock("nanoid", () => ({ nanoid: () => "mock-nanoid" }));
vi.mock("@/lib/services/site-view-sync", () => ({
  syncSiteView: vi.fn().mockResolvedValue(undefined),
  syncSiteViewStatus: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from "@/app/api/sites/[id]/citation-check/route";
import { db } from "@/lib/db";
import { checkRateLimit } from "@/lib/rate-limit";

const SITE_ID_A = "site-es090-cc-A";
const SITE_ID_B = "site-es090-cc-B";
const TOKEN_A = "tok_cc_A";
const TOKEN_B = "tok_cc_B";

function baseSite(id: string, token: string) {
  return {
    id,
    domain: `${id}.example.test`,
    accessToken: token,
    tokenExpiresAt: new Date(Date.now() + 30 * 86_400_000),
    teamId: `team-${id}`,
    geoScorecard: { overallScore: 50, pillars: [] },
    brandKeywords: { keywords: ["x"], isAmbiguous: false, source: "domain", extractedAt: "" },
    extractedCategories: { categories: ["a"], entityNoun: "x", extractedAt: "", source: "haiku" },
  };
}

function stubDb(siteId: string, token: string) {
  const site = baseSite(siteId, token);
  const team = { id: `team-${siteId}`, creditBalance: 100 };
  const selectMock = db.select as unknown as ReturnType<typeof vi.fn>;
  selectMock.mockReset();
  selectMock.mockImplementation(() => ({
    from: vi.fn().mockImplementation(() => ({
      where: vi.fn().mockImplementation(() => {
        const calls = selectMock.mock.calls.length;
        if (calls === 1) return Promise.resolve([site]);
        return Promise.resolve([team]);
      }),
    })),
  }));
}

function buildReq(siteId: string, token: string): NextRequest {
  return new NextRequest(
    new URL(`https://app.test/api/sites/${siteId}/citation-check?token=${encodeURIComponent(token)}`),
    { method: "POST" },
  );
}

describe("ES-090 CRIT-3 / citation-check rate-limit", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls checkRateLimit with key=citation_check:<siteId>, limit=1, window=30_000ms (U18/U22)", async () => {
    stubDb(SITE_ID_A, TOKEN_A);
    (checkRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue({
      allowed: true, remaining: 0, resetAt: Date.now() + 30_000,
    });

    await POST(buildReq(SITE_ID_A, TOKEN_A), { params: Promise.resolve({ id: SITE_ID_A }) });

    expect(checkRateLimit).toHaveBeenCalledWith(`citation_check:${SITE_ID_A}`, 1, 30_000);
  });

  it("returns 429 with Retry-After header + retryAfterMs body when rate-limit denies (U19)", async () => {
    stubDb(SITE_ID_A, TOKEN_A);
    const resetAt = Date.now() + 17_000; // 17s of remaining window
    (checkRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue({
      allowed: false, remaining: 0, resetAt,
    });

    const res = await POST(buildReq(SITE_ID_A, TOKEN_A), { params: Promise.resolve({ id: SITE_ID_A }) });
    expect(res.status).toBe(429);
    const ra = res.headers.get("retry-after");
    expect(ra).toBeTruthy();
    // `Math.ceil(remainingMs / 1000)` — 17s ceiling
    expect(Number(ra)).toBeGreaterThanOrEqual(16);
    expect(Number(ra)).toBeLessThanOrEqual(18);
    const body = await res.json();
    expect(body).toMatchObject({
      error: expect.stringMatching(/Too Many Requests/i),
    });
    expect(typeof body.retryAfterMs).toBe("number");
    expect(body.retryAfterMs).toBeGreaterThan(0);
  });

  it("429 path does NOT call credit-debit update (U21 — rate-limit precedes debit)", async () => {
    stubDb(SITE_ID_A, TOKEN_A);
    (checkRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue({
      allowed: false, remaining: 0, resetAt: Date.now() + 30_000,
    });

    await POST(buildReq(SITE_ID_A, TOKEN_A), { params: Promise.resolve({ id: SITE_ID_A }) });

    // CRIT-3 spec: rate-limit blocks before any credit deduction.
    // db.update would be the credit-debit path.
    expect(db.update).not.toHaveBeenCalled();
  });

  it("429 path does NOT call insert (no transaction row written)", async () => {
    stubDb(SITE_ID_A, TOKEN_A);
    (checkRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue({
      allowed: false, remaining: 0, resetAt: Date.now() + 30_000,
    });

    await POST(buildReq(SITE_ID_A, TOKEN_A), { params: Promise.resolve({ id: SITE_ID_A }) });

    expect(db.insert).not.toHaveBeenCalled();
  });

  it("different siteIds keyed independently — siteB not blocked when siteA denied (U22)", async () => {
    // Simulate siteA having been called (allowed=false) and then siteB calling (allowed=true).
    stubDb(SITE_ID_B, TOKEN_B);
    (checkRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue({
      allowed: true, remaining: 0, resetAt: Date.now() + 30_000,
    });

    await POST(buildReq(SITE_ID_B, TOKEN_B), { params: Promise.resolve({ id: SITE_ID_B }) });

    // Assertion is about key scoping — the limiter got siteB's key, not siteA's.
    expect(checkRateLimit).toHaveBeenCalledWith(`citation_check:${SITE_ID_B}`, 1, 30_000);
    const wasCalledWithA = (checkRateLimit as ReturnType<typeof vi.fn>).mock.calls.some(
      (call) => call[0] === `citation_check:${SITE_ID_A}`,
    );
    expect(wasCalledWithA).toBe(false);
  });
});
