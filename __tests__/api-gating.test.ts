/**
 * API Gating Tests — GET /api/sites/[id]
 *
 * Tests free/paid tier gating behavior per ES-002 spec (Task 3, #38).
 * 13 test cases covering:
 *   - Paid tier: full data returned
 *   - Free tier: stripped data (no team, 0 credits)
 *   - Executive summary truncation
 *   - Recommendation capping
 *   - Scorecard pillar stripping
 *   - Null/edge cases
 *   - Team lookup failure resilience
 *
 * These tests are written BEFORE implementation (test-first).
 * They will FAIL until the gating logic is added to the route handler.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  mockTeam,
  mockSite,
  mockRecommendations,
  assertFreeGating,
  assertPaidFull,
  createTestRequest,
  createRouteContext,
  makeSelectChain,
  makeSelectChainWithError,
} from "./helpers/test-harness";

// ─── Mocks — hoisted before all imports ──────────────────────────────────────

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
  },
}));

// ─── Imports ─────────────────────────────────────────────────────────────────

import { GET } from "@/app/api/sites/[id]/route";
import { db } from "@/lib/db";

// ─── DB Mock Setup ───────────────────────────────────────────────────────────

/**
 * Sets up sequential db.select() calls for the GET handler:
 *   Call 1 → geoSites query (returns site)
 *   Call 2 → teams query (returns team or empty)
 */
function setupDbMocks(
  site: ReturnType<typeof mockSite> | null,
  team: ReturnType<typeof mockTeam> | null = null
) {
  let callCount = 0;
  (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
    callCount++;
    if (callCount === 1) {
      return makeSelectChain(site ? [site] : []);
    }
    return makeSelectChain(team ? [team] : []);
  });
}

/**
 * Sets up db.select() where the team query throws (simulates DB error).
 * Site query succeeds; team query fails.
 */
