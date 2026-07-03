/**
 * GET /api/sites/[id] — Non-happy-path and tier-gating tests
 *
 * Covers gaps not addressed by api-gating.test.ts or bulk-site-get.test.ts:
 *
 *   Auth errors (no token, wrong token, query-param token, header token)
 *   404 (site not found)
 *   500 (DB error in main query)
 *   Tier derivation edge cases (team deleted, teamId null, creditBalance=0, DB throw)
 *   Free-tier field-level assertions (scorecard shape, summary split, rec count/shape, generated files)
 *   Paid-tier field-level assertions (full scorecard, full summary, all recs with description, generated files)
 *   Diff / previousRunSnapshot (scoreDelta computed, diff null when no snapshot)
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks — must be hoisted before any module imports ───────────────────────

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_col: unknown, _val: unknown) => ({ _eq: [_col, _val] })),
}));

// ─── Imports ─────────────────────────────────────────────────────────────────

import { NextRequest } from "next/server";
import { GET } from "@/app/api/sites/[id]/route";
import { db } from "@/lib/db";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a NextRequest for GET /api/sites/[id].
 *
 * Pass `token` + `useHeader=true`  → Authorization: Bearer <token>
 * Pass `token` + `useHeader=false` → ?token=<token> query param
 * Omit `token`                     → no auth at all
 */
function makeRequest(
  id: string,
  token?: string,
  useHeader = true
): [NextRequest, { params: Promise<{ id: string }> }] {
  const base = `https://test.com/api/sites/${id}`;
  const url = token && !useHeader ? `${base}?token=${token}` : base;
  const headers: Record<string, string> = {};
  if (token && useHeader) headers["authorization"] = `Bearer ${token}`;
  const req = new NextRequest(new Request(url, { method: "GET", headers }));
  return [req, { params: Promise.resolve({ id }) }];
}

/** Minimal team row with sensible defaults. */
function makeTeam(overrides: Record<string, unknown> = {}) {
  return {
    id: "team-1",
    name: "Test Team",
    ownerUserId: "user-1",
    creditBalance: 50,
    stripeCustomerId: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

/** Pillar with all fields present (as paid-tier expects). */
function makePillar(index: number) {
  return {
    pillar: `pillar_${index}`,
    pillarName: `Pillar ${index}`,
    score: 60 + index * 5,
    weight: 0.3,
    priority: index,
    findings: `Finding for pillar ${index}`,
    recommendation: `Fix pillar ${index}`,
    impactedPages: [`https://example.com/page-${index}`],
  };
}

/** Scorecard with `count` pillars. */
function makeScorecard(overallScore: number, pillarCount = 2) {
  return {
    overallScore,
    topThreeImprovements: ["imp-1", "imp-2"],
    pillars: Array.from({ length: pillarCount }, (_, i) => makePillar(i + 1)),
  };
}

/** Recommendation with all fields: diagnosis (description/estimatedBoost) + the
 *  deploy-ready fix (specificAction, which must be stripped for free tier). */
function makeRec(index: number) {
  return {
    title: `Rec ${index}`,
    pillar: `pillar_${index}`,
    priority: index,
    description: `Detailed description for rec ${index}`,
    estimatedBoost: `+${index}`,
    specificAction: `Deploy-ready fix for rec ${index}`,
  };
}

/** Full site view row with all fields the route touches. */
function makeSite(overrides: Record<string, unknown> = {}) {
  const scorecard = makeScorecard(75);
  return {
    siteId: "site-1",
    domain: "example.com",
    slug: "example-com-abc123",
    accessToken: "valid-token",
    tokenExpiresAt: new Date(Date.now() + 30 * 86_400_000),    teamId: "team-1",
    pipelineStatus: "complete",
    pipelineError: null,
    discoveryData: {},
    platformDetected: null,
    overallScore: scorecard.overallScore,
    pillars: scorecard.pillars,
    previousScore: null,
    projectedScore: 90,
    projectedBoost: 15,
    baselineScore: null,
    executiveSummary: "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.",
    rankedRecommendations: [makeRec(1), makeRec(2), makeRec(3), makeRec(4)],
    generatedLlmsTxt: "# Example\n> Summary...",
    generatedLlmsFullTxt: "# Full content...",
    generatedBusinessJson: { name: "Example" },
    generatedSchemaBlocks: [{ type: "Organization" }],
    shareToken: "share-abc",
    verifyToken: "verify-abc",
    domainVerified: false,
    changeLog: [],
    manualRunsMonth: 0,
    crawlCount: 1,
    pageCount: 0,
    lastCrawlAt: new Date("2026-02-20"),
    nextCrawlAt: null,
    createdAt: new Date("2026-02-01"),
    updatedAt: new Date("2026-02-21"),
    baselineScorecard: null,
    perPageResults: null,
    perPageFixes: null,
    implementationStatus: null,
    ...overrides,
  };
}

/**
 * Wire up sequential db.select() calls.
 * Each element of `sequences` is the row array returned for that call number.
 * Extra calls beyond the provided sequences return [].
 */
function mockSelectSequence(sequences: unknown[][]) {
  let callCount = 0;
  (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
    const rows = sequences[callCount] ?? [];
    callCount++;
    return {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(rows),
    };
  });
}

/**
 * Wire up db.select() where the second call (team lookup) throws.
 */
function mockSelectWithTeamThrow(site: unknown, error: Error) {
  let callCount = 0;
  (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
    callCount++;
    if (callCount === 1) {
      return {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([site]),
      };
    }
    return {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockRejectedValue(error),
    };
  });
}

