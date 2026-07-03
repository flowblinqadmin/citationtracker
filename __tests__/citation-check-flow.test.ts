/**
 * Integration tests — Citation Check Flow (ES-027)
 * CF-1 through CF-5: new score fields, promptType in SSE events, pillar null for direct,
 * fallback CitationPrompt[] shape, 402/422 gates unchanged.
 *
 * ES-027 replaces ES-024's single-type prompts with CitationPrompt[] that carries
 * type: "indirect" | "direct" and pillar: string | null.
 * Three new aggregate metrics land in the complete SSE event:
 *   - indirectVisibility  (domain-absent prompt responses only)
 *   - brandKnowledge      (domain-present prompt responses only)
 *   - citationQualityScore (avg of per-mention quality signals)
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { CitationPrompt } from "@/lib/services/citation-prompt-generator";
import type { GeoScorecard } from "@/lib/services/geo-analyzer";

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("@/lib/services/citation-checker", () => ({
  runCitationCheck: vi.fn(),
  aggregateByDimension: vi.fn().mockReturnValue({ geoVisibility: [], categoryVisibility: [], tierVisibility: [] }),
  aggregateCompetitorsByDimension: vi.fn().mockReturnValue({ locationCompetitors: [], categoryCompetitors: [], dominanceMap: { entries: [], computedAt: new Date().toISOString() } }),
  generateDominanceInsights: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/services/citation-prompt-generator", () => ({
  generatePrompts: vi.fn(),
  extractTopCityNames: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/services/real-prompt-discoverer", () => ({
  discoverRealPrompts: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    allowed: true, remaining: 0, resetAt: Date.now() + 30_000,
  }),
}));

vi.mock("nanoid", () => ({
  nanoid: vi.fn().mockReturnValue("mock-nanoid"),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { POST } from "@/app/api/sites/[id]/citation-check/route";
import { db } from "@/lib/db";
import { runCitationCheck } from "@/lib/services/citation-checker";
import { generatePrompts } from "@/lib/services/citation-prompt-generator";

// ─── Constants ────────────────────────────────────────────────────────────────

const SITE_ID = "site-es027";
const VALID_TOKEN = "valid-token-es027";

const PILLAR_IDS = [
  "metadata_freshness", "semantic_html", "structured_data", "entity_definitions",
  "faq_coverage", "evidence_statistics", "content_structure", "author_authority",
  "internal_linking", "content_freshness", "multi_format", "licensing_signals",
  "contact_trust", "competitive_positioning", "offering_clarity", "cta_structure",
];

const ROUTE_PARAMS = { params: Promise.resolve({ id: SITE_ID }) };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockScorecard(): GeoScorecard {
  const pillars = PILLAR_IDS.map(id => ({
    pillar: id,
    pillarName: id,
    score: 50,
    findings: "test findings",
    recommendation: "improve",
    priority: "medium" as const,
    impactedPages: [],
  }));
  return { overallScore: 50, pillars, topThreeImprovements: [] };
}

/** 48 CitationPrompt items: 40 indirect (2-3 per pillar) + 8 direct (domain-present). */
function make48Prompts(): CitationPrompt[] {
  const indirect: CitationPrompt[] = PILLAR_IDS.flatMap(pillar => [
    { type: "indirect" as const, pillar, prompt: `Best tools for ${pillar}?` },
    { type: "indirect" as const, pillar, prompt: `Who leads in ${pillar}?` },
    { type: "indirect" as const, pillar, prompt: `How to evaluate ${pillar}?` },
  ]);
  const direct: CitationPrompt[] = [
    { type: "direct" as const, pillar: null, prompt: "What is flowblinq.com?" },
    { type: "direct" as const, pillar: null, prompt: "Is flowblinq.com trustworthy?" },
    { type: "direct" as const, pillar: null, prompt: "Who should use flowblinq.com?" },
    { type: "direct" as const, pillar: null, prompt: "How does flowblinq.com compare to alternatives?" },
    { type: "direct" as const, pillar: null, prompt: "What features does flowblinq.com offer?" },
    { type: "direct" as const, pillar: null, prompt: "What do users say about flowblinq.com?" },
    { type: "direct" as const, pillar: null, prompt: "Is flowblinq.com recommended for SaaS?" },
    { type: "direct" as const, pillar: null, prompt: "How does flowblinq.com stay current with AI changes?" },
  ];
  return [...indirect.slice(0, 40), ...direct]; // 48 total
}

