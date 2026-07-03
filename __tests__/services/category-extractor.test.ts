/**
 * TDD tests for ES-059 Part B: Category Extractor
 * UT23–UT35
 *
 * Written before implementation (Phase 1).
 * Tests cover: extractCategoriesViaHaiku, extractServiceUrls, deduplicateSubstrings,
 * validateCategories, fallback chain, entityNoun validation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock Setup ────────────────────────────────────────────────────────────────

const { mockAnthropicCreate } = vi.hoisted(() => ({
  mockAnthropicCreate: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockAnthropicCreate } };
  }),
}));

vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(function () {
    return { chat: { completions: { create: vi.fn() } } };
  }),
}));

vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: vi.fn().mockImplementation(function () {
    return {
      getGenerativeModel: vi.fn().mockReturnValue({
        generateContent: vi.fn(),
      }),
    };
  }),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import {
  extractCategoriesViaHaiku,
  extractServiceUrls,
} from "@/lib/services/category-extractor";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeHaikuResponse(content: string) {
  return {
    content: [{ type: "text", text: content }],
  };
}

function makeCrawlData(urls: string[]) {
  return {
    pages: urls.map(url => ({ url })),
  };
}

function makeCategoryTree(leafNames: string[]) {
  return {
    root: {
      name: "root",
      pageCount: 100,
      children: leafNames.map(name => ({ name, pageCount: 10, children: [] })),
    },
  };
}

// ── UT23: Haiku returns valid categories + entityNoun ─────────────────────────

describe("UT23 — extractCategoriesViaHaiku: valid Haiku response", () => {
  it("should return source=haiku, 3 categories, entityNoun from Haiku", async () => {
    mockAnthropicCreate.mockResolvedValueOnce(
      makeHaikuResponse(
        JSON.stringify({
          categories: ["Oncology", "Cardiology", "Orthopedics"],
          entityNoun: "hospitals",
        }),
      ),
    );

    const llmsTxt = "A".repeat(300);
    const crawlData = makeCrawlData([
      "https://example.com/services/oncology",
      "https://example.com/services/cardiology",
    ]);

    const p = extractCategoriesViaHaiku(
      "examplehospital.com",
      "healthcare",
      null,
      llmsTxt,
      crawlData,
      null,
    );
    vi.runAllTimersAsync();
    const result = await p;

    expect(result.source).toBe("haiku");
    expect(result.categories).toHaveLength(3);
    expect(result.entityNoun).toBe("hospitals");
  });
});

// ── UT24: Haiku <3 valid → topics fallback ───────────────────────────────────

describe("UT24 — extractCategoriesViaHaiku: <3 valid → topics fallback", () => {
  it("should fall back to topics when Haiku returns <3 valid categories", async () => {
    mockAnthropicCreate.mockResolvedValueOnce(
      makeHaikuResponse(
        JSON.stringify({
          categories: ["Oncology", "x"],  // "x" fails length validation (too short)
          entityNoun: "hospitals",
        }),
      ),
    );

    const llmsTxt = "A".repeat(300);
    const businessJson = {
      geo_profile: {
        topics: ["Digital", "Strategy", "Compliance"],
      },
    };

    const p = extractCategoriesViaHaiku(
      "example.com",
      "consulting",
      businessJson,
      llmsTxt,
      null,
      null,
    );
    vi.runAllTimersAsync();
    const result = await p;

    expect(result.source).toBe("topics");
    expect(result.categories.length).toBeGreaterThanOrEqual(3);
  });
});

// ── UT25: Haiku timeout → topics fallback ────────────────────────────────────

describe("UT25 — extractCategoriesViaHaiku: timeout → fallback", () => {
  it("should fall back when Haiku times out", async () => {
    // Haiku never resolves (simulated by rejecting after timeout)
    mockAnthropicCreate.mockRejectedValueOnce(new Error("Request timeout"));

    const llmsTxt = "A".repeat(300);
    const businessJson = {
      geo_profile: { topics: ["Strategy", "Compliance", "Transformation"] },
    };

    const p = extractCategoriesViaHaiku(
      "example.com",
      "consulting",
      businessJson,
      llmsTxt,
      null,
      null,
    );
    vi.runAllTimersAsync();
    const result = await p;

    expect(["topics", "tree", "fallback"]).toContain(result.source);
  });
});

// ── UT26: Page URL filtering — includes service patterns ─────────────────────

describe("UT26 — extractServiceUrls: includes service patterns", () => {
  it("should include /departments/ and /services/ but not /blog/", () => {
    const crawlData = makeCrawlData([
      "https://hospital.com/departments/oncology",
      "https://hospital.com/services/cardiology",
      "https://hospital.com/blog/cancer-treatment",
    ]);
    const result = extractServiceUrls(crawlData);
    expect(result).toHaveLength(2);
    expect(result.some(p => p.includes("/departments/"))).toBe(true);
    expect(result.some(p => p.includes("/services/"))).toBe(true);
    expect(result.every(p => !p.includes("/blog/"))).toBe(true);
  });
});

// ── UT27: Page URL filtering — excludes blog patterns ────────────────────────

describe("UT27 — extractServiceUrls: excludes all blog/news/press patterns", () => {
  it("should return empty when all URLs match exclude patterns", () => {
    const crawlData = makeCrawlData([
      "https://hospital.com/blog/hiv-treatment",
      "https://hospital.com/news/update-2026",
      "https://hospital.com/press/release",
      "https://hospital.com/careers/nurse",
      "https://hospital.com/events/conference",
    ]);
    const result = extractServiceUrls(crawlData);
    expect(result).toHaveLength(0);
  });
});

// ── UT28: Page URL filtering — max 30 ────────────────────────────────────────

describe("UT28 — extractServiceUrls: max 30 URLs returned", () => {
  it("should return at most 30 service URLs when >30 exist", () => {
    const urls = Array.from(
      { length: 50 },
      (_, i) => `https://hospital.com/services/dept-${i}`,
    );
    const crawlData = makeCrawlData(urls);
    const result = extractServiceUrls(crawlData);
    expect(result).toHaveLength(30);
  });
});

// ── UT29: Category dedup — word-prefix removal ───────────────────────────────

describe("UT29 — deduplication: removes word-prefix substring entries", () => {
  it("should keep 'Oncology' and remove 'Oncology Department' (word-prefix dedup)", async () => {
    // 4 categories so that after dedup (removes "Oncology Department"), ≥3 remain
    // and the threshold cats.length >= 3 is satisfied.
    mockAnthropicCreate.mockResolvedValueOnce(
      makeHaikuResponse(
        JSON.stringify({
          categories: ["Oncology", "Oncology Department", "Cardiology", "Orthopedics"],
          entityNoun: "hospitals",
        }),
      ),
    );

    const llmsTxt = "A".repeat(300);
    const crawlData = makeCrawlData([
      "https://hospital.com/services/oncology",
      "https://hospital.com/services/cardiology",
      "https://hospital.com/services/orthopedics",
    ]);

    const p = extractCategoriesViaHaiku(
      "examplehospital.com",
      "healthcare",
      null,
      llmsTxt,
      crawlData,
      null,
    );
    vi.runAllTimersAsync();
    const result = await p;

    expect(result.categories).toContain("Oncology");
    expect(result.categories).not.toContain("Oncology Department");
  });
});

// ── UT30: Cross-reference validation — ≥2 match → valid ─────────────────────

describe("UT30 — validation: ≥2 categories match tree/URLs → valid", () => {
  it("should return source=haiku when ≥2 categories cross-reference", async () => {
    mockAnthropicCreate.mockResolvedValueOnce(
      makeHaikuResponse(
        JSON.stringify({
          categories: ["Oncology", "Cardiology", "Neuro"],
          entityNoun: "hospitals",
        }),
      ),
    );

    const llmsTxt = "A".repeat(300);
    const tree = makeCategoryTree(["Oncology", "Cardiology"]);

    const p = extractCategoriesViaHaiku(
      "examplehospital.com",
      "healthcare",
      null,
      llmsTxt,
      null,
      tree as any,
    );
    vi.runAllTimersAsync();
    const result = await p;

    expect(result.source).toBe("haiku");
  });
});

// ── UT31: Cross-reference validation — <2 match → fallback ──────────────────

describe("UT31 — validation: <2 match → falls back to topics/tree", () => {
  it("should fall back when <2 categories cross-reference with tree/URLs", async () => {
    mockAnthropicCreate.mockResolvedValueOnce(
      makeHaikuResponse(
        JSON.stringify({
          categories: ["Strategy", "Innovation", "Compliance"],
          entityNoun: "consultancies",
        }),
      ),
    );

    const llmsTxt = "A".repeat(300);
    // No tree, no matching URLs
    const businessJson = {
      geo_profile: { topics: ["Digital", "Strategy", "Compliance"] },
    };

    const p = extractCategoriesViaHaiku(
      "example.com",
      "consulting",
      businessJson,
      llmsTxt,
      null,
      null,
    );
    vi.runAllTimersAsync();
    const result = await p;

    // Falls back to topics since Haiku result fails cross-ref
    expect(["topics", "tree", "fallback"]).toContain(result.source);
  });
});

// ── UT32: Minimum input guard — <200 chars → skip Haiku ─────────────────────

describe("UT32 — extractCategoriesViaHaiku: min input guard <200 chars", () => {
  it("should skip Haiku when combined input is <200 chars", async () => {
    const p = extractCategoriesViaHaiku(
      "example.com",
      "consulting",
      null,
      "",   // llmsTxt empty
      null, // no crawl
      null,
    );
    vi.runAllTimersAsync();
    await p;

    // Haiku should NOT be called
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
  });
});

// ── UT33: entityNoun >30 chars → empty ───────────────────────────────────────

describe("UT33 — validation: entityNoun >30 chars → fallback", () => {
  it("should return empty entityNoun when Haiku entityNoun is >30 chars", async () => {
    mockAnthropicCreate.mockResolvedValueOnce(
      makeHaikuResponse(
        JSON.stringify({
          categories: ["Oncology", "Cardiology", "Orthopedics"],
          entityNoun: "this is way too long to be a valid entity noun",
        }),
      ),
    );

    const llmsTxt = "A".repeat(300);
    const crawlData = makeCrawlData([
      "https://hospital.com/services/oncology",
      "https://hospital.com/services/cardiology",
    ]);

    const p = extractCategoriesViaHaiku(
      "examplehospital.com",
      "healthcare",
      null,
      llmsTxt,
      crawlData,
      null,
    );
    vi.runAllTimersAsync();
    const result = await p;

    // entityNoun should be empty (caller will use INDUSTRY_NOUN_MAP)
    expect(result.entityNoun).toBe("");
  });
});

// ── UT34: Full fallback chain — all sources empty ────────────────────────────

describe("UT34 — extractCategoriesViaHaiku: full fallback chain", () => {
  it("should return siteType as category with source=fallback when all sources fail", async () => {
    mockAnthropicCreate.mockRejectedValueOnce(new Error("Haiku failed"));

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
    expect(result.entityNoun).toBe("hospitals"); // from INDUSTRY_NOUN_MAP
  });
});

// ── UT35: Haiku response with markdown code fences ───────────────────────────

describe("UT35 — extractCategoriesViaHaiku: markdown code fences in response", () => {
  it("should parse JSON correctly when wrapped in markdown code fences", async () => {
    const fencedResponse = "```json\n" +
      JSON.stringify({
        categories: ["Oncology", "Cardiology", "Orthopedics"],
        entityNoun: "hospitals",
      }) +
      "\n```";
    mockAnthropicCreate.mockResolvedValueOnce(makeHaikuResponse(fencedResponse));

    const llmsTxt = "A".repeat(300);
    const crawlData = makeCrawlData([
      "https://hospital.com/services/oncology",
      "https://hospital.com/services/cardiology",
    ]);

    const p = extractCategoriesViaHaiku(
      "examplehospital.com",
      "healthcare",
      null,
      llmsTxt,
      crawlData,
      null,
    );
    vi.runAllTimersAsync();
    const result = await p;

    expect(result.categories).toContain("Oncology");
    expect(result.entityNoun).toBe("hospitals");
  });
});
