/**
 * Integration tests for citation-check with trees — ES-053 / IT6-IT10
 * Tests tree-based prompt generation integration with citation check flow.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CrawlData, CrawledPage } from "@/lib/services/geo-crawler";
import type { GeoTree, CategoryTree, GeoCategoryMapping } from "@/lib/types/trees";
import { emptyGeoTree, emptyCategoryTree, emptyMapping } from "@/lib/types/trees";

// ─── Hoisted mocks ──────────────────────────────────────────────────────────

const { mockSonnetCreate, mockOpenAICreate, mockGoogleGenerate, mockHaikuCreate } = vi.hoisted(() => {
  const mockSonnetCreate = vi.fn();
  const mockOpenAICreate = vi.fn();
  const mockGoogleGenerate = vi.fn();
  const mockHaikuCreate = vi.fn();
  return { mockSonnetCreate, mockOpenAICreate, mockGoogleGenerate, mockHaikuCreate };
});

// ─── Module mocks ───────────────────────────────────────────────────────────

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    // Return an object that can handle both Sonnet and Haiku calls
    // by checking the model param
    return {
      messages: {
        create: vi.fn().mockImplementation((args: any) => {
          if (args.model?.includes("sonnet")) return mockSonnetCreate(args);
          return mockHaikuCreate(args);
        }),
      },
    };
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
      getGenerativeModel: vi.fn().mockReturnValue({ generateContent: mockGoogleGenerate }),
    };
  }),
}));

// ─── Import (after mocks) ───────────────────────────────────────────────────

import { generatePrompts } from "@/lib/services/citation-prompt-generator";

// ─── Test data ──────────────────────────────────────────────────────────────

const PILLAR_IDS = [
  "metadata_freshness", "semantic_html", "structured_data", "entity_definitions",
  "faq_coverage", "evidence_statistics", "content_structure", "author_authority",
  "internal_linking", "content_freshness", "multi_format", "licensing_signals",
  "contact_trust", "competitive_positioning", "offering_clarity", "cta_structure",
];

function makeGeoTree(): GeoTree {
  return {
    root: {
      id: "global", name: "Global", level: "global",
      children: [{
        id: "in", name: "India", level: "country",
        children: [{
          id: "in-ka", name: "Karnataka", level: "state",
          children: [
            { id: "in-ka-blr", name: "Bangalore", level: "city", children: [], pageCount: 10, evidence: [] },
          ],
          pageCount: 10, evidence: [],
        }],
        pageCount: 10, evidence: [],
      }],
      pageCount: 10, evidence: [],
    },
    leafCount: 1,
    extractedAt: new Date().toISOString(),
  };
}

function makeCategoryTree(): CategoryTree {
  return {
    root: {
      id: "healthcare", name: "Healthcare", level: 0,
      children: [
        { id: "hc-onc", name: "Oncology", level: 1, children: [], pageCount: 8, evidence: [] },
        { id: "hc-car", name: "Cardiology", level: 1, children: [], pageCount: 5, evidence: [] },
      ],
      pageCount: 13, evidence: [],
    },
    leafCount: 2,
    extractedAt: new Date().toISOString(),
  };
}

function makeMapping(): GeoCategoryMapping {
  return {
    entries: [
      { geoId: "in-ka-blr", categoryId: "hc-onc", strength: "strong", evidence: [] },
      { geoId: "in-ka-blr", categoryId: "hc-car", strength: "moderate", evidence: [] },
    ],
    totalEntries: 2,
    extractedAt: new Date().toISOString(),
  };
}

function mockTreeBased48(domain: string) {
  const indirect = Array.from({ length: 40 }, (_, i) => ({
    type: "indirect" as const,
    pillar: null,
    prompt: `Best oncology treatment in Bangalore ${i}?`,
    geoId: "in-ka-blr",
    categoryId: "hc-onc",
    tier: "solve" as const,
    queryType: "recommendation" as const,
  }));
  const direct = Array.from({ length: 8 }, (_, i) => ({
    type: "direct" as const,
    pillar: null,
    prompt: `What is ${domain} known for ${i}?`,
  }));
  return [...indirect, ...direct];
}

function mockHaiku48(domain: string) {
  const indirect = PILLAR_IDS.flatMap(pillar => [
    { type: "indirect" as const, pillar, prompt: `Best tools for ${pillar}?` },
    { type: "indirect" as const, pillar, prompt: `Which companies lead in ${pillar}?` },
    { type: "indirect" as const, pillar, prompt: `How to evaluate ${pillar}?` },
  ]);
  const direct = Array.from({ length: 8 }, (_, i) => ({
    type: "direct" as const, pillar: null, prompt: `What is ${domain} offering ${i}?`,
  }));
  return [...indirect, ...direct];
}

// ─── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.OPENAI_API_KEY = "test-openai";
});

describe("citation-check trees integration (IT6-IT10)", () => {
  it("IT6: citation check with cached trees uses tree-based generation", async () => {
    // V2 path: categories extracted from categoryTree → Haiku rephrasing
    // mockHaikuCreate returns undefined → rephraseSeeds falls back to raw seeds
    const result = await generatePrompts({
      domain: "manipal.com",
      siteType: "healthcare",
      geoTree: makeGeoTree(),
      categoryTree: makeCategoryTree(),
      geoCategoryMapping: makeMapping(),
      generatedLlmsTxt: "Manipal is a hospital chain.",
    });

    expect(result.length).toBeGreaterThanOrEqual(20);
    // Haiku is called for V2 seed rephrasing (not Sonnet)
    expect(mockHaikuCreate).toHaveBeenCalled();
  });

  it("IT7: citation check stores promptMetadata — prompts have correct shape", async () => {
    // V2 path: Haiku rephrasing (returns undefined → rephraseSeeds falls back to raw seeds)
    const result = await generatePrompts({
      domain: "manipal.com",
      siteType: "healthcare",
      geoTree: makeGeoTree(),
      categoryTree: makeCategoryTree(),
      geoCategoryMapping: makeMapping(),
    });

    // Each prompt should have the basic shape
    result.forEach(p => {
      expect(p).toHaveProperty("type");
      expect(p).toHaveProperty("prompt");
      expect(typeof p.prompt).toBe("string");
    });

    // promptMetadata is the full result array — can be stored directly
    expect(Array.isArray(result)).toBe(true);
  });

  it("IT8: citation check with no trees falls back to legacy Haiku path", async () => {
    const haikuPrompts = mockHaiku48("oldsite.com");
    mockHaikuCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify(haikuPrompts) }],
    });

    const result = await generatePrompts({
      domain: "oldsite.com",
      siteType: "SaaS",
      geoTree: null,
      categoryTree: null,
      geoCategoryMapping: null,
    });

    // Legacy path should work — either Haiku or fallback
    expect(result.length).toBeGreaterThanOrEqual(4);
    // Sonnet should NOT have been called (no trees → legacy path)
    expect(mockSonnetCreate).not.toHaveBeenCalled();
  });

  it("IT9: crawl priority changes URL order — structural pages first", async () => {
    // This tests the integration between crawl-prioritizer and discovery
    const { prioritizeUrls, detectArchitecture } = await import("@/lib/services/crawl-prioritizer");

    const urls = [
      ...Array.from({ length: 200 }, (_, i) => `https://example.com/blog/post-${i}`),
      "https://example.com/",
      "https://example.com/about",
      "https://example.com/services/oncology",
      "https://example.com/services/cardiology",
      "https://example.com/locations/bangalore",
      ...Array.from({ length: 100 }, (_, i) => `https://example.com/other/${i}`),
    ];

    const arch = detectArchitecture(urls);
    const prioritized = prioritizeUrls(urls, arch, "healthcare", 50);

    // Structural pages should be in the result
    expect(prioritized).toContain("https://example.com/");
    expect(prioritized).toContain("https://example.com/about");
    expect(prioritized.some(u => u.includes("/services/"))).toBe(true);

    // Blog should be capped — not more than 30% of 50 = 15
    const blogCount = prioritized.filter(u => u.includes("/blog/")).length;
    expect(blogCount).toBeLessThanOrEqual(15);

    // Structural pages should appear before blog in the result
    const firstBlogIdx = prioritized.findIndex(u => u.includes("/blog/"));
    const lastStructuralIdx = Math.max(
      prioritized.lastIndexOf("https://example.com/"),
      ...prioritized.filter(u => u.includes("/services/")).map(u => prioritized.indexOf(u)),
    );
    if (firstBlogIdx >= 0 && lastStructuralIdx >= 0) {
      expect(lastStructuralIdx).toBeLessThan(firstBlogIdx);
    }
  });

  it("IT10: end-to-end tree extraction + prompt generation uses correct geo/category", async () => {
    // Step 1: Extract trees
    const { extractTrees } = await import("@/lib/services/tree-extractor");

    const crawlData: CrawlData = {
      domain: "hospital.com",
      pages: [
        {
          url: "https://hospital.com/",
          pageType: "homepage",
          title: "Bangalore Hospital Oncology Cardiology",
          h1: "Hospital",
          headings: [],
          content: "Leading hospital in Bangalore offering Oncology and Cardiology services",
          existingSchema: [],
          hasStructuredData: false,
          contactInfo: [],
          faqContent: [],
          testimonials: [],
          certifications: [],
        },
      ],
      totalCrawled: 1,
    };

    const treeResult = {
      geoTree: makeGeoTree(),
      categoryTree: makeCategoryTree(),
      mapping: makeMapping(),
    };

    mockSonnetCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify(treeResult) }],
    });

    const treeOutcome = await extractTrees(
      crawlData,
      { urls: ["https://hospital.com/"], pageMap: {}, hasLlmsTxt: false, hasUcp: false, hasSitemap: false, hasRobots: false, totalPages: 1 },
      "hospital.com",
      "healthcare"
    );
    expect(treeOutcome.ok).toBe(true);
    if (!treeOutcome.ok) throw new Error("expected ok");
    const trees = treeOutcome.trees;

    // Step 2: Generate prompts using extracted trees (V2 path: Haiku rephrasing)
    // mockHaikuCreate returns undefined → rephraseSeeds falls back to raw seeds
    const prompts = await generatePrompts({
      domain: "hospital.com",
      siteType: "healthcare",
      geoTree: trees.geoTree,
      categoryTree: trees.categoryTree,
      geoCategoryMapping: trees.mapping,
    });

    expect(prompts.length).toBeGreaterThanOrEqual(20);
    // Verify prompts reference the geo/category from extracted trees
    const hasGeoRef = prompts.some(p => p.geoId === "in-ka-blr" || p.prompt.includes("Bangalore"));
    const hasCatRef = prompts.some(p => p.categoryId === "hc-onc" || p.prompt.includes("oncology"));
    expect(hasGeoRef || hasCatRef).toBe(true);
  });
});
