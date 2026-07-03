/**
 * ES-090 Phase 1 (ScriptDev) — CRIT-1 token expiry on POST /api/sites/[id]/citation-check.
 *
 * ChangedSpec §b.2 step 3, 2nd bullet — expiry check inserted at :83+ (after
 * the `site.accessToken !== token` check, before the `site.geoScorecard`
 * guard and any credit-debit work).
 *
 * HP-197 — NULL tokenExpiresAt treated as expired (fail closed).
 * AC-2 + AC-4 — 401 body `{ error: "Unauthorized", code: "TOKEN_EXPIRED" }`.
 *
 * This test asserts that the expiry gate fires BEFORE any credit or provider
 * work — so an expired-token caller never burns credits nor touches the LLM
 * providers (critical for the "U21 rate-limit check runs before credit debit"
 * invariant that CRIT-3 builds on).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Mocks (hoisted) ──────────────────────────────────────────────────────

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    }),
  },
}));

// Heavy service deps — never invoked when auth short-circuits. Stubbed so
// route module loads without crashing.
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
// ES-090 §b.4 CRIT-3 added rate-limit AFTER the expiry check. These
// auth/expiry tests don't care about rate-limit state — stub to allowed so
// the happy-path reaches the next gate without exercising the real
// Upstash/DB backing. CRIT-3-specific tests live in citation-check-ratelimit.spec.ts.
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 0,
    resetAt: Date.now() + 30_000,
  }),
}));

import { POST } from "@/app/api/sites/[id]/citation-check/route";
import { db } from "@/lib/db";

// ─── Fixtures ─────────────────────────────────────────────────────────────

const SITE_ID = "site-es090-cc";
const VALID_TOKEN = "tok_es090_cc_valid";

function baseSite(overrides: Record<string, unknown> = {}) {
  return {
    id: SITE_ID,
    domain: "cc.example.test",
    accessToken: VALID_TOKEN,
    tokenExpiresAt: new Date(Date.now() + 30 * 86_400_000),
    teamId: "team-cc",
    geoScorecard: { overallScore: 50, pillars: [] },
    brandKeywords: { keywords: ["x"], isAmbiguous: false, source: "domain", extractedAt: "" },
    extractedCategories: { categories: ["a"], entityNoun: "x", extractedAt: "", source: "haiku" },
    ...overrides,
  };
}

/**
 * The route's db-call chain:
 *   1. select().from(geoSites).where(eq(id, siteId))   → [site]
 *   2. select().from(teams).where(eq(id, teamId))       → [team]
 * + update/insert after auth passes.
 * We only need (1) to fire for the pre-auth cases; later stages don't execute
 * when auth short-circuits.
 */
function stubDb(site: ReturnType<typeof baseSite> | undefined, team?: { id: string; creditBalance: number }) {
  const selectMock = db.select as unknown as ReturnType<typeof vi.fn>;
  selectMock.mockReset();
  selectMock.mockImplementation(() => ({
    from: vi.fn().mockImplementation(() => ({
      where: vi.fn().mockImplementation(() => {
        // First call = site lookup; second = team lookup.
        const calls = selectMock.mock.calls.length;
        if (calls === 1) return Promise.resolve(site ? [site] : []);
        return Promise.resolve(team ? [team] : []);
      }),
    })),
  }));
}

function buildReq(token: string | null): NextRequest {
  const url = token
    ? `https://app.test/api/sites/${SITE_ID}/citation-check?token=${encodeURIComponent(token)}`
    : `https://app.test/api/sites/${SITE_ID}/citation-check`;
  return new NextRequest(new URL(url), { method: "POST" });
}

const ctx = { params: Promise.resolve({ id: SITE_ID }) };

// ─── Cases ────────────────────────────────────────────────────────────────

describe("ES-090 CRIT-1 / POST /api/sites/[id]/citation-check — token expiry", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 TOKEN_EXPIRED when tokenExpiresAt is in the past", async () => {
    stubDb(baseSite({ tokenExpiresAt: new Date(Date.now() - 1000) }), { id: "team-cc", creditBalance: 100 });
    const res = await POST(buildReq(VALID_TOKEN), ctx);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual(expect.objectContaining({ error: "Unauthorized", code: "TOKEN_EXPIRED" }));
  });

  it("returns 401 TOKEN_EXPIRED when tokenExpiresAt is NULL (HP-197)", async () => {
    stubDb(baseSite({ tokenExpiresAt: null }), { id: "team-cc", creditBalance: 100 });
    const res = await POST(buildReq(VALID_TOKEN), ctx);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("TOKEN_EXPIRED");
  });

  it("401 TOKEN_EXPIRED path does NOT call update() (no credit debit before auth)", async () => {
    stubDb(baseSite({ tokenExpiresAt: new Date(Date.now() - 1) }));
    await POST(buildReq(VALID_TOKEN), ctx);
    // AC-guarded: expiry gate runs BEFORE the credit deduction update.
    expect(db.update).not.toHaveBeenCalled();
  });

  it("wrong token returns plain 401 (no TOKEN_EXPIRED leakage)", async () => {
    stubDb(baseSite());
    const res = await POST(buildReq("wrong"), ctx);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBeUndefined();
  });

  it("returns 404 on missing site before expiry check", async () => {
    stubDb(undefined);
    const res = await POST(buildReq(VALID_TOKEN), ctx);
    expect(res.status).toBe(404);
  });

  it("happy path (valid future expiry) does NOT return 401 TOKEN_EXPIRED", async () => {
    // Downstream may still return 402/422 depending on mocks — we only assert
    // the expiry gate didn't fire.
    stubDb(baseSite(), { id: "team-cc", creditBalance: 100 });
    const res = await POST(buildReq(VALID_TOKEN), ctx);
    if (res.status === 401) {
      const body = await res.json();
      expect(body.code).not.toBe("TOKEN_EXPIRED");
    }
  });
});
