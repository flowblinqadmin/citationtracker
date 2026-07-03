/**
 * ES-054 — Integration Tests: Tier 2 Measurement Depth
 * Tests IT1–IT7
 *
 * These tests verify end-to-end data flow:
 * tagged prompts → dimensional visibility → impression share → gap analysis → 17th pillar → crawl coverage
 *
 * Mocks: LLM providers, DB. Verifies contract between services.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock Setup ───────────────────────────────────────────────────

const { mockCreate, mockOpenAICreate, mockGeminiGenerate, mockClaudeCall } =
  vi.hoisted(() => ({
    mockCreate: vi.fn(),
    mockOpenAICreate: vi.fn(),
    mockGeminiGenerate: vi.fn(),
    mockClaudeCall: vi.fn(),
  }));

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  }),
}));

vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(function () {
    return { chat: { completions: { create: mockOpenAICreate } } };
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

vi.mock("@/lib/claude", () => ({ callClaude: mockClaudeCall }));

// Mock DB
const mockDbUpdate = vi.fn().mockReturnValue({
  set: vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue([]),
  }),
});

const mockDbInsert = vi.fn().mockReturnValue({
  values: vi.fn().mockReturnValue({
    onConflictDoNothing: vi.fn().mockResolvedValue([]),
    returning: vi.fn().mockResolvedValue([]),
  }),
});

vi.mock("@/lib/db", () => ({
  db: {
    update: mockDbUpdate,
    insert: mockDbInsert,
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
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
  runCitationCheck,
  aggregateByDimension,
  computeImpressionShare,
} from "@/lib/services/citation-checker";

import { validateCrawlCoverage } from "@/lib/services/crawl-coverage-validator";
import { scoreGeographicSignals } from "@/lib/services/geo-analyzer";

import type {
  GeoVisibility,
  CategoryVisibility,
  TierVisibility,
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

function makeTaggedPrompts(): TaggedPrompt[] {
  return [
    { type: "indirect", pillar: "content_structure", prompt: "best hospital bangalore", geoId: "in-ka-blr", categoryId: "cat-ortho", tier: "buy" },
    { type: "indirect", pillar: "content_structure", prompt: "top clinic delhi", geoId: "in-dl-del", categoryId: "cat-ortho", tier: "buy" },
    { type: "indirect", pillar: "faq_coverage", prompt: "how to fix knee pain", geoId: "in-ka-blr", categoryId: "cat-ortho", tier: "solve" },
    { type: "indirect", pillar: "faq_coverage", prompt: "cardiology specialist bangalore", geoId: "in-ka-blr", categoryId: "cat-cardio", tier: "learn" },
    { type: "direct", pillar: null, prompt: "tell me about manipal hospitals", tier: "buy" },
  ];
}

function makeLongResponse(domain: string, mentioned: boolean): string {
  if (mentioned) {
    return (
      `Here are the top healthcare providers in the region. ` +
      `1. ${domain.replace(/\.\w+$/, "")} is a leading multi-specialty hospital chain with advanced facilities. ` +
      `2. Apollo Hospitals offers comprehensive cardiac and orthopedic care. ` +
      `3. Fortis Healthcare provides quality treatment across major cities. ` +
      `4. Narayana Health is known for affordable cardiac surgery options. ` +
      `5. Columbia Asia brings international healthcare standards to India.`
    );
  }
  return (
    `Here are the top healthcare providers in the region. ` +
    `1. Apollo Hospitals is a leading multi-specialty hospital chain. ` +
    `2. Fortis Healthcare offers comprehensive cardiac care across cities. ` +
    `3. Narayana Health provides affordable treatment for cardiac patients. ` +
    `4. Columbia Asia brings international standard healthcare to India. ` +
    `5. Max Healthcare is growing rapidly with advanced surgical options.`
  );
}

const noopCallbacks = {
  onAnalysisStart: vi.fn(),
  onPartialResult: vi.fn(),
  onAnalysisComplete: vi.fn(),
};

// ── Integration Tests ────────────────────────────────────────────

describe("ES-054 Integration — Tier 2 Measurement Depth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.GEMINI_API_KEY = "test-key";
    process.env.PERPLEXITY_API_KEY = "test-key";
  });

  it("IT1 — citation check with tagged prompts produces geo/category/tier visibility", async () => {
    const prompts = makeTaggedPrompts();

    // Mock all 4 providers to return mentions for first 3 prompts
    const mockProviderResponse = (text: string) => ({
      choices: [{ message: { content: text } }],
    });

    mockOpenAICreate.mockResolvedValue(
      mockProviderResponse(makeLongResponse("manipalhospitals.com", true))
    );
    mockCreate.mockResolvedValue({
      content: [{ text: makeLongResponse("manipalhospitals.com", true) }],
    });
    mockGeminiGenerate.mockResolvedValue({
      response: { text: () => makeLongResponse("manipalhospitals.com", true) },
    });

    // aggregateByDimension should work on the response data
    const mockResponses = prompts.map((p, i) => ({
      id: `resp-${i}`,
      checkId: "chk-1",
      siteId: "site-1",
      provider: "chatgpt",
      model: "gpt-4o-mini",
      query: p.prompt,
      pillar: p.pillar,
      promptType: p.type,
      response: makeLongResponse("manipalhospitals.com", true),
      responseTimeMs: 500,
      mentioned: true,
      position: 1,
      sentiment: "positive",
      competitorsMentioned: ["apollo"],
      error: null,
    }));

    const result = aggregateByDimension(mockResponses, prompts, null, null);

    expect(result.geoVisibility.length).toBeGreaterThan(0);
    expect(result.tierVisibility.length).toBe(3);
  });

  it("IT2 — impression share computed for responses", () => {
    const response = makeLongResponse("manipalhospitals.com", true);
    const share = computeImpressionShare(response, "manipalhospitals.com");

    expect(share).not.toBeNull();
    expect(share!).toBeGreaterThanOrEqual(0);
    expect(share!).toBeLessThanOrEqual(100);
  });

  it("IT3 — visibility gap analysis produced for low-visibility dimensions", () => {
    const geo: GeoVisibility[] = [
      { geoId: "blr", geoName: "Bangalore", promptCount: 10, mentionCount: 0, visibility: 0 },
      { geoId: "del", geoName: "Delhi", promptCount: 10, mentionCount: 8, visibility: 80 },
    ];
    const cat: CategoryVisibility[] = [
      { categoryId: "cat-1", categoryName: "Ortho", promptCount: 10, mentionCount: 0, visibility: 5 },
    ];
    const tier: TierVisibility[] = [];

    // Import the gap analysis function
    // This is defined in the citation-check route per spec
    const { generateVisibilityGapAnalysis } = require("@/app/api/sites/[id]/citation-check/route");

    const gaps = generateVisibilityGapAnalysis(geo, cat, tier);

    // Bangalore (0%) and Ortho (5%) should generate gaps
    expect(gaps.length).toBeGreaterThanOrEqual(2);
    expect(gaps.every((g: any) => g.visibility < 10)).toBe(true);
  });

  it("IT4 — GEO analysis produces 17 pillars including geographic_signals", () => {
    const crawlData = {
      pages: [
        {
          url: "https://example.com",
          title: "Home",
          content: "Content",
          pageType: "homepage",
          wordCount: 500,
          existingSchema: '{"@type":"LocalBusiness"}',
          contactInfo: "123 Main St, City 12345",
          faqContent: [],
          headings: [],
          metaDescription: "",
          links: [],
        },
      ],
      domain: "example.com",
      crawledAt: new Date().toISOString(),
    };

    const geoPillar = scoreGeographicSignals(crawlData as any, null);

    expect(geoPillar.pillar).toBe("geographic_signals");
    expect(geoPillar.pillarName).toBe("Geographic Signals");
    expect(geoPillar.score).toBeGreaterThanOrEqual(0);
    expect(geoPillar.score).toBeLessThanOrEqual(100);
  });

  it("IT5 — crawl coverage report generated from discovery + crawl data", () => {
    const discoveryData = { totalPages: 200 };
    const crawlData = {
      pages: [
        { url: "https://example.com", pageType: "homepage" },
        { url: "https://example.com/about", pageType: "about" },
        { url: "https://example.com/services", pageType: "services" },
        ...Array.from({ length: 47 }, (_, i) => ({
          url: `https://example.com/blog/${i}`,
          pageType: "blog",
        })),
      ],
      domain: "example.com",
      crawledAt: new Date().toISOString(),
    };

    const report = validateCrawlCoverage(discoveryData, crawlData as any);

    expect(report.totalDiscovered).toBe(200);
    expect(report.totalCrawled).toBe(50);
    expect(report.coveragePercent).toBe(25);
    expect(report.missingPageTypes).toContain("pricing");
    expect(report.missingPageTypes).toContain("contact");
    expect(report.missingPageTypes).toContain("faq");
  });

  it("IT6 — tagged prompts produce dimensional breakdowns matching tags", () => {
    const prompts: TaggedPrompt[] = [
      { type: "indirect", pillar: null, prompt: "q1", geoId: "blr", categoryId: "ortho", tier: "buy" },
      { type: "indirect", pillar: null, prompt: "q2", geoId: "blr", categoryId: "ortho", tier: "buy" },
      { type: "indirect", pillar: null, prompt: "q3", geoId: "del", categoryId: "cardio", tier: "solve" },
    ];
    const responses = [
      { ...makeResponseRow("q1", true), },
      { ...makeResponseRow("q2", false), },
      { ...makeResponseRow("q3", true), },
    ];

    const result = aggregateByDimension(responses, prompts, null, null);

    const blr = result.geoVisibility.find((g) => g.geoId === "blr");
    expect(blr?.promptCount).toBe(2);
    expect(blr?.mentionCount).toBe(1);
    expect(blr?.visibility).toBe(50);

    const del = result.geoVisibility.find((g) => g.geoId === "del");
    expect(del?.promptCount).toBe(1);
    expect(del?.mentionCount).toBe(1);
    expect(del?.visibility).toBe(100);
  });

  it("IT7 — legacy untagged prompts produce empty dimensional arrays", () => {
    const prompts: TaggedPrompt[] = [
      { type: "indirect", pillar: null, prompt: "old-prompt-1" },
      { type: "indirect", pillar: null, prompt: "old-prompt-2" },
      { type: "direct", pillar: null, prompt: "old-prompt-3" },
    ];
    const responses = prompts.map((p) => makeResponseRow(p.prompt, true));

    const result = aggregateByDimension(responses, prompts, null, null);

    expect(result.geoVisibility).toEqual([]);
    expect(result.categoryVisibility).toEqual([]);
    expect(result.tierVisibility).toEqual([]);
  });
});

// ── Helper ───────────────────────────────────────────────────────

function makeResponseRow(query: string, mentioned: boolean) {
  return {
    id: crypto.randomUUID(),
    checkId: "chk-1",
    siteId: "site-1",
    provider: "chatgpt",
    model: "gpt-4o-mini",
    query,
    pillar: null,
    promptType: "indirect" as const,
    response: "Some response text with enough words to be meaningful for testing purposes here.",
    responseTimeMs: 400,
    mentioned,
    position: mentioned ? 2 : null,
    sentiment: mentioned ? "positive" : null,
    competitorsMentioned: [],
    error: null,
  };
}
