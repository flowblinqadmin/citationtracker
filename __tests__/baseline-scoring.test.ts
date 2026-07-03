/**
 * Baseline Scoring Tests — Before/After GEO Scoring
 *
 * Tests baseline capture, backfill, and API delta response per ES-004 spec (Task 3, #9).
 * 11 test cases covering:
 *   15. First run: baseline captured from geoScorecard
 *   16. Second run: baseline unchanged
 *   17. Backfill from previousRunSnapshot
 *   18. No snapshot, no baseline: use current run
 *   19. API: improvementDelta calculated correctly
 *   20. API: improvementDelta null when no baseline
 *   21. API: improvementDelta zero (same score)
 *   22. API: negative delta (score decreased)
 *   23. Paid tier: pillarDeltas included
 *   24. Free tier: pillarDeltas excluded
 *   25. Free tier: baselineScore number still visible
 *
 * These tests are written BEFORE implementation (test-first).
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
  },
}));

import { db } from "@/lib/db";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeScorecard(overallScore: number, pillars?: Array<{ pillar: string; score: number }>) {
  return {
    overallScore,
    pillars: pillars ?? [
      { pillar: "structured_data", pillarName: "Structured Data", score: overallScore - 10, findings: "f", recommendation: "r", priority: "medium" as const, impactedPages: [], weight: 1 },
      { pillar: "content_authority", pillarName: "Content Authority", score: overallScore + 5, findings: "f", recommendation: "r", priority: "high" as const, impactedPages: [], weight: 1 },
    ],
    topThreeImprovements: ["a", "b", "c"],
  };
}

function makeSelectChain(rows: unknown[] = []) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
    limit: vi.fn().mockReturnThis(),
  };
}

function makeTeamRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "team-1",
    name: "Test Team",
    ownerUserId: "user-1",
    creditBalance: 100,
    stripeCustomerId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeSiteRow(overrides: Record<string, unknown> = {}) {
  const scorecard = makeScorecard(67);
  return {
    siteId: "site-1",
    domain: "example.com",
    slug: "example-com",
    teamId: "team-1",
    accessToken: "test-token",
    tokenExpiresAt: new Date(Date.now() + 30 * 86_400_000),
    pipelineStatus: "complete",
    pipelineError: null,
    overallScore: scorecard.overallScore,
    pillars: scorecard.pillars,
    previousScore: null,
    projectedScore: 75,
    projectedBoost: 8,
    baselineScore: null,
    executiveSummary: "Summary here.",
    rankedRecommendations: [],
    generatedLlmsTxt: "# llms",
    generatedLlmsFullTxt: "# full llms",
    generatedBusinessJson: { name: "Test" },
    generatedSchemaBlocks: [{ name: "Org" }],
    discoveryData: {},
    platformDetected: "wordpress",
    shareToken: "share-abc",
    domainVerified: false,
    verifyToken: "vt-123",
    changeLog: [],
    manualRunsMonth: 0,
    crawlCount: 2,
    pageCount: 0,
    lastCrawlAt: new Date("2026-02-20"),
    nextCrawlAt: new Date("2026-03-20"),
    createdAt: new Date("2026-02-01"),
    baselineScorecard: null,
    perPageResults: null,
    perPageFixes: null,
    implementationStatus: null,
    ...overrides,
  };
}

function setupSequentialSelects(...callResults: unknown[][]) {
  let idx = 0;
  (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
    const rows = callResults[idx] ?? [];
    idx++;
    return makeSelectChain(rows);
  });
}

// ─── Pipeline Baseline Logic Tests ──────────────────────────────────────────

describe("Baseline scoring — pipeline capture logic", () => {
  /**
   * These tests verify the baseline capture logic that runs inside
   * completePipeline(). We test the logic in isolation — the actual
   * function will be tested in integration tests.
   */

  // ── Test 15: First run captures baseline ──

  it("15. first run: baseline captured from geoScorecard", () => {
    const site = { baselineScorecard: null as unknown, previousRunSnapshot: null };
    const geoScorecard = makeScorecard(55);

    // Logic from spec: if no baseline, prefer snapshot, else use current
    let baselineScorecard = site.baselineScorecard;
    if (!baselineScorecard) {
      const snapshot = site.previousRunSnapshot as { geoScorecard?: unknown } | null;
      if (snapshot?.geoScorecard) {
        baselineScorecard = snapshot.geoScorecard;
      } else if (geoScorecard) {
        baselineScorecard = geoScorecard;
      }
    }

    expect(baselineScorecard).toEqual(geoScorecard);
    expect((baselineScorecard as { overallScore: number }).overallScore).toBe(55);
  });

  // ── Test 16: Second run does NOT overwrite baseline ──

  it("16. second run: baseline remains unchanged", () => {
    const existingBaseline = makeScorecard(40);
    const site = { baselineScorecard: existingBaseline, previousRunSnapshot: null };
    const geoScorecard = makeScorecard(67);

    let baselineScorecard: unknown = site.baselineScorecard;
    if (!baselineScorecard) {
      const snapshot = site.previousRunSnapshot as { geoScorecard?: unknown } | null;
      if (snapshot?.geoScorecard) {
        baselineScorecard = snapshot.geoScorecard;
      } else if (geoScorecard) {
        baselineScorecard = geoScorecard;
      }
    }

    // Should still be the original baseline, not the new scorecard
    expect(baselineScorecard).toEqual(existingBaseline);
    expect((baselineScorecard as { overallScore: number }).overallScore).toBe(40);
  });

  // ── Test 17: Backfill from previousRunSnapshot ──

  it("17. backfill: uses previousRunSnapshot.geoScorecard as baseline", () => {
    const snapshotScorecard = makeScorecard(23);
    const site = {
      baselineScorecard: null as unknown,
      previousRunSnapshot: { geoScorecard: snapshotScorecard },
    };
    const geoScorecard = makeScorecard(67);

    let baselineScorecard = site.baselineScorecard;
    if (!baselineScorecard) {
      const snapshot = site.previousRunSnapshot as { geoScorecard?: unknown } | null;
      if (snapshot?.geoScorecard) {
        baselineScorecard = snapshot.geoScorecard;
      } else if (geoScorecard) {
        baselineScorecard = geoScorecard;
      }
    }

    // Should use snapshot, not current run
    expect(baselineScorecard).toEqual(snapshotScorecard);
    expect((baselineScorecard as { overallScore: number }).overallScore).toBe(23);
  });

  // ── Test 18: No snapshot, no baseline → use current ──

  it("18. no snapshot, no baseline: uses current geoScorecard", () => {
    const site = { baselineScorecard: null as unknown, previousRunSnapshot: null };
    const geoScorecard = makeScorecard(50);

    let baselineScorecard = site.baselineScorecard;
    if (!baselineScorecard) {
      const snapshot = site.previousRunSnapshot as { geoScorecard?: unknown } | null;
      if (snapshot?.geoScorecard) {
        baselineScorecard = snapshot.geoScorecard;
      } else if (geoScorecard) {
        baselineScorecard = geoScorecard;
      }
    }

    expect(baselineScorecard).toEqual(geoScorecard);
  });
});