/** Haiku fallback: 4 CitationPrompt items (2 indirect, 2 direct) with type + pillar fields. */
function makeFallbackPrompts(): CitationPrompt[] {
  return [
    { type: "indirect" as const, pillar: "faq_coverage", prompt: "Best GEO optimization tools in 2026?" },
    { type: "indirect" as const, pillar: "offering_clarity", prompt: "Leading AI search optimization platforms?" },
    { type: "direct" as const, pillar: null, prompt: "What is flowblinq.com and what does it offer?" },
    { type: "direct" as const, pillar: null, prompt: "Is flowblinq.com worth using for GEO?" },
  ];
}

const MOCK_SITE = {
  id: SITE_ID,
  domain: "flowblinq.com",
  accessToken: VALID_TOKEN,
  tokenExpiresAt: new Date(Date.now() + 30 * 86_400_000),  teamId: "team-es027",
  geoScorecard: mockScorecard(),
};

const MOCK_TEAM = {
  id: "team-es027",
  creditBalance: 10,
};

const MOCK_RESPONSE_ROW = {
  id: "r-1",
  checkId: "mock-nanoid",
  siteId: SITE_ID,
  provider: "openai",
  model: "gpt-4o-mini",
  query: "test prompt",
  pillar: "faq_coverage",
  promptType: "indirect",
  response: "flowblinq is great",
  mentioned: true,
  position: 1,
  sentiment: "positive",
  competitorsMentioned: [],
  responseTimeMs: 200,
  error: null,
};

function makeSelectChain(rows: unknown[] = []) {
  return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue(rows) };
}

function makeInsertChain() {
  return { values: vi.fn().mockResolvedValue([]) };
}

function makeUpdateChain() {
  return { set: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) };
}

function makeRequest(token?: string): NextRequest {
  const url = `http://localhost/api/sites/${SITE_ID}/citation-check`;
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return new NextRequest(url, { method: "POST", headers });
}

async function collectSSEEvents(res: Response): Promise<Record<string, unknown>[]> {
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
      try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; }
    })
    .filter((e): e is Record<string, unknown> => e !== null);
}

/** Wire up db.select to return site then team on successive calls. */
function setupDbMocks(site: unknown = MOCK_SITE, team: unknown = MOCK_TEAM) {
  let selectCount = 0;
  vi.mocked(db.select).mockImplementation(() => {
    selectCount++;
    return makeSelectChain(selectCount === 1 ? [site] : [team]) as unknown as ReturnType<typeof db.select>;
  });
  vi.mocked(db.update).mockReturnValue(makeUpdateChain() as unknown as ReturnType<typeof db.update>);
  vi.mocked(db.insert).mockImplementation(() => makeInsertChain() as unknown as ReturnType<typeof db.insert>);
}

// ─── CF-1: New score fields in complete event ─────────────────────────────────

describe("CF-1: complete SSE event contains indirectVisibility, brandKnowledge, citationQualityScore (ES-027)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = "test-key";
    setupDbMocks();
    vi.mocked(generatePrompts).mockResolvedValue(make48Prompts());
    vi.mocked(runCitationCheck).mockResolvedValue({
      responses: [MOCK_RESPONSE_ROW],
      providerResults: [],
      overallVisibility: 75,
      sentimentScore: 80,
      avgPosition: 1,
      bestProvider: "openai",
      worstProvider: null,
      competitorData: [],
      pillarVisibility: Object.fromEntries(PILLAR_IDS.map(id => [id, 100])),
      indirectVisibility: 67,
      brandKnowledge: 100,
      citationQualityScore: 85,
    } as ReturnType<typeof runCitationCheck> extends Promise<infer T> ? T : never);
  });

  it("complete event scores contain indirectVisibility: 67", async () => {
    const res = await POST(makeRequest(VALID_TOKEN), ROUTE_PARAMS);
    const events = await collectSSEEvents(res);

    const completeEvent = events.find(e => e.type === "complete");
    expect(completeEvent).toBeDefined();
    const scores = completeEvent!.scores as Record<string, unknown>;
    expect(scores.indirectVisibility).toBe(67);
  });

  it("complete event scores contain brandKnowledge: 100", async () => {
    const res = await POST(makeRequest(VALID_TOKEN), ROUTE_PARAMS);
    const events = await collectSSEEvents(res);

    const completeEvent = events.find(e => e.type === "complete");
    const scores = completeEvent!.scores as Record<string, unknown>;
    expect(scores.brandKnowledge).toBe(100);
  });

  it("complete event scores contain citationQualityScore: 85", async () => {
    const res = await POST(makeRequest(VALID_TOKEN), ROUTE_PARAMS);
    const events = await collectSSEEvents(res);

    const completeEvent = events.find(e => e.type === "complete");
    const scores = completeEvent!.scores as Record<string, unknown>;
    expect(scores.citationQualityScore).toBe(85);
  });

  it("all three new scores are present simultaneously in the same complete event", async () => {
    const res = await POST(makeRequest(VALID_TOKEN), ROUTE_PARAMS);
    const events = await collectSSEEvents(res);

    const completeEvent = events.find(e => e.type === "complete");
    expect(completeEvent).toBeDefined();
    const scores = completeEvent!.scores as Record<string, unknown>;
    expect(scores).toHaveProperty("indirectVisibility");
    expect(scores).toHaveProperty("brandKnowledge");
    expect(scores).toHaveProperty("citationQualityScore");
  });
});

