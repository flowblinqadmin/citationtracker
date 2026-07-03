/**
 * ES-056 — Integration Tests: Tier 4 Competitive Intelligence
 * Tests IT1–IT7
 *
 * Verifies end-to-end data flow:
 * tagged prompts → per-location/category competitors → dominance map → real prompt discovery → prompt grounding
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock Setup ───────────────────────────────────────────────────

const { mockOpenAICreate, mockCreate, mockGeminiGenerate } = vi.hoisted(() => ({
  mockOpenAICreate: vi.fn(),
  mockCreate: vi.fn(),
  mockGeminiGenerate: vi.fn(),
}));

vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(function () {
    return { chat: { completions: { create: mockOpenAICreate } } };
  }),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  }),
}));

vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: vi.fn().mockImplementation(function () {
    return {
      getGenerativeModel: vi.fn().mockReturnValue({
        generateContent: mockGeminiGenerate,
      }),
    };
  }),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockResolvedValue([]),
      }),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  citationCheckScores: {},
  citationCheckResponses: {},
  geoSites: {},
}));

import {
  aggregateCompetitorsByDimension,
  generateDominanceInsights,
} from "@/lib/services/citation-checker";

import { discoverRealPrompts, clearRealPromptCache } from "@/lib/services/real-prompt-discoverer";

import type {
  LocationCompetitor,
  CategoryCompetitor,
  DominanceMap,
  RealPromptDiscovery,
} from "@/lib/types/citation";

// ── Helpers ──────────────────────────────────────────────────────

type TaggedPrompt = {
  type: "indirect" | "direct";
  pillar: string | null;
  prompt: string;
  geoId?: string;
  categoryId?: string;
  tier?: "buy" | "solve" | "learn";
};

function makeResponse(query: string, mentioned: boolean, competitors: string[]) {
  return {
    id: crypto.randomUUID(),
    checkId: "chk-1",
    siteId: "site-1",
    provider: "chatgpt",
    model: "gpt-4o-mini",
    query,
    pillar: null,
    promptType: "indirect" as const,
    response: "Response text with enough content for analysis.",
    responseTimeMs: 500,
    mentioned,
    position: mentioned ? 2 : null,
    sentiment: mentioned ? "positive" : null,
    competitorsMentioned: competitors,
    error: null,
  };
}

function makeGeoTree() {
  return {
    root: {
      id: "root",
      name: "India",
      children: [
        { id: "in-ka-blr", name: "Bangalore", children: [], pageCount: 10 },
        { id: "in-dl-del", name: "Delhi", children: [], pageCount: 8 },
      ],
    },
    leafCount: 2,
  };
}

function makeCategoryTree() {
  return {
    root: {
      id: "root",
      name: "Services",
      children: [
        { id: "cat-ortho", name: "Orthopedics", children: [], pageCount: 15 },
        { id: "cat-cardio", name: "Cardiology", children: [], pageCount: 12 },
        { id: "cat-neuro", name: "Neurology", children: [], pageCount: 8 },
      ],
    },
    leafCount: 3,
  };
}

const domain = "manipalhospitals.com";

// ── Integration Tests ────────────────────────────────────────────

describe("ES-056 Integration — Competitive Intelligence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearRealPromptCache();
    process.env.PERPLEXITY_API_KEY = "test-key";
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.OPENAI_API_KEY = "test-key";
  });

  it("IT1 — citation check with geo-tagged prompts produces locationCompetitors", () => {
    const prompts: TaggedPrompt[] = Array.from({ length: 5 }, (_, i) => ({
      type: "indirect" as const,
      pillar: null,
      prompt: `blr-q-${i}`,
      geoId: "in-ka-blr",
      categoryId: "cat-ortho",
      tier: "buy" as const,
    }));

    const responses = prompts.map((p) =>
      makeResponse(p.prompt, true, ["apollo", "fortis"])
    );

    const result = aggregateCompetitorsByDimension(
      responses, prompts, domain, makeGeoTree() as any, makeCategoryTree() as any
    );

    expect(result.locationCompetitors.length).toBeGreaterThanOrEqual(1);
    const blr = result.locationCompetitors.find((l) => l.geoId === "in-ka-blr");
    expect(blr).toBeDefined();
    expect(blr!.competitors.length).toBeGreaterThanOrEqual(1);
  });

  it("IT2 — citation check with category-tagged prompts produces categoryCompetitors", () => {
    const prompts: TaggedPrompt[] = [
      ...Array.from({ length: 4 }, (_, i) => ({
        type: "indirect" as const, pillar: null,
        prompt: `ortho-${i}`, categoryId: "cat-ortho", tier: "buy" as const,
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        type: "indirect" as const, pillar: null,
        prompt: `cardio-${i}`, categoryId: "cat-cardio", tier: "solve" as const,
      })),
    ];

    const responses = prompts.map((p) =>
      makeResponse(p.prompt, true, ["apollo"])
    );

    const result = aggregateCompetitorsByDimension(
      responses, prompts, domain, null, makeCategoryTree() as any
    );

    expect(result.categoryCompetitors.length).toBe(2);
  });

  it("IT3 — dominance map computed with entries", () => {
    const prompts: TaggedPrompt[] = Array.from({ length: 8 }, (_, i) => ({
      type: "indirect" as const, pillar: null,
      prompt: `q-${i}`, geoId: "in-ka-blr", categoryId: "cat-ortho", tier: "buy" as const,
    }));

    // Apollo in 6/8, Brand in 3/8
    const responses = prompts.map((p, i) =>
      makeResponse(p.prompt, i < 3, i < 6 ? ["apollo"] : [])
    );

    const result = aggregateCompetitorsByDimension(
      responses, prompts, domain, makeGeoTree() as any, makeCategoryTree() as any
    );

    expect(result.dominanceMap).toBeDefined();
    expect(result.dominanceMap.entries.length).toBeGreaterThanOrEqual(1);
    expect(result.dominanceMap.computedAt).toBeTruthy();
  });

  it("IT4 — real prompts discovered from Perplexity", async () => {
    const questions: RealPromptDiscovery[] = [
      { source: "paa", query: "Best orthopedic hospital in Bangalore for knee surgery?", context: "Google PAA context", url: "https://google.com/q1" },
      { source: "reddit", query: "Which hospital is best for joint replacement in India?", context: "Reddit discussion", url: "https://reddit.com/r/india/1" },
      { source: "quora", query: "How to choose a good cardiologist in Bangalore?", context: "Quora answer", url: "https://quora.com/q1" },
    ];

    mockOpenAICreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(questions) } }],
    });

    const result = await discoverRealPrompts(
      makeCategoryTree() as any,
      { cityNames: ["Bangalore", "Delhi"] },
      domain
    );

    expect(result.length).toBe(3);
    expect(result[0].source).toBe("paa");
  });

  it("IT5 — real prompts use natural phrasing from real sources", async () => {
    const questions: RealPromptDiscovery[] = [
      { source: "paa", query: "Which is the best hospital for knee replacement in Bangalore?", context: "ctx", url: "url" },
      { source: "reddit", query: "Can anyone recommend a good orthopedic surgeon?", context: "ctx", url: "url" },
    ];

    mockOpenAICreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(questions) } }],
    });

    const result = await discoverRealPrompts(
      makeCategoryTree() as any,
      { cityNames: ["Bangalore"] },
      domain
    );

    // Real prompts should have natural language patterns (questions, conversational)
    for (const q of result) {
      expect(q.query.length).toBeGreaterThan(10);
      // Real questions tend to be interrogative or conversational
      expect(q.query).toMatch(/\?|which|what|how|can|best|recommend/i);
    }
  });

  it("IT6 — backward compat: untagged prompts produce empty competitor arrays", () => {
    const prompts: TaggedPrompt[] = [
      { type: "indirect", pillar: null, prompt: "legacy-1" },
      { type: "indirect", pillar: null, prompt: "legacy-2" },
      { type: "indirect", pillar: null, prompt: "legacy-3" },
      { type: "indirect", pillar: null, prompt: "legacy-4" },
    ];

    const responses = prompts.map((p) =>
      makeResponse(p.prompt, true, ["apollo"])
    );

    const result = aggregateCompetitorsByDimension(
      responses, prompts, domain, null, null
    );

    expect(result.locationCompetitors).toEqual([]);
    expect(result.categoryCompetitors).toEqual([]);
    // Dominance map should only have global entry or be minimal
  });

  it("IT7 — real prompt fallback when Perplexity unavailable", async () => {
    mockOpenAICreate.mockRejectedValue(new Error("Service unavailable"));

    const result = await discoverRealPrompts(
      makeCategoryTree() as any,
      { cityNames: ["Bangalore"] },
      domain
    );

    // Should not throw, should return empty array
    expect(result).toEqual([]);
  });
});