// ─── API Response — Baseline Fields ─────────────────────────────────────────

describe("Baseline scoring — API response fields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Test 19: improvementDelta calculated ──

  it("19. API returns correct improvementDelta (baseline=23, current=67 → delta=44)", async () => {
    const { GET } = await import("@/app/api/sites/[id]/route");
    const { NextRequest } = await import("next/server");

    const site = makeSiteRow({
      teamId: "team-1",
      baselineScore: 23,
      baselineScorecard: makeScorecard(23),
      overallScore: 67,
      pillars: makeScorecard(67).pillars,
    });

    setupSequentialSelects([site], [makeTeamRow({ creditBalance: 100 })]);

    const req = new NextRequest(
      new Request("http://localhost/api/sites/site-1", {
        headers: { authorization: "Bearer test-token" },
      })
    );
    const res = await GET(req, { params: Promise.resolve({ id: "site-1" }) });
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.baselineScore).toBe(23);
    expect(body.improvementDelta).toBe(44);
  });

  // ── Test 20: improvementDelta null when no baseline ──

  it("20. API returns improvementDelta=null when no baselineScorecard", async () => {
    const { GET } = await import("@/app/api/sites/[id]/route");
    const { NextRequest } = await import("next/server");

    const site = makeSiteRow({
      teamId: "team-1",
      baselineScore: null,
      baselineScorecard: null,
      overallScore: 67,
      pillars: makeScorecard(67).pillars,
    });

    setupSequentialSelects([site], [makeTeamRow({ creditBalance: 100 })]);

    const req = new NextRequest(
      new Request("http://localhost/api/sites/site-1", {
        headers: { authorization: "Bearer test-token" },
      })
    );
    const res = await GET(req, { params: Promise.resolve({ id: "site-1" }) });
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.baselineScore).toBeNull();
    expect(body.improvementDelta).toBeNull();
  });

  // ── Test 21: improvementDelta zero ──

  it("21. API returns improvementDelta=0 when baseline equals current", async () => {
    const { GET } = await import("@/app/api/sites/[id]/route");
    const { NextRequest } = await import("next/server");

    const site = makeSiteRow({
      teamId: "team-1",
      baselineScore: 50,
      baselineScorecard: makeScorecard(50),
      overallScore: 50,
      pillars: makeScorecard(50).pillars,
    });

    setupSequentialSelects([site], [makeTeamRow({ creditBalance: 100 })]);

    const req = new NextRequest(
      new Request("http://localhost/api/sites/site-1", {
        headers: { authorization: "Bearer test-token" },
      })
    );
    const res = await GET(req, { params: Promise.resolve({ id: "site-1" }) });
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.improvementDelta).toBe(0);
  });

  // ── Test 22: negative delta ──

  it("22. API returns negative improvementDelta when score decreased", async () => {
    const { GET } = await import("@/app/api/sites/[id]/route");
    const { NextRequest } = await import("next/server");

    const site = makeSiteRow({
      teamId: "team-1",
      baselineScore: 70,
      baselineScorecard: makeScorecard(70),
      overallScore: 60,
      pillars: makeScorecard(60).pillars,
    });

    setupSequentialSelects([site], [makeTeamRow({ creditBalance: 100 })]);

    const req = new NextRequest(
      new Request("http://localhost/api/sites/site-1", {
        headers: { authorization: "Bearer test-token" },
      })
    );
    const res = await GET(req, { params: Promise.resolve({ id: "site-1" }) });
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.improvementDelta).toBe(-10);
  });

  // ── Test 23: Paid tier gets pillarDeltas ──

  it("23. paid tier: pillarDeltas included with per-pillar before/after", async () => {
    const { GET } = await import("@/app/api/sites/[id]/route");
    const { NextRequest } = await import("next/server");

    const baselinePillars = [
      { pillar: "structured_data", pillarName: "Structured Data", score: 30, findings: "f", recommendation: "r", priority: "medium" as const, impactedPages: [], weight: 1 },
      { pillar: "content_authority", pillarName: "Content Authority", score: 40, findings: "f", recommendation: "r", priority: "high" as const, impactedPages: [], weight: 1 },
    ];
    const currentPillars = [
      { pillar: "structured_data", pillarName: "Structured Data", score: 60, findings: "f", recommendation: "r", priority: "medium" as const, impactedPages: [], weight: 1 },
      { pillar: "content_authority", pillarName: "Content Authority", score: 55, findings: "f", recommendation: "r", priority: "high" as const, impactedPages: [], weight: 1 },
    ];

    const site = makeSiteRow({
      teamId: "team-1",
      baselineScore: 35,
      baselineScorecard: { overallScore: 35, pillars: baselinePillars, topThreeImprovements: [] },
      overallScore: 58,
      pillars: currentPillars,
    });

    setupSequentialSelects([site], [makeTeamRow({ creditBalance: 100 })]);

    const req = new NextRequest(
      new Request("http://localhost/api/sites/site-1", {
        headers: { authorization: "Bearer test-token" },
      })
    );
    const res = await GET(req, { params: Promise.resolve({ id: "site-1" }) });
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.tier).toBe("paid");
    expect(body.pillarDeltas).toBeDefined();
    const deltas = body.pillarDeltas as Array<{ pillar: string; before: number; after: number; delta: number }>;
    expect(deltas).toHaveLength(2);

    const sd = deltas.find((d) => d.pillar === "structured_data");
    expect(sd?.before).toBe(30);
    expect(sd?.after).toBe(60);
    expect(sd?.delta).toBe(30);

    const ca = deltas.find((d) => d.pillar === "content_authority");
    expect(ca?.before).toBe(40);
    expect(ca?.after).toBe(55);
    expect(ca?.delta).toBe(15);
  });

  // ── Test 24: Free tier: pillarDeltas excluded ──

  it("24. free tier: pillarDeltas and baselineScorecard NOT in response", async () => {
    const { GET } = await import("@/app/api/sites/[id]/route");
    const { NextRequest } = await import("next/server");

    const site = makeSiteRow({
      teamId: null,
      baselineScore: 23,
      baselineScorecard: makeScorecard(23),
      overallScore: 67,
      pillars: makeScorecard(67).pillars,
    });

    setupSequentialSelects([site]);

    const req = new NextRequest(
      new Request("http://localhost/api/sites/site-1", {
        headers: { authorization: "Bearer test-token" },
      })
    );
    const res = await GET(req, { params: Promise.resolve({ id: "site-1" }) });
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.tier).toBe("free");
    expect(body.pillarDeltas).toBeUndefined();
    expect(body.baselineScorecard).toBeUndefined();
  });

  // ── Test 25: Free tier: baselineScore number still visible ──

  it("25. free tier: baselineScore and improvementDelta numbers are visible", async () => {
    const { GET } = await import("@/app/api/sites/[id]/route");
    const { NextRequest } = await import("next/server");

    const site = makeSiteRow({
      teamId: null,
      baselineScore: 23,
      baselineScorecard: makeScorecard(23),
      overallScore: 67,
      pillars: makeScorecard(67).pillars,
    });

    setupSequentialSelects([site]);

    const req = new NextRequest(
      new Request("http://localhost/api/sites/site-1", {
        headers: { authorization: "Bearer test-token" },
      })
    );
    const res = await GET(req, { params: Promise.resolve({ id: "site-1" }) });
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.tier).toBe("free");
    // Numbers are free-tier visible per spec
    expect(body.baselineScore).toBe(23);
    expect(body.improvementDelta).toBe(44);
  });
});