// ─── CF-2: promptType in prompt-generated events ──────────────────────────────

describe("CF-2: prompt-generated SSE events include promptType field (ES-027)", () => {
  const MIXED_PROMPTS: CitationPrompt[] = [
    { type: "indirect" as const, pillar: "faq_coverage", prompt: "Common GEO tools questions?" },
    { type: "indirect" as const, pillar: "author_authority", prompt: "Who leads AI search optimization?" },
    { type: "direct" as const, pillar: null, prompt: "What is flowblinq.com?" },
    { type: "direct" as const, pillar: null, prompt: "Is flowblinq.com trustworthy?" },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = "test-key";
    setupDbMocks();
    vi.mocked(generatePrompts).mockResolvedValue(MIXED_PROMPTS);

    // Simulate route calling onAnalysisStart with promptType (6th param)
    vi.mocked(runCitationCheck).mockImplementation(
      async (_checkId, _siteId, _domain, prompts, callbacks) => {
        for (let i = 0; i < prompts.length; i++) {
          const { prompt, pillar, type: promptType } = prompts[i];
          callbacks.onAnalysisStart("openai", prompt, i, prompts.length, pillar, promptType);
        }
        return {
          responses: [MOCK_RESPONSE_ROW],
          providerResults: [],
          overallVisibility: 75,
          sentimentScore: 80,
          avgPosition: 1,
          bestProvider: "openai",
          worstProvider: null,
          competitorData: [],
          pillarVisibility: { faq_coverage: 100, author_authority: 100 },
          indirectVisibility: 100,
          brandKnowledge: 100,
          citationQualityScore: 100,
        };
      }
    );
  });

  it("every prompt-generated event has a promptType field of 'indirect' or 'direct'", async () => {
    const res = await POST(makeRequest(VALID_TOKEN), ROUTE_PARAMS);
    expect(res.status).toBe(200);

    const events = await collectSSEEvents(res);
    const promptGeneratedEvents = events.filter(e => e.type === "prompt-generated");
    expect(promptGeneratedEvents.length).toBeGreaterThan(0);

    promptGeneratedEvents.forEach(event => {
      expect(["indirect", "direct"]).toContain(event.promptType);
    });
  });

  it("indirect prompts yield promptType: 'indirect'; direct prompts yield promptType: 'direct'", async () => {
    const res = await POST(makeRequest(VALID_TOKEN), ROUTE_PARAMS);
    const events = await collectSSEEvents(res);

    const promptGeneratedEvents = events.filter(e => e.type === "prompt-generated");
    const indirectEvents = promptGeneratedEvents.filter(e => e.promptType === "indirect");
    const directEvents   = promptGeneratedEvents.filter(e => e.promptType === "direct");

    // 2 indirect prompts + 2 direct prompts in MIXED_PROMPTS
    expect(indirectEvents.length).toBeGreaterThan(0);
    expect(directEvents.length).toBeGreaterThan(0);
  });
});

// ─── CF-3: pillar null for direct prompts in SSE events ──────────────────────