function setupDbMocksWithTeamError(site: ReturnType<typeof mockSite>) {
  let callCount = 0;
  (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
    callCount++;
    if (callCount === 1) {
      return makeSelectChain([site]);
    }
    return makeSelectChainWithError(new Error("DB connection failed"));
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("GET /api/sites/[id] — Tier Gating", () => {
  const TOKEN = "test-token";
  const SITE_ID = "site-test-1";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Test 1: Paid tier — full data returned ──

  it("returns full data for paid tier (team with credits > 0)", async () => {
    const site = mockSite({ teamId: "team-1", accessToken: TOKEN });
    const team = mockTeam({ id: "team-1", creditBalance: 50 });
    setupDbMocks(site, team);

    const res = await GET(
      createTestRequest(SITE_ID, TOKEN),
      createRouteContext(SITE_ID)
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    assertPaidFull(body);
    expect(body.credits).toBe(50);
  });

  // ── Test 2: Free tier (no team) — stripped data ──

  it("returns stripped data for free tier when site has no teamId", async () => {
    const site = mockSite({ teamId: null, accessToken: TOKEN });
    setupDbMocks(site);

    const res = await GET(
      createTestRequest(SITE_ID, TOKEN),
      createRouteContext(SITE_ID)
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    assertFreeGating(body);
    expect(body.credits).toBe(0);
  });

  // ── Test 3: Free tier (team, 0 credits) — stripped data ──

  it("returns stripped data for free tier when team has 0 credits", async () => {
    const site = mockSite({ teamId: "team-1", accessToken: TOKEN });
    const team = mockTeam({ id: "team-1", creditBalance: 0 });
    setupDbMocks(site, team);

    const res = await GET(
      createTestRequest(SITE_ID, TOKEN),
      createRouteContext(SITE_ID)
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    assertFreeGating(body);
    expect(body.credits).toBe(0);
  });

  // ── Test 4: Executive summary truncation ──

  it("truncates executive summary to first paragraph for free tier", async () => {
    const site = mockSite({
      teamId: null,
      accessToken: TOKEN,
      executiveSummary: "Para 1\n\nPara 2\n\nPara 3",
    });
    setupDbMocks(site);

    const res = await GET(
      createTestRequest(SITE_ID, TOKEN),
      createRouteContext(SITE_ID)
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.executiveSummary).toBe("Para 1");
  });

  // ── Test 5: Executive summary — single paragraph (no truncation needed) ──

  it("returns full executive summary when it has only one paragraph (free tier)", async () => {
    const site = mockSite({
      teamId: null,
      accessToken: TOKEN,
      executiveSummary: "Only one paragraph here",
    });
    setupDbMocks(site);

    const res = await GET(
      createTestRequest(SITE_ID, TOKEN),
      createRouteContext(SITE_ID)
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.executiveSummary).toBe("Only one paragraph here");
  });

  // ── Test 6: Recommendations capped at 3 ──

  it("caps recommendations at 3 with only title/pillar/priority for free tier", async () => {
    const site = mockSite({
      teamId: null,
      accessToken: TOKEN,
      rankedRecommendations: mockRecommendations(5),
    });
    setupDbMocks(site);

    const res = await GET(
      createTestRequest(SITE_ID, TOKEN),
      createRouteContext(SITE_ID)
    );
    const body = (await res.json()) as Record<string, unknown>;
    const recs = body.rankedRecommendations as Array<Record<string, unknown>>;

    expect(recs).toHaveLength(3);
    for (const rec of recs) {
      expect(Object.keys(rec).sort()).toEqual(["pillar", "priority", "title"]);
    }
  });

  // ── Test 7: Recommendations fewer than 3 — no padding ──

  it("does not pad recommendations when fewer than 3 exist (free tier)", async () => {
    const site = mockSite({
      teamId: null,
      accessToken: TOKEN,
      rankedRecommendations: mockRecommendations(1),
    });
    setupDbMocks(site);

    const res = await GET(
      createTestRequest(SITE_ID, TOKEN),
      createRouteContext(SITE_ID)
    );
    const body = (await res.json()) as Record<string, unknown>;
    const recs = body.rankedRecommendations as Array<Record<string, unknown>>;

    expect(recs).toHaveLength(1);
    expect(Object.keys(recs[0]).sort()).toEqual(["pillar", "priority", "title"]);
  });

  // ── Test 8: Scorecard pillar stripping ──

  it("strips findings/recommendation/impactedPages from pillars for free tier", async () => {
    const site = mockSite({ teamId: null, accessToken: TOKEN });
    setupDbMocks(site);

    const res = await GET(
      createTestRequest(SITE_ID, TOKEN),
      createRouteContext(SITE_ID)
    );
    const body = (await res.json()) as Record<string, unknown>;
    const scorecard = body.geoScorecard as {
      pillars: Array<Record<string, unknown>>;
    };

    expect(scorecard.pillars.length).toBeGreaterThan(0);
    for (const pillar of scorecard.pillars) {
      // Retained fields
      expect(pillar).toHaveProperty("pillar");
      expect(pillar).toHaveProperty("pillarName");
      expect(pillar).toHaveProperty("score");
      expect(pillar).toHaveProperty("priority");
      // Stripped fields
      expect(pillar).not.toHaveProperty("findings");
      expect(pillar).not.toHaveProperty("recommendation");
      expect(pillar).not.toHaveProperty("impactedPages");
    }
  });

  // ── Test 9: Null scorecard ──

  it("returns null geoScorecard when scorecard is null (free tier)", async () => {
    const site = mockSite({
      teamId: null,
      accessToken: TOKEN,
      overallScore: null,
      pillars: null,
    });
    setupDbMocks(site);

    const res = await GET(
      createTestRequest(SITE_ID, TOKEN),
      createRouteContext(SITE_ID)
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.geoScorecard).toBeNull();
  });

  // ── Test 10: Null recommendations ──

  it("returns empty array for recommendations when null (free tier)", async () => {
    const site = mockSite({
      teamId: null,
      accessToken: TOKEN,
      rankedRecommendations: null,
    });
    setupDbMocks(site);

    const res = await GET(
      createTestRequest(SITE_ID, TOKEN),
      createRouteContext(SITE_ID)
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.rankedRecommendations).toEqual([]);
  });

  // ── Test 11: tier and credits always present ──

  it("always includes tier and credits fields in response for both tiers", async () => {
    // Free tier
    const freeSite = mockSite({ teamId: null, accessToken: TOKEN });
    setupDbMocks(freeSite);

    const freeRes = await GET(
      createTestRequest(SITE_ID, TOKEN),
      createRouteContext(SITE_ID)
    );
    const freeBody = (await freeRes.json()) as Record<string, unknown>;

    expect(freeBody).toHaveProperty("tier");
    expect(freeBody).toHaveProperty("credits");

    vi.clearAllMocks();

    // Paid tier
    const paidSite = mockSite({ teamId: "team-1", accessToken: TOKEN });
    const team = mockTeam({ id: "team-1", creditBalance: 100 });
    setupDbMocks(paidSite, team);

    const paidRes = await GET(
      createTestRequest(SITE_ID, TOKEN),
      createRouteContext(SITE_ID)
    );
    const paidBody = (await paidRes.json()) as Record<string, unknown>;

    expect(paidBody).toHaveProperty("tier");
    expect(paidBody).toHaveProperty("credits");
  });

  // ── Test 12: Generated files null for free tier ──

  it("returns null for all generated files in free tier", async () => {
    const site = mockSite({
      teamId: null,
      accessToken: TOKEN,
      generatedLlmsTxt: "# content",
      generatedLlmsFullTxt: "# full content",
      generatedBusinessJson: { name: "Biz" },
      generatedSchemaBlocks: { "@type": "Org" },
    });
    setupDbMocks(site);

    const res = await GET(
      createTestRequest(SITE_ID, TOKEN),
      createRouteContext(SITE_ID)
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.generatedLlmsTxt).toBeNull();
    expect(body.generatedLlmsFullTxt).toBeNull();
    expect(body.generatedBusinessJson).toBeNull();
    expect(body.generatedSchemaBlocks).toBeNull();
  });

  // ── Test 13: Team lookup failure defaults to free ──

  it("defaults to free tier when team lookup fails (DB error)", async () => {
    const site = mockSite({
      teamId: "team-1",
      accessToken: TOKEN,
      generatedLlmsTxt: "# content",
    });
    setupDbMocksWithTeamError(site);

    const res = await GET(
      createTestRequest(SITE_ID, TOKEN),
      createRouteContext(SITE_ID)
    );
    const body = (await res.json()) as Record<string, unknown>;

    // Should NOT crash — should default to free tier
    expect(res.status).toBe(200);
    expect(body.tier).toBe("free");
    expect(body.credits).toBe(0);
    // Paid data should be stripped even though site has it
    expect(body.generatedLlmsTxt).toBeNull();
  });
});
