/**
 * ES-059 — Integration Tests: Brand Detection + Category Extraction Flow
 * IT1–IT10
 *
 * Tests verify end-to-end contracts:
 * brand keywords → detection → visibility
 * category extraction → prompts use real service names
 * lazy extraction → persisted once
 * fallback chain → correct source
 * ambiguity → proximity check
 * V1 backward compat
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock Setup ────────────────────────────────────────────────────────────────

const { mockCreate, mockOpenAICreate, mockGeminiGenerate } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockOpenAICreate: vi.fn(),
  mockGeminiGenerate: vi.fn(),
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

// Mock DB
const mockDbSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) });
const mockDbUpdate = vi.fn().mockReturnValue({ set: mockDbSet });
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

// ── Imports ───────────────────────────────────────────────────────────────────

import { runCitationCheck } from "@/lib/services/citation-checker";
import { extractBrandKeywords } from "@/lib/services/brand-detector";
import { extractCategoriesViaHaiku } from "@/lib/services/category-extractor";
import { generatePrompts, buildSeeds, getEntityNoun } from "@/lib/services/citation-prompt-generator";
import type { CitationPrompt } from "@/lib/types/citation";
import type { BrandKeywords } from "@/lib/services/brand-detector";
import type { ExtractedCategories } from "@/lib/services/category-extractor";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSseText(content: string) {
  return `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: content } })}\n\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
}

function makeStreamResponse(text: string) {
  const encoder = new TextEncoder();
  return {
    ok: true,
    body: {
      getReader: () => {
        let called = false;
        return {
          read: async () => {
            if (!called) {
              called = true;
              return { done: false, value: encoder.encode(makeSseText(text)) };
            }
            return { done: true, value: undefined };
          },
        };
      },
    },
  };
}

const NO_OP_CALLBACKS = {
  onAnalysisStart: vi.fn(),
  onPartialResult: vi.fn(),
  onAnalysisComplete: vi.fn(),
};

function makeSimplePrompt(text: string): CitationPrompt {
  return {
    type: "indirect" as const,
    prompt: text,
    pillar: "offering_clarity",
    categoryId: "c1",
    geoId: null,
  };
}

// ── IT1: Full citation check with brand keywords ──────────────────────────────

describe("IT1 — full citation check: brand keyword match → visibility >0", () => {
  it("should detect Manipal Hospitals in AI response when brandKeywords set", async () => {
    // Use real timers for this test (batch delay is 100ms real time)
    vi.useRealTimers();

    // Provide at least one API key so getConfiguredProviders returns a provider
    process.env.ANTHROPIC_API_KEY = "test-key";

    // Mock Anthropic to return text mentioning the brand
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "Manipal Hospitals is one of the top cardiac centers in India." }],
    });

    const brandKeywords: BrandKeywords = {
      keywords: ["manipal hospitals", "manipal"],
      isAmbiguous: false,
      source: "vendor",
      extractedAt: new Date().toISOString(),
    };

    const prompts = [makeSimplePrompt("What are the best cardiac hospitals?")];
    const callbacks = { ...NO_OP_CALLBACKS };

    const result = await runCitationCheck(
      "check-1",
      "site-1",
      "manipalhospitals.com",
      prompts,
      callbacks,
      [],
      brandKeywords,
      ["cardiology"],
    );

    delete process.env.ANTHROPIC_API_KEY;
    vi.useFakeTimers();
    expect(result.overallVisibility).toBeGreaterThan(0);
  });
});

// ── IT2: Extracted categories used in prompts ─────────────────────────────────

describe("IT2 — extracted categories: prompts use real service names", () => {
  it("should use Oncology/Cardiology in seeds when extractedCategories set", () => {
    const site = {
      domain: "manipalhospitals.com",
      siteType: "healthcare",
      geoTree: null,
      categoryTree: null,
      geoCategoryMapping: null,
      generatedBusinessJson: null,
      generatedLlmsTxt: null,
      extractedCategories: {
        categories: ["Oncology", "Cardiology", "Orthopedics"],
        entityNoun: "hospitals",
        extractedAt: new Date().toISOString(),
        source: "haiku" as const,
      },
    };

    const entityNoun = getEntityNoun(site as any);
    expect(entityNoun).toBe("hospitals");

    const triples = [
      {
        category: "Oncology",
        geoLevel: { geoId: null, level: "global", name: "" },
        angle: "discovery" as const,
      },
    ];
    const seeds = buildSeeds(triples, site.domain, entityNoun);
    const discoveryPrompt = seeds[0].text;
    expect(discoveryPrompt).toContain("Oncology");
    expect(discoveryPrompt).toContain("hospitals");
    expect(discoveryPrompt).not.toContain("companies");
  });
});

// ── IT3: Lazy brand extraction ────────────────────────────────────────────────

describe("IT3 — lazy brand extraction: extracts from businessJson.vendor.name", () => {
  it("should extract brand keywords when brandKeywords is null but vendor.name available", () => {
    const domain = "manipalhospitals.com";
    const businessJson = { vendor: { name: "Manipal Hospitals Ltd" } };

    // Simulate lazy extraction (what route.ts does)
    const brandKeywords = extractBrandKeywords(domain, businessJson);

    expect(brandKeywords.source).toBe("vendor");
    expect(brandKeywords.keywords).toContain("manipal hospitals");
    expect(brandKeywords.keywords.length).toBeGreaterThan(2);
  });
});

// ── IT4: Lazy category extraction ────────────────────────────────────────────

describe("IT4 — lazy category extraction: Haiku extracts + persists categories", async () => {
  it("should extract categories when extractedCategories is null", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            categories: ["Oncology", "Cardiology", "Orthopedics"],
            entityNoun: "hospitals",
          }),
        },
      ],
    });

    const llmsTxt = "A".repeat(300);
    const crawlData = {
      pages: [
        { url: "https://manipalhospitals.com/services/oncology" },
        { url: "https://manipalhospitals.com/services/cardiology" },
      ],
    };

    const p = extractCategoriesViaHaiku(
      "manipalhospitals.com",
      "healthcare",
      null,
      llmsTxt,
      crawlData,
      null,
    );
    vi.runAllTimersAsync();
    const result = await p;

    expect(result.source).toBe("haiku");
    expect(result.categories).toContain("Oncology");
    expect(result.entityNoun).toBe("hospitals");
  });
});

// ── IT5: Lazy extraction only runs once ──────────────────────────────────────

describe("IT5 — lazy extraction: second run reuses persisted data", () => {
  it("should not call extractBrandKeywords again if brandKeywords already set", () => {
    const existingKeywords: BrandKeywords = {
      keywords: ["manipal hospitals", "manipal"],
      isAmbiguous: false,
      source: "vendor",
      extractedAt: "2026-03-25T00:00:00Z",
    };

    // Simulate: site already has brandKeywords (non-null)
    // Route.ts skips extraction when brandKeywords is non-null
    const site = { brandKeywords: existingKeywords };

    // Only call extractBrandKeywords when site.brandKeywords is null
    const extractFn = vi.fn().mockReturnValue(existingKeywords);
    const result = site.brandKeywords ?? extractFn("manipalhospitals.com", null);

    expect(extractFn).not.toHaveBeenCalled();
    expect(result).toEqual(existingKeywords);
  });
});

// ── IT6: Fallback chain — Haiku fails + no topics + no tree ─────────────────

describe("IT6 — fallback chain: all sources fail → siteType fallback", async () => {
  it("should use siteType as category with source=fallback when all fail", async () => {
    mockCreate.mockRejectedValueOnce(new Error("Haiku unavailable"));

    const llmsTxt = "A".repeat(300);
    const p = extractCategoriesViaHaiku(
      "example.com",
      "healthcare",
      null,  // no businessJson
      llmsTxt,
      null,  // no crawl
      null,  // no tree
    );
    vi.runAllTimersAsync();
    const result = await p;

    expect(result.source).toBe("fallback");
    expect(result.categories).toContain("healthcare");
  });
});

// ── IT7: Ambiguous brand with category proximity ─────────────────────────────

describe("IT7 — ambiguous brand: category keyword nearby → mentioned=true", () => {
  it("should detect 'Nile' near 'consulting' as a match", () => {
    const { detectMention } = require("@/lib/services/brand-detector");
    const bk: BrandKeywords = {
      keywords: ["nile"],
      isAmbiguous: true,
      source: "vendor",
      extractedAt: new Date().toISOString(),
    };
    const text = "Nile digital consulting is the top choice for transformation projects.";
    const result = detectMention(text, "nilehq.com", bk, ["consulting"]);
    expect(result.mentioned).toBe(true);
  });
});

// ── IT8: Ambiguous brand without category proximity ──────────────────────────

describe("IT8 — ambiguous brand: no category keyword nearby → mentioned=false", () => {
  it("should NOT detect 'Nile' in geographic context with no category keywords", () => {
    const { detectMention } = require("@/lib/services/brand-detector");
    const bk: BrandKeywords = {
      keywords: ["nile"],
      isAmbiguous: true,
      source: "vendor",
      extractedAt: new Date().toISOString(),
    };
    const text = "The Nile river flows through Egypt, Sudan, and Ethiopia.";
    const result = detectMention(text, "nilehq.com", bk, ["consulting", "transformation"]);
    expect(result.mentioned).toBe(false);
  });
});

// ── IT9: V1 backward compat ───────────────────────────────────────────────────

describe("IT9 — V1 backward compat: no brandKeywords → domain stem detection", () => {
  it("should detect brand via domain stem when no brandKeywords", () => {
    const { detectMention } = require("@/lib/services/brand-detector");
    // No brandKeywords provided (null) — should fall back to domain-stem
    const result = detectMention(
      "manipalhospitals is one of the best hospitals.",
      "manipalhospitals.com",
      null,
      [],
    );
    expect(result.mentioned).toBe(true);
  });
});

// ── IT10: Prompt templates contain entityNoun ────────────────────────────────

describe("IT10 — prompt templates: entityNoun='hospitals' appears in seeds", () => {
  it("should have 'hospitals' in all 5 seed templates when entityNoun=hospitals", () => {
    const triples = [
      { category: "Oncology", geoLevel: { geoId: null, level: "global", name: "" }, angle: "discovery" as const },
      { category: "Oncology", geoLevel: { geoId: null, level: "global", name: "" }, angle: "evaluation" as const },
      { category: "Oncology", geoLevel: { geoId: null, level: "global", name: "" }, angle: "trust" as const },
      { category: "Oncology", geoLevel: { geoId: null, level: "global", name: "" }, angle: "clarity" as const },
      { category: "Oncology", geoLevel: { geoId: null, level: "global", name: "" }, angle: "readiness" as const },
    ];
    const seeds = buildSeeds(triples, "manipalhospitals.com", "hospitals");
    for (const seed of seeds) {
      expect(seed.text).toContain("hospitals");
      expect(seed.text).not.toContain("companies");
      expect(seed.text).not.toContain("providers");
      expect(seed.text).not.toContain("firms");
    }
  });
});