describe("CF-3: pillar is null in prompt-generated events for direct CitationPrompts (ES-027)", () => {
  const MIXED_PROMPTS: CitationPrompt[] = [
    { type: "indirect" as const, pillar: "faq_coverage", prompt: "Common GEO tools questions?" },
    { type: "direct" as const, pillar: null, prompt: "What is flowblinq.com?" },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = "test-key";
    setupDbMocks();
    vi.mocked(generatePrompts).mockResolvedValue(MIXED_PROMPTS);

    vi.mocked(runCitationCheck).mockImplementation(
      async (_checkId, _siteId, _domain, prompts, callbacks) => {
        for (let i = 0; i < prompts.length; i++) {
          const { prompt, pillar, type: promptType } = prompts[i];
          callbacks.onAnalysisStart("openai", prompt, i, prompts.length, pillar, promptType);
        }
        return {
          responses: [MOCK_RESPONSE_ROW],
          providerResults: [],
          overallVisibility: 75,
          sentimentScore: 80,
          avgPosition: 1,
          bestProvider: "openai",
          worstProvider: null,
          competitorData: [],
          pillarVisibility: { faq_coverage: 100 },
          indirectVisibility: 100,
          brandKnowledge: 100,
          citationQualityScore: 100,
        };
      }
    );
  });

  it("indirect prompt-generated events have string pillar; direct events have null pillar", async () => {
    const res = await POST(makeRequest(VALID_TOKEN), ROUTE_PARAMS);
    expect(res.status).toBe(200);

    const events = await collectSSEEvents(res);
    const promptGeneratedEvents = events.filter(e => e.type === "prompt-generated");

    const indirectEvents = promptGeneratedEvents.filter(e => e.promptType === "indirect");
    const directEvents   = promptGeneratedEvents.filter(e => e.promptType === "direct");

    expect(indirectEvents.length).toBeGreaterThan(0);
    expect(directEvents.length).toBeGreaterThan(0);

    indirectEvents.forEach(e => {
      expect(typeof e.pillar).toBe("string");
      expect((e.pillar as string).length).toBeGreaterThan(0);
    });
    directEvents.forEach(e => {
      expect(e.pillar).toBeNull();
    });
  });
});

// ─── CF-4: Haiku failure → OpenAI fallback → 48 prompts (ES-028) ─────────────

describe("CF-4: Haiku failure — OpenAI fallback returns 48 CitationPrompt[] to checker (ES-028)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = "test-key";
    setupDbMocks();
    // generatePrompts fell back to OpenAI and succeeded → 48 CitationPrompt[] items
    vi.mocked(generatePrompts).mockResolvedValue(make48Prompts());
    vi.mocked(runCitationCheck).mockResolvedValue({
      responses: [MOCK_RESPONSE_ROW],
      providerResults: [],
      overallVisibility: 75,
      sentimentScore: 80,
      avgPosition: 1,
      bestProvider: "openai",
      worstProvider: null,
      competitorData: [],
      pillarVisibility: Object.fromEntries(PILLAR_IDS.map(id => [id, 100])),
      indirectVisibility: 67,
      brandKnowledge: 100,
      citationQualityScore: 85,
    } as ReturnType<typeof runCitationCheck> extends Promise<infer T> ? T : never);
  });

  it("route calls runCitationCheck with all 48 prompts from the OpenAI fallback", async () => {
    const res = await POST(makeRequest(VALID_TOKEN), ROUTE_PARAMS);
    expect(res.status).toBe(200);
    await collectSSEEvents(res);

    expect(runCitationCheck).toHaveBeenCalledTimes(1);
    const promptsArg = vi.mocked(runCitationCheck).mock.calls[0][3] as CitationPrompt[];
    expect(promptsArg).toHaveLength(48);
  });

  it("all 48 prompts have correct CitationPrompt shape (type + pillar + prompt)", async () => {
    const res = await POST(makeRequest(VALID_TOKEN), ROUTE_PARAMS);
    await collectSSEEvents(res);

    const promptsArg = vi.mocked(runCitationCheck).mock.calls[0][3] as CitationPrompt[];
    promptsArg.forEach(p => {
      expect(["indirect", "direct"]).toContain(p.type);
      expect(typeof p.prompt).toBe("string");
    });
    // direct prompts have pillar: null
    promptsArg.filter(p => p.type === "direct").forEach(p => expect(p.pillar).toBeNull());
    // indirect prompts have string pillar
    promptsArg.filter(p => p.type === "indirect").forEach(p => expect(typeof p.pillar).toBe("string"));
  });

  it("complete SSE event contains all three new score fields from the OpenAI fallback run", async () => {
    const res = await POST(makeRequest(VALID_TOKEN), ROUTE_PARAMS);
    const events = await collectSSEEvents(res);

    const completeEvent = events.find(e => e.type === "complete");
    expect(completeEvent).toBeDefined();
    const scores = completeEvent!.scores as Record<string, unknown>;
    expect(scores).toHaveProperty("indirectVisibility");
    expect(scores).toHaveProperty("brandKnowledge");
    expect(scores).toHaveProperty("citationQualityScore");
  });
});

