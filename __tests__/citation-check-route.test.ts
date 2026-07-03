/**
 * API tests for POST /api/sites/[id]/citation-check — ES-015
 * CCR-1 through CCR-13
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Mocks ────────────────────────────────────────────────────────────────────
// vi.mock calls are hoisted — factory must not reference top-level variables.

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock("@/lib/services/citation-checker", () => ({
  runCitationCheck: vi.fn(),
  aggregateByDimension: vi.fn().mockReturnValue({ geoVisibility: [], categoryVisibility: [], tierVisibility: [] }),
  aggregateCompetitorsByDimension: vi.fn().mockReturnValue({ locationCompetitors: [], categoryCompetitors: [], dominanceMap: { entries: [], computedAt: new Date().toISOString() } }),
  generateDominanceInsights: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/services/citation-prompt-generator", () => ({
  generatePrompts: vi.fn().mockResolvedValue([{ type: "indirect" as const, pillar: "legacy", prompt: "prompt 1" }]),
  extractTopCityNames: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/services/real-prompt-discoverer", () => ({
  discoverRealPrompts: vi.fn().mockResolvedValue([]),
}));

vi.mock("nanoid", () => ({
  nanoid: vi.fn().mockReturnValue("mock-nanoid"),
}));
vi.mock("@/lib/services/site-view-sync", () => ({
  syncSiteView: vi.fn().mockResolvedValue(undefined),
  syncSiteViewStatus: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    allowed: true, remaining: 0, resetAt: Date.now() + 30_000,
  }),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { POST } from "@/app/api/sites/[id]/citation-check/route";
import { db } from "@/lib/db";
import { runCitationCheck, aggregateCompetitorsByDimension } from "@/lib/services/citation-checker";
import { generatePrompts } from "@/lib/services/citation-prompt-generator";
import { discoverRealPrompts } from "@/lib/services/real-prompt-discoverer";

// ─── Constants ────────────────────────────────────────────────────────────────

const SITE_ID = "site-123";
const VALID_TOKEN = "valid-token";

const MOCK_SCORECARD = {
  overallScore: 75,
  pillars: [
    { pillar: "faq_coverage", pillarName: "FAQ Coverage", score: 75, findings: "", recommendation: "", priority: "medium" as const, impactedPages: [] },
  ],
  topThreeImprovements: [],
};

const MOCK_SITE = {
  id: SITE_ID,
  domain: "flowblinq.com",
  accessToken: VALID_TOKEN,
  tokenExpiresAt: new Date(Date.now() + 30 * 86_400_000),  teamId: "team-1",
  geoScorecard: MOCK_SCORECARD,
  // ES-059: pre-populated to skip lazy extraction in tests
  brandKeywords: { keywords: ["flowblinq"], isAmbiguous: false, source: "domain", extractedAt: "2026-01-01T00:00:00Z" },
  extractedCategories: { categories: ["GEO Optimization", "AI Search", "SEO"], entityNoun: "platforms", extractedAt: "2026-01-01T00:00:00Z", source: "haiku" },
};

const MOCK_TEAM = {
  id: "team-1",
  creditBalance: 10,
};

const MOCK_RESPONSE_ROW = {
  id: "r-1",
  checkId: "mock-nanoid",
  siteId: SITE_ID,
  provider: "openai",
  model: "gpt-4o-mini",
  query: "test prompt",
  response: "flowblinq rocks",
  mentioned: true,
  position: 1,
  sentiment: "positive",
  competitorsMentioned: [],
  responseTimeMs: 200,
  error: null,
};

const MOCK_RESULT = {
  responses: [MOCK_RESPONSE_ROW],
  overallVisibility: 100,
  bestProvider: "openai",
  worstProvider: null,
  avgPosition: 1,
  sentimentScore: 100,
  providerResults: [{ provider: "openai", model: "gpt-4o-mini", visibilityScore: 100, avgPosition: 1, sentiment: "positive" as const, mentionCount: 1, totalQueries: 1 }],
  competitorData: [],
  pillarVisibility: { faq_coverage: 100 },
  indirectVisibility: 67,
  brandKnowledge: 100,
  citationQualityScore: 85,
};

const ROUTE_PARAMS = { params: Promise.resolve({ id: SITE_ID }) };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSelectChain(rows: unknown[] = []) {
  return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue(rows) };
}

function makeInsertChain() {
  return { values: vi.fn().mockResolvedValue([]) };
}

function makeUpdateChain() {
  return { set: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) };
}

function makeUpdateReturningChain(returningRows: unknown[] = []) {
  return {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(returningRows),
    }),
  };
}

function makeRequest(token?: string): NextRequest {
  const url = `http://localhost/api/sites/${SITE_ID}/citation-check`;
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return new NextRequest(url, { method: "POST", headers });
}

async function collectSSEEvents(res: Response): Promise<unknown[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let rawText = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    rawText += decoder.decode(value, { stream: true });
  }
  return rawText
    .split("\n\n")
    .filter(Boolean)
    .map(chunk => {
      const line = chunk.replace(/^data: /, "");
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

// ─── CCR-1 & CCR-2: Auth ─────────────────────────────────────────────────────

describe("citation-check-route — auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(generatePrompts).mockResolvedValue([{ type: "indirect" as const, pillar: "legacy", prompt: "prompt 1" }]);
  });

  it("CCR-1 — no auth token → 401", async () => {
    const req = makeRequest(); // no token
    const res = await POST(req, ROUTE_PARAMS);
    expect(res.status).toBe(401);
  });

  it("CCR-2 — wrong token → 401", async () => {
    vi.mocked(db.select).mockReturnValue(makeSelectChain([MOCK_SITE]) as unknown as ReturnType<typeof db.select>);
    const req = makeRequest("wrong-token");
    const res = await POST(req, ROUTE_PARAMS);
    expect(res.status).toBe(401);
  });
});

// ─── CCR-3, CCR-4, CCR-5: Site/team gate ─────────────────────────────────────

describe("citation-check-route — site/team gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(generatePrompts).mockResolvedValue([{ type: "indirect" as const, pillar: "legacy", prompt: "prompt 1" }]);
    vi.mocked(db.update).mockReturnValue(makeUpdateChain() as unknown as ReturnType<typeof db.update>);
    vi.mocked(db.insert).mockImplementation(() => makeInsertChain() as unknown as ReturnType<typeof db.insert>);
  });

  it("CCR-3 — site not found → 404", async () => {
    vi.mocked(db.select).mockReturnValue(makeSelectChain([]) as unknown as ReturnType<typeof db.select>);
    const req = makeRequest(VALID_TOKEN);
    const res = await POST(req, ROUTE_PARAMS);
    expect(res.status).toBe(404);
  });

  it("CCR-4 — no teamId on site → 402 with Pro account error", async () => {
    const siteNoTeam = { ...MOCK_SITE, teamId: null };
    vi.mocked(db.select).mockReturnValue(makeSelectChain([siteNoTeam]) as unknown as ReturnType<typeof db.select>);
    const req = makeRequest(VALID_TOKEN);
    const res = await POST(req, ROUTE_PARAMS);
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toMatch(/Pro account/i);
  });

  it("CCR-5 — insufficient credits (balance=3) → 402 with Insufficient credits error", async () => {
    const teamLowCredits = { ...MOCK_TEAM, creditBalance: 3 };
    let selectCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return makeSelectChain([MOCK_SITE]) as unknown as ReturnType<typeof db.select>;
      return makeSelectChain([teamLowCredits]) as unknown as ReturnType<typeof db.select>;
    });
    const req = makeRequest(VALID_TOKEN);
    const res = await POST(req, ROUTE_PARAMS);
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toBe("insufficient_credits");
  });
});

// ─── CCR-6: Provider gate ────────────────────────────────────────────────────

describe("citation-check-route — provider gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.GEMINI_API_KEY;
    vi.mocked(generatePrompts).mockResolvedValue([{ type: "indirect" as const, pillar: "legacy", prompt: "prompt 1" }]);
    let selectCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return makeSelectChain([MOCK_SITE]) as unknown as ReturnType<typeof db.select>;
      return makeSelectChain([MOCK_TEAM]) as unknown as ReturnType<typeof db.select>;
    });
    vi.mocked(db.update).mockReturnValue(makeUpdateChain() as unknown as ReturnType<typeof db.update>);
    vi.mocked(db.insert).mockImplementation(() => makeInsertChain() as unknown as ReturnType<typeof db.insert>);
  });

  it("CCR-6 — no AI providers configured → 422 with 'No AI providers' error", async () => {
    const req = makeRequest(VALID_TOKEN);
    const res = await POST(req, ROUTE_PARAMS);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/No AI providers/i);
  });
});

// ─── CCR-7 through CCR-13: SSE streaming ─────────────────────────────────────

describe("citation-check-route — SSE streaming", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.GEMINI_API_KEY;

    vi.mocked(generatePrompts).mockResolvedValue([{ type: "indirect" as const, pillar: "legacy", prompt: "prompt 1" }]);
    vi.mocked(runCitationCheck).mockResolvedValue(MOCK_RESULT as ReturnType<typeof runCitationCheck> extends Promise<infer T> ? T : never);

    let selectCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return makeSelectChain([MOCK_SITE]) as unknown as ReturnType<typeof db.select>;
      return makeSelectChain([MOCK_TEAM]) as unknown as ReturnType<typeof db.select>;
    });
    vi.mocked(db.update).mockReturnValue(
      makeUpdateReturningChain([{ creditBalance: 5 }]) as unknown as ReturnType<typeof db.update>
    );
    vi.mocked(db.insert).mockImplementation(() => makeInsertChain() as unknown as ReturnType<typeof db.insert>);
    (db.transaction as ReturnType<typeof vi.fn>).mockImplementation(async (fn: unknown) => (fn as (tx: typeof db) => Promise<unknown>)(db));
  });

  it("CCR-7 — credits deducted upfront: db.update called once, creditTransactions row has creditsChanged: -5", async () => {
    const req = makeRequest(VALID_TOKEN);
    const res = await POST(req, ROUTE_PARAMS);
    await collectSSEEvents(res);

    expect(db.update).toHaveBeenCalledTimes(1);

    const insertValueArgs = vi.mocked(db.insert).mock.results
      .map(r => r.value.values.mock.calls[0]?.[0]);
    const creditTx = insertValueArgs.find((v: unknown) => {
      if (!v || typeof v !== "object") return false;
      return (v as Record<string, unknown>).creditsChanged === -5;
    });
    expect(creditTx).toBeDefined();
  });

  it("CCR-8 — SSE stream emits 'start' event", async () => {
    const req = makeRequest(VALID_TOKEN);
    const res = await POST(req, ROUTE_PARAMS);
    const events = await collectSSEEvents(res);
    expect(events.some((e: unknown) => (e as Record<string, unknown>).type === "start")).toBe(true);
  });

  it("CCR-9 — SSE stream emits 'complete' event with checkId and scores.overallVisibility", async () => {
    vi.mocked(runCitationCheck).mockResolvedValue({ ...MOCK_RESULT, overallVisibility: 75 } as ReturnType<typeof runCitationCheck> extends Promise<infer T> ? T : never);
    const req = makeRequest(VALID_TOKEN);
    const res = await POST(req, ROUTE_PARAMS);
    const events = await collectSSEEvents(res);

    const completeEvent = events.find(
      (e: unknown) => (e as Record<string, unknown>).type === "complete"
    ) as Record<string, unknown> | undefined;
    expect(completeEvent).toBeDefined();
    expect((completeEvent!.scores as Record<string, unknown>).overallVisibility).toBe(75);
    expect(completeEvent!.checkId).toBe("mock-nanoid");
  });

  it("CCR-10 — db.insert called with citationCheckResponses containing 2 rows", async () => {
    vi.mocked(runCitationCheck).mockResolvedValue({
      ...MOCK_RESULT,
      responses: [
        { ...MOCK_RESPONSE_ROW, id: "r-1" },
        { ...MOCK_RESPONSE_ROW, id: "r-2" },
      ],
    } as ReturnType<typeof runCitationCheck> extends Promise<infer T> ? T : never);
    const req = makeRequest(VALID_TOKEN);
    const res = await POST(req, ROUTE_PARAMS);
    await collectSSEEvents(res);

    const insertValueArgs = vi.mocked(db.insert).mock.results
      .map(r => r.value.values.mock.calls[0]?.[0]);
    const responsesInsert = insertValueArgs.find(
      (v: unknown) => Array.isArray(v) && (v as unknown[]).length === 2
    );
    expect(responsesInsert).toBeDefined();
  });

  it("CCR-11 — db.insert called with citationCheckScores with overallVisibility=60 and creditsUsed=5", async () => {
    vi.mocked(runCitationCheck).mockResolvedValue({ ...MOCK_RESULT, overallVisibility: 60 } as ReturnType<typeof runCitationCheck> extends Promise<infer T> ? T : never);
    const req = makeRequest(VALID_TOKEN);
    const res = await POST(req, ROUTE_PARAMS);
    await collectSSEEvents(res);

    const insertValueArgs = vi.mocked(db.insert).mock.results
      .map(r => r.value.values.mock.calls[0]?.[0]);
    const scoresRow = insertValueArgs.find((v: unknown) => {
      if (!v || typeof v !== "object" || Array.isArray(v)) return false;
      const obj = v as Record<string, unknown>;
      return obj.overallVisibility === 60 && obj.creditsUsed === 5;
    });
    expect(scoresRow).toBeDefined();
  });

  it("CCR-12 — runCitationCheck throws → SSE 'error' event emitted, Content-Type is text/event-stream", async () => {
    vi.mocked(runCitationCheck).mockRejectedValue(new Error("LLM timeout"));
    const req = makeRequest(VALID_TOKEN);
    const res = await POST(req, ROUTE_PARAMS);
    const events = await collectSSEEvents(res);

    const errorEvent = events.find(
      (e: unknown) => (e as Record<string, unknown>).type === "error"
    ) as Record<string, unknown> | undefined;
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.message).toBe("LLM timeout");
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
  });

  it("CCR-13 — response headers include correct SSE Content-Type and Cache-Control", async () => {
    const req = makeRequest(VALID_TOKEN);
    const res = await POST(req, ROUTE_PARAMS);
    await collectSSEEvents(res);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
  });

  // FIX-8: verify aggregateCompetitorsByDimension and discoverRealPrompts wired into route
  it("CCR-14 — aggregateCompetitorsByDimension and discoverRealPrompts called; DB insert includes competitive intelligence fields", async () => {
    // Use a site with categoryTree so discoverRealPrompts is triggered
    const siteWithTree = {
      ...MOCK_SITE,
      categoryTree: { root: { id: "root", name: "Root", children: [{ id: "c1", name: "Ortho", pageCount: 10, children: [] }] }, leafCount: 1 },
    };
    let selectCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return makeSelectChain([siteWithTree]) as unknown as ReturnType<typeof db.select>;
      return makeSelectChain([MOCK_TEAM]) as unknown as ReturnType<typeof db.select>;
    });
    vi.mocked(aggregateCompetitorsByDimension).mockReturnValue({
      locationCompetitors: [{ geoId: "in-ka-blr", geoName: "Bangalore", competitors: [] }],
      categoryCompetitors: [],
      dominanceMap: { entries: [], computedAt: new Date().toISOString() },
    });

    const req = makeRequest(VALID_TOKEN);
    const res = await POST(req, ROUTE_PARAMS);
    await collectSSEEvents(res);

    // aggregateCompetitorsByDimension called with correct domain as 3rd arg
    expect(aggregateCompetitorsByDimension).toHaveBeenCalledOnce();
    const callArgs = vi.mocked(aggregateCompetitorsByDimension).mock.calls[0];
    expect(Array.isArray(callArgs[0])).toBe(true); // responses array
    expect(Array.isArray(callArgs[1])).toBe(true); // prompts array
    expect(callArgs[2]).toBe(MOCK_SITE.domain);    // domain

    // discoverRealPrompts called
    expect(discoverRealPrompts).toHaveBeenCalled();

    // DB insert includes locationCompetitors and dominanceMap fields
    const insertValueArgs = vi.mocked(db.insert).mock.results
      .map(r => r.value.values.mock.calls[0]?.[0]);
    const scoresRow = insertValueArgs.find((v: unknown) => {
      if (!v || typeof v !== "object" || Array.isArray(v)) return false;
      const obj = v as Record<string, unknown>;
      return "locationCompetitors" in obj && "dominanceMap" in obj;
    });
    expect(scoresRow).toBeDefined();
  });
});