/**
 * Wire up db.select() where the first call (site lookup) throws.
 */
function mockSelectWithSiteThrow(error: Error) {
  (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => ({
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockRejectedValue(error),
  }));
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("GET /api/sites/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Auth errors ────────────────────────────────────────────────────────────

  describe("auth errors", () => {
    it("no token → 401", async () => {
      const [req, ctx] = makeRequest("site-1"); // no token at all
      const res = await GET(req, ctx);

      expect(res.status).toBe(401);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe("Unauthorized");
      // DB should never be touched when there is no token
      expect(db.select).not.toHaveBeenCalled();
    });

    it("wrong token → 401", async () => {
      const site = makeSite({ accessToken: "valid-token" });
      mockSelectSequence([[site]]);

      const [req, ctx] = makeRequest("site-1", "wrong-token");
      const res = await GET(req, ctx);

      expect(res.status).toBe(401);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe("Unauthorized");
    });

    it("token via ?token= query param → 200", async () => {
      const site = makeSite({ accessToken: "qp-token" });
      mockSelectSequence([[site], [makeTeam()]]);

      const [req, ctx] = makeRequest("site-1", "qp-token", false); // useHeader=false
      const res = await GET(req, ctx);

      expect(res.status).toBe(200);
    });

    it("token via Authorization header → 200", async () => {
      const site = makeSite({ accessToken: "header-token" });
      mockSelectSequence([[site], [makeTeam()]]);

      const [req, ctx] = makeRequest("site-1", "header-token", true); // useHeader=true
      const res = await GET(req, ctx);

      expect(res.status).toBe(200);
    });
  });

  // ── Not found ──────────────────────────────────────────────────────────────

  describe("not found", () => {
    it("site not found → 404", async () => {
      mockSelectSequence([[]]); // empty result

      const [req, ctx] = makeRequest("nonexistent-id", "any-token");
      const res = await GET(req, ctx);

      expect(res.status).toBe(404);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe("Not found");
    });
  });

  // ── Tier derivation edge cases ─────────────────────────────────────────────

  describe("tier derivation", () => {
    it("team DB lookup throws → defaults to free tier, never exposes paid data", async () => {
      const site = makeSite({
        teamId: "team-1",
        generatedLlmsTxt: "# secret content",
      });
      mockSelectWithTeamThrow(site, new Error("DB connection failed"));

      const [req, ctx] = makeRequest("site-1", "valid-token");
      const res = await GET(req, ctx);

      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.tier).toBe("free");
      expect(body.credits).toBe(0);
      expect(body.generatedLlmsTxt).toBeNull();
    });

    it("site has no teamId → free tier", async () => {
      const site = makeSite({ teamId: null });
      // Only one select call — no team lookup when teamId is null
      mockSelectSequence([[site]]);

      const [req, ctx] = makeRequest("site-1", "valid-token");
      const res = await GET(req, ctx);

      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.tier).toBe("free");
      expect(body.credits).toBe(0);
    });

    it("team has creditBalance=0 → free tier", async () => {
      const site = makeSite({ teamId: "team-1" });
      mockSelectSequence([[site], [makeTeam({ creditBalance: 0 })]]);

      const [req, ctx] = makeRequest("site-1", "valid-token");
      const res = await GET(req, ctx);

      const body = await res.json() as Record<string, unknown>;
      expect(body.tier).toBe("free");
      expect(body.credits).toBe(0);
    });

    it("team has creditBalance > 0 → paid tier", async () => {
      const site = makeSite({ teamId: "team-1" });
      mockSelectSequence([[site], [makeTeam({ creditBalance: 30 })]]);

      const [req, ctx] = makeRequest("site-1", "valid-token");
      const res = await GET(req, ctx);

      const body = await res.json() as Record<string, unknown>;
      expect(body.tier).toBe("paid");
      expect(body.credits).toBe(30);
    });

    it("team not found (deleted) → free tier", async () => {
      const site = makeSite({ teamId: "team-deleted" });
      // Second select returns empty — team row gone
      mockSelectSequence([[site], []]);

      const [req, ctx] = makeRequest("site-1", "valid-token");
      const res = await GET(req, ctx);

      const body = await res.json() as Record<string, unknown>;
      expect(body.tier).toBe("free");
      expect(body.credits).toBe(0);
    });
  });

  // ── Tier gating — free users ───────────────────────────────────────────────

  describe("tier gating — free", () => {
    /** Helper: get a 200 free-tier response body. */
    async function getFreeTierBody(siteOverrides: Record<string, unknown> = {}) {
      const site = makeSite({ teamId: null, ...siteOverrides });
      mockSelectSequence([[site]]);
      const [req, ctx] = makeRequest("site-1", "valid-token");
      const res = await GET(req, ctx);
      expect(res.status).toBe(200);
      return res.json() as Promise<Record<string, unknown>>;
    }

    it("geoScorecard pillars are stripped of findings, recommendation, impactedPages", async () => {
      const body = await getFreeTierBody();
      const scorecard = body.geoScorecard as { pillars: Array<Record<string, unknown>> };

      expect(scorecard).not.toBeNull();
      expect(scorecard.pillars.length).toBeGreaterThan(0);

      for (const pillar of scorecard.pillars) {
        // Fields that MUST be present
        expect(pillar).toHaveProperty("pillar");
        expect(pillar).toHaveProperty("pillarName");
        expect(pillar).toHaveProperty("score");
        expect(pillar).toHaveProperty("weight");
        expect(pillar).toHaveProperty("priority");
        // Fields that MUST be stripped
        expect(pillar).not.toHaveProperty("findings");
        expect(pillar).not.toHaveProperty("recommendation");
        expect(pillar).not.toHaveProperty("impactedPages");
      }
    });

    it("executiveSummary is only the first paragraph", async () => {
      const body = await getFreeTierBody({
        executiveSummary: "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.",
      });
      expect(body.executiveSummary).toBe("First paragraph.");
    });

    it("executiveSummary split: only top-level double-newline is used as paragraph boundary", async () => {
      // Single paragraph with no double newlines comes through unchanged
      const body = await getFreeTierBody({ executiveSummary: "Only one paragraph here." });
      expect(body.executiveSummary).toBe("Only one paragraph here.");
    });

    it("only 3 recommendations returned — diagnosis (title/pillar/priority/description/boost) but NOT the deploy-ready fix", async () => {
      const body = await getFreeTierBody({
        rankedRecommendations: [makeRec(1), makeRec(2), makeRec(3), makeRec(4)],
      });

      const recs = body.rankedRecommendations as Array<Record<string, unknown>>;
      expect(recs).toHaveLength(3);

      for (const rec of recs) {
        // Free gets the DIAGNOSIS so the Action Plan is a real showcase…
        expect(Object.keys(rec).sort()).toEqual(["description", "estimatedBoost", "pillar", "priority", "title"]);
        // …but NOT specificAction (the exact deploy-ready fix — the paid value).
        expect(rec).not.toHaveProperty("specificAction");
      }
    });

    it("generated files are null", async () => {
      const body = await getFreeTierBody();

      expect(body.generatedLlmsTxt).toBeNull();
      expect(body.generatedLlmsFullTxt).toBeNull();
      expect(body.generatedBusinessJson).toBeNull();
      expect(body.generatedSchemaBlocks).toBeNull();
    });
  });

  // ── Tier gating — paid users ───────────────────────────────────────────────

  describe("tier gating — paid", () => {
    /** Helper: get a 200 paid-tier response body. */
    async function getPaidTierBody(siteOverrides: Record<string, unknown> = {}) {
      const site = makeSite({ teamId: "team-1", ...siteOverrides });
      mockSelectSequence([[site], [makeTeam({ creditBalance: 50 })]]);
      const [req, ctx] = makeRequest("site-1", "valid-token");
      const res = await GET(req, ctx);
      expect(res.status).toBe(200);
      return res.json() as Promise<Record<string, unknown>>;
    }

    it("full scorecard returned including findings, recommendation, impactedPages", async () => {
      const body = await getPaidTierBody();
      const scorecard = body.geoScorecard as { pillars: Array<Record<string, unknown>> };

      expect(scorecard).not.toBeNull();
      expect(scorecard.pillars.length).toBeGreaterThan(0);

      for (const pillar of scorecard.pillars) {
        expect(pillar).toHaveProperty("findings");
        expect(pillar).toHaveProperty("recommendation");
        expect(pillar).toHaveProperty("impactedPages");
      }
    });

    it("full executiveSummary with all paragraphs", async () => {
      const full = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
      const body = await getPaidTierBody({ executiveSummary: full });
      expect(body.executiveSummary).toBe(full);
    });

    it("all 4 recommendations returned with description field", async () => {
      const body = await getPaidTierBody({
        rankedRecommendations: [makeRec(1), makeRec(2), makeRec(3), makeRec(4)],
      });

      const recs = body.rankedRecommendations as Array<Record<string, unknown>>;
      expect(recs).toHaveLength(4);

      for (const rec of recs) {
        expect(rec).toHaveProperty("description");
        expect(rec).toHaveProperty("title");
        expect(rec).toHaveProperty("pillar");
        expect(rec).toHaveProperty("priority");
      }
    });

    it("generated files present in response", async () => {
      const body = await getPaidTierBody();

      expect(body.generatedLlmsTxt).not.toBeNull();
      expect(body.generatedLlmsFullTxt).not.toBeNull();
      expect(body.generatedBusinessJson).not.toBeNull();
      expect(body.generatedSchemaBlocks).not.toBeNull();

      expect(body.generatedLlmsTxt).toBe("# Example\n> Summary...");
      expect(body.generatedBusinessJson).toEqual({ name: "Example" });
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("site with null geoScorecard → geoScorecard: null in response (free tier)", async () => {
      const site = makeSite({ teamId: null, overallScore: null, pillars: null });
      mockSelectSequence([[site]]);

      const [req, ctx] = makeRequest("site-1", "valid-token");
      const res = await GET(req, ctx);

      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.geoScorecard).toBeNull();
    });

    it("site with empty executiveSummary → empty string in response", async () => {
      const site = makeSite({ teamId: null, executiveSummary: "" });
      mockSelectSequence([[site]]);

      const [req, ctx] = makeRequest("site-1", "valid-token");
      const res = await GET(req, ctx);

      const body = await res.json() as Record<string, unknown>;
      // split("\\n\\n")[0] on "" returns "" — no crash, no undefined
      expect(body.executiveSummary).toBe("");
    });

    it("DB error in main site query → 500", async () => {
      mockSelectWithSiteThrow(new Error("Connection pool exhausted"));

      const [req, ctx] = makeRequest("site-1", "valid-token");
      const res = await GET(req, ctx);

      expect(res.status).toBe(500);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe("Internal server error");
    });
  });

  // ── Diff / previousRunSnapshot ─────────────────────────────────────────────

  describe("diff / previousRunSnapshot", () => {
    it("site with previousScore → diff computed with correct scoreDelta", async () => {
      const site = makeSite({
        teamId: "team-1",
        overallScore: 75,
        previousScore: 60,
        generatedLlmsTxt: "# new content (200 chars)".padEnd(200, "x"),
      });
      mockSelectSequence([[site], [makeTeam({ creditBalance: 50 })]]);

      const [req, ctx] = makeRequest("site-1", "valid-token");
      const res = await GET(req, ctx);

      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;

      expect(body.diff).not.toBeNull();
      const diff = body.diff as Record<string, unknown>;
      // currentScore(75) - previousScore(60) = 15
      expect(diff.scoreDelta).toBe(15);
      expect(diff.previousScore).toBe(60);
      expect(diff.currentScore).toBe(75);
    });

    it("site without previousScore → diff is null", async () => {
      const site = makeSite({
        teamId: "team-1",
        previousScore: null,
      });
      mockSelectSequence([[site], [makeTeam({ creditBalance: 50 })]]);

      const [req, ctx] = makeRequest("site-1", "valid-token");
      const res = await GET(req, ctx);

      const body = await res.json() as Record<string, unknown>;
      expect(body.diff).toBeNull();
    });
  });
});