// ─── CF-6: All prompt providers fail → 4 legacy prompts (ES-028) ─────────────

describe("CF-6: all prompt providers fail — 4 legacy CitationPrompt[] passed to checker (ES-028)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = "test-key";
    setupDbMocks();
    // generatePrompts exhausted all providers → returns 4 legacy CitationPrompt[] items
    vi.mocked(generatePrompts).mockResolvedValue(makeFallbackPrompts());
    vi.mocked(runCitationCheck).mockResolvedValue({
      responses: [MOCK_RESPONSE_ROW],
      providerResults: [],
      overallVisibility: 50,
      sentimentScore: 60,
      avgPosition: 2,
      bestProvider: "openai",
      worstProvider: null,
      competitorData: [],
      pillarVisibility: { faq_coverage: 50, offering_clarity: 50 },
      indirectVisibility: 50,
      brandKnowledge: 50,
      citationQualityScore: 60,
    } as ReturnType<typeof runCitationCheck> extends Promise<infer T> ? T : never);
  });

  it("route passes all 4 legacy prompts to runCitationCheck without error", async () => {
    const res = await POST(makeRequest(VALID_TOKEN), ROUTE_PARAMS);
    expect(res.status).toBe(200);
    await collectSSEEvents(res);

    expect(runCitationCheck).toHaveBeenCalledTimes(1);
    const promptsArg = vi.mocked(runCitationCheck).mock.calls[0][3] as CitationPrompt[];
    expect(promptsArg).toHaveLength(4);
    // direct prompts have pillar: null
    promptsArg.filter(p => p.type === "direct").forEach(p => expect(p.pillar).toBeNull());
    // indirect prompts have string pillar
    promptsArg.filter(p => p.type === "indirect").forEach(p => expect(typeof p.pillar).toBe("string"));
  });

  it("complete SSE event still emitted with all score fields when only 4 legacy prompts used", async () => {
    const res = await POST(makeRequest(VALID_TOKEN), ROUTE_PARAMS);
    const events = await collectSSEEvents(res);

    const completeEvent = events.find(e => e.type === "complete");
    expect(completeEvent).toBeDefined();
    const scores = completeEvent!.scores as Record<string, unknown>;
    expect(scores).toHaveProperty("indirectVisibility");
    expect(scores).toHaveProperty("brandKnowledge");
    expect(scores).toHaveProperty("citationQualityScore");
  });
});

// ─── CF-5: 402/422 gates unchanged ───────────────────────────────────────────

describe("CF-5: 402/422 gates unchanged from ES-024 (ES-027)", () => {
  it("402 returned when team has zero credits — generatePrompts not called", async () => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = "test-key";

    let selectCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      selectCount++;
      const teamNoCreds = { ...MOCK_TEAM, creditBalance: 0 };
      return makeSelectChain(selectCount === 1 ? [MOCK_SITE] : [teamNoCreds]) as unknown as ReturnType<typeof db.select>;
    });

    const res = await POST(makeRequest(VALID_TOKEN), ROUTE_PARAMS);
    expect(res.status).toBe(402);
    expect(generatePrompts).not.toHaveBeenCalled();
    expect(runCitationCheck).not.toHaveBeenCalled();
  });

  it("422 returned when site.geoScorecard is null — generatePrompts not called", async () => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = "test-key";

    const siteNoScorecard = { ...MOCK_SITE, geoScorecard: null };
    let selectCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      selectCount++;
      return makeSelectChain(selectCount === 1 ? [siteNoScorecard] : [MOCK_TEAM]) as unknown as ReturnType<typeof db.select>;
    });

    const res = await POST(makeRequest(VALID_TOKEN), ROUTE_PARAMS);
    expect(res.status).toBe(422);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("geo_analysis_required");
    expect(generatePrompts).not.toHaveBeenCalled();
  });
});
