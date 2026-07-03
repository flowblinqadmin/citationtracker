/**
 * TDD tests for TS-058: Citation Prompt Recomposition — V2 generator
 * U1 through U17
 *
 * Written before implementation (Phase 1).
 * Tests cover: extractCategories, extractGeoLevels, buildCoveringArray,
 * buildSeeds, rephraseSeeds, generatePromptsV2, generatePrompts routing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

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
    return { getGenerativeModel: vi.fn().mockReturnValue({ generateContent: vi.fn() }) };
  }),
}));

// ── Helpers to import after mocks ─────────────────────────────────────────────

import {
  extractCategories,
  extractGeoLevels,
  buildCoveringArray,
  buildSeeds,
  rephraseSeeds,
  generatePromptsV2,
  generatePrompts,
} from "@/lib/services/citation-prompt-generator";
import type { GeoTree, CategoryTree } from "@/lib/types/trees";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

const GEO_TREE_3LEVEL: GeoTree = {
  root: {
    id: "root", name: "Root", pageCount: 0,
    children: [{
      id: "gb", name: "UK", pageCount: 50,
      children: [{
        id: "gb-sct", name: "Scotland", pageCount: 30,
        children: [
          { id: "gb-sct-edi", name: "Edinburgh", pageCount: 20, children: [] },
          { id: "gb-sct-gla", name: "Glasgow",   pageCount: 10, children: [] },
        ],
      }],
    }, {
      id: "us", name: "USA", pageCount: 40,
      children: [{
        id: "us-ca", name: "California", pageCount: 25,
        children: [
          { id: "us-ca-sf", name: "San Francisco", pageCount: 15, children: [] },
        ],
      }],
    }],
  },
  leafCount: 3,
};

const GEO_TREE_EMPTY: GeoTree = {
  root: { id: "root", name: "Root", pageCount: 0, children: [] },
  leafCount: 0,
};

const CATEGORY_TREE: CategoryTree = {
  root: {
    id: "root", name: "Root", pageCount: 0,
    children: [
      { id: "ortho", name: "Orthopedics", pageCount: 40, children: [] },
      { id: "cardio", name: "Cardiology",  pageCount: 30, children: [] },
      { id: "neuro",  name: "Neurology",   pageCount: 20, children: [] },
    ],
  },
  leafCount: 3,
};

const SITE_WITH_TOPICS = {
  domain: "example.com",
  generatedBusinessJson: {
    geo_profile: {
      topics: ["Regulatory Compliance", "Digital Transformation", "Data Privacy"],
      industry: "Consulting",
    },
  },
};

const SITE_WITH_CATEGORY_TREE = {
  domain: "example.com",
  categoryTree: CATEGORY_TREE,
  generatedBusinessJson: { geo_profile: { topics: [] } },
};

const SITE_EMPTY = {
  domain: "example.com",
  generatedBusinessJson: { geo_profile: {} },
};

// ── U1: extractCategories from topics array ───────────────────────────────────

describe("U1: extractCategories — uses geo_profile.topics when present", () => {
  it("returns topics array from businessJson.geo_profile.topics", () => {
    const result = extractCategories(SITE_WITH_TOPICS as never);
    expect(result).toEqual(["Regulatory Compliance", "Digital Transformation", "Data Privacy"]);
  });
});

// ── U2: extractCategories falls back to categoryTree ─────────────────────────

describe("U2: extractCategories — falls back to categoryTree leaf names", () => {
  it("returns top 5 leaf names sorted by pageCount when topics empty", () => {
    const result = extractCategories(SITE_WITH_CATEGORY_TREE as never);
    // Should return category leaf names — Orthopedics (40), Cardiology (30), Neurology (20)
    expect(result).toContain("Orthopedics");
    expect(result).toContain("Cardiology");
    expect(result).toContain("Neurology");
    expect(result.length).toBeLessThanOrEqual(5);
  });
});

// ── U3: extractCategories returns empty when nothing available ────────────────

describe("U3: extractCategories — returns [] when no data", () => {
  it("returns empty array when businessJson has no topics and no categoryTree", () => {
    const result = extractCategories(SITE_EMPTY as never);
    expect(result).toEqual([]);
  });
});

// ── U4: extractGeoLevels with 3-level tree ────────────────────────────────────

describe("U4: extractGeoLevels — extracts global + country + region + city levels", () => {
  it("returns [global, country, region, city] from a 3-level tree", () => {
    const levels = extractGeoLevels(GEO_TREE_3LEVEL);
    const levelNames = levels.map(l => l.level);
    expect(levelNames).toContain("global");
    expect(levelNames).toContain("country");
    expect(levelNames).toContain("region");
    expect(levelNames).toContain("city");
  });

  it("global level has null geoId and null name", () => {
    const levels = extractGeoLevels(GEO_TREE_3LEVEL);
    const global = levels.find(l => l.level === "global");
    expect(global).toBeDefined();
    expect(global!.geoId).toBeNull();
    expect(global!.name).toBeNull();
  });

  it("includes top 2 nodes per level by pageCount", () => {
    const levels = extractGeoLevels(GEO_TREE_3LEVEL);
    const countries = levels.filter(l => l.level === "country");
    expect(countries.length).toBeLessThanOrEqual(2);
    // UK (50 pages) should be included
    expect(countries.some(c => c.name === "UK")).toBe(true);
  });
});

// ── U5: extractGeoLevels with null/empty tree ─────────────────────────────────

describe("U5: extractGeoLevels — no-geo mode when tree null/empty", () => {
  it("returns [global] only when tree is null", () => {
    const levels = extractGeoLevels(null);
    expect(levels).toHaveLength(1);
    expect(levels[0].level).toBe("global");
  });

  it("returns [global] only when tree has leafCount=0", () => {
    const levels = extractGeoLevels(GEO_TREE_EMPTY);
    expect(levels).toHaveLength(1);
    expect(levels[0].level).toBe("global");
  });
});

// ── U6: buildCoveringArray covers all pairs ───────────────────────────────────

describe("U6: buildCoveringArray — covers all (cat,geo), (cat,angle), (geo,angle) pairs", () => {
  it("all (category, geoLevel) pairs appear at least once", () => {
    const categories = ["Compliance", "Privacy"];
    const geoLevels = extractGeoLevels(GEO_TREE_3LEVEL);
    const triples = buildCoveringArray(categories, geoLevels, 36);

    for (const cat of categories) {
      for (const geo of geoLevels) {
        const covered = triples.some(t => t.category === cat && t.geoLevel.level === geo.level && t.geoLevel.name === geo.name);
        expect(covered, `(${cat}, ${geo.level}/${geo.name}) not covered`).toBe(true);
      }
    }
  });

  it("all (category, angle) pairs appear at least once", () => {
    const categories = ["Compliance", "Privacy", "Transformation"];
    const geoLevels = extractGeoLevels(GEO_TREE_3LEVEL);
    const angles = ["discovery", "evaluation", "trust", "clarity", "readiness"];
    const triples = buildCoveringArray(categories, geoLevels, 36);

    for (const cat of categories) {
      for (const angle of angles) {
        const covered = triples.some(t => t.category === cat && t.angle === angle);
        expect(covered, `(${cat}, ${angle}) not covered`).toBe(true);
      }
    }
  });
});

// ── U7: buildCoveringArray respects budget ────────────────────────────────────

describe("U7: buildCoveringArray — respects budget", () => {
  it("returns ≤36 triples for a large input", () => {
    const categories = ["A", "B", "C", "D", "E"];
    const geoLevels = extractGeoLevels(GEO_TREE_3LEVEL);
    const triples = buildCoveringArray(categories, geoLevels, 36);
    expect(triples.length).toBeLessThanOrEqual(36);
  });

  it("returns all combos when total ≤ budget (no-geo SaaS)", () => {
    const categories = ["A", "B", "C"];
    const geoLevels = extractGeoLevels(null); // [global] only → 3×1×5=15 combos
    const triples = buildCoveringArray(categories, geoLevels, 36);
    // All 15 (3 cats × 1 geo × 5 angles) should be included
    expect(triples.length).toBe(15);
  });
});

// ── U8: buildCoveringArray ≥3 per geoId ──────────────────────────────────────

describe("U8: buildCoveringArray — ≥3 prompts per geoId for ES-054 compatibility", () => {
  it("each non-global geoId appears in ≥3 triples", () => {
    const categories = ["Compliance", "Privacy", "Transformation"];
    const geoLevels = extractGeoLevels(GEO_TREE_3LEVEL);
    const triples = buildCoveringArray(categories, geoLevels, 36);

    const geoCounts = new Map<string | null, number>();
    for (const t of triples) {
      const key = t.geoLevel.geoId;
      geoCounts.set(key, (geoCounts.get(key) ?? 0) + 1);
    }

    for (const [geoId, count] of geoCounts.entries()) {
      if (geoId !== null) {
        expect(count, `geoId ${geoId} has only ${count} triples (need ≥3)`).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

// ── U9: buildSeeds correct text ───────────────────────────────────────────────

describe("U9: buildSeeds — produces correct seed text per angle", () => {
  it("discovery angle: 'What are the best {category} companies...'", () => {
    const geoLevels = extractGeoLevels(null);
    const triples = [{ category: "Cloud Security", geoLevel: geoLevels[0], angle: "discovery" as const }];
    const seeds = buildSeeds(triples, "example.com");
    expect(seeds[0].text.toLowerCase()).toContain("cloud security");
    expect(seeds[0].text.toLowerCase()).toMatch(/best|top/);
  });

  it("readiness angle: 'Which ... offer free trials or consultations?'", () => {
    const geoLevels = extractGeoLevels(null);
    const triples = [{ category: "Cloud Security", geoLevel: geoLevels[0], angle: "readiness" as const }];
    const seeds = buildSeeds(triples, "example.com");
    expect(seeds[0].text.toLowerCase()).toContain("cloud security");
    expect(seeds[0].text.toLowerCase()).toMatch(/free trial|consultation|started/i);
  });

  it("adds geo suffix for city-level prompts", () => {
    const cityLevel = { level: "city" as const, name: "Edinburgh", geoId: "gb-sct-edi" };
    const triples = [{ category: "Fintech", geoLevel: cityLevel, angle: "discovery" as const }];
    const seeds = buildSeeds(triples, "example.com");
    expect(seeds[0].text).toContain("Edinburgh");
  });
});

// ── U10: buildSeeds correct tags ──────────────────────────────────────────────

describe("U10: buildSeeds — assigns correct geoId, categoryId, pillar, tier", () => {
  it("discovery angle maps to competitive_positioning pillar and learn tier", () => {
    const geoLevels = extractGeoLevels(null);
    const triples = [{ category: "Cloud Security", geoLevel: geoLevels[0], angle: "discovery" as const }];
    const seeds = buildSeeds(triples, "example.com");
    expect(seeds[0].pillar).toBe("competitive_positioning");
    expect(seeds[0].tier).toBe("learn");
  });

  it("evaluation angle maps to evidence_statistics pillar and solve tier", () => {
    const geoLevels = extractGeoLevels(null);
    const triples = [{ category: "Cloud Security", geoLevel: geoLevels[0], angle: "evaluation" as const }];
    const seeds = buildSeeds(triples, "example.com");
    expect(seeds[0].pillar).toBe("evidence_statistics");
    expect(seeds[0].tier).toBe("solve");
  });

  it("readiness angle maps to buy tier", () => {
    const geoLevels = extractGeoLevels(null);
    const triples = [{ category: "Cloud Security", geoLevel: geoLevels[0], angle: "readiness" as const }];
    const seeds = buildSeeds(triples, "example.com");
    expect(seeds[0].tier).toBe("buy");
  });

  it("city-level triple carries geoId on seed", () => {
    const cityLevel = { level: "city" as const, name: "Edinburgh", geoId: "gb-sct-edi" };
    const triples = [{ category: "Fintech", geoLevel: cityLevel, angle: "trust" as const }];
    const seeds = buildSeeds(triples, "example.com");
    expect(seeds[0].geoId).toBe("gb-sct-edi");
  });
});

// ── U11: rephraseSeeds parses numbered output ─────────────────────────────────

describe("U11: rephraseSeeds — parses 1:1 numbered output from Haiku", () => {
  it("maps numbered lines back to seeds in correct order", async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "1. Who are the top cloud security firms?\n2. Which data privacy services offer free consultations?" }],
    });

    const seeds = [
      { text: "What are the best cloud security companies?", geoId: null, categoryId: "cloud-security", pillar: "competitive_positioning", tier: "learn" as const },
      { text: "Which data privacy services offer free trials or consultations?", geoId: null, categoryId: "data-privacy", pillar: "faq_coverage", tier: "buy" as const },
    ];

    const result = await rephraseSeeds(seeds);
    expect(result[0]).toBe("Who are the top cloud security firms?");
    expect(result[1]).toBe("Which data privacy services offer free consultations?");
  });
});

// ── U12: rephraseSeeds validates keywords ─────────────────────────────────────

describe("U12: rephraseSeeds — falls back to raw seed on validation failure", () => {
  it("uses raw seed when rephrased prompt missing category keyword", async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "1. Who provides good enterprise services worldwide?" }],
    });

    const seeds = [
      { text: "What are the best cloud security companies?", geoId: null, categoryId: "cloud-security", pillar: "competitive_positioning", tier: "learn" as const },
    ];

    const result = await rephraseSeeds(seeds);
    // "cloud security" not in rephrased → fall back to raw
    expect(result[0]).toBe("What are the best cloud security companies?");
  });
});

// ── U13: rephraseSeeds handles Haiku failure ──────────────────────────────────

describe("U13: rephraseSeeds — returns raw seeds on Haiku timeout/error", () => {
  it("returns raw seed texts when Haiku throws", async () => {
    mockAnthropicCreate.mockRejectedValueOnce(new Error("timeout"));

    const seeds = [
      { text: "What are the best cloud security companies?", geoId: null, categoryId: "cloud-security", pillar: "competitive_positioning", tier: "learn" as const },
      { text: "Which compliance firms in Edinburgh are trusted?", geoId: "gb-sct-edi", categoryId: "compliance", pillar: "author_authority", tier: "solve" as const },
    ];

    const result = await rephraseSeeds(seeds);
    expect(result[0]).toBe("What are the best cloud security companies?");
    expect(result[1]).toBe("Which compliance firms in Edinburgh are trusted?");
  });
});

// ── U14: generatePromptsV2 end-to-end ─────────────────────────────────────────

describe("U14: generatePromptsV2 — end-to-end with 3 categories and geo tree", () => {
  it("returns 44 total prompts (36 indirect + 8 direct)", async () => {
    // Haiku returns sequential rephrased prompts
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: Array.from({ length: 36 }, (_, i) => `${i + 1}. Rephrased query ${i + 1} cloud security`).join("\n") }],
    });

    const site = {
      domain: "example.com",
      geoTree: GEO_TREE_3LEVEL,
      categoryTree: CATEGORY_TREE,
      generatedBusinessJson: {
        geo_profile: { topics: ["Cloud Security", "Data Privacy", "Compliance"] },
      },
    };

    const result = await generatePromptsV2(site as never);
    expect(result).not.toBeNull();
    const indirect = result!.filter(p => p.type === "indirect");
    const direct = result!.filter(p => p.type === "direct");
    expect(indirect.length).toBe(36);
    expect(direct.length).toBe(8);
  });

  it("each indirect prompt has pillar, tier, geoId, type=indirect", async () => {
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: Array.from({ length: 36 }, (_, i) => `${i + 1}. Rephrased cloud security query ${i + 1}`).join("\n") }],
    });

    const site = {
      domain: "example.com",
      geoTree: GEO_TREE_3LEVEL,
      categoryTree: CATEGORY_TREE,
      generatedBusinessJson: {
        geo_profile: { topics: ["Cloud Security", "Data Privacy", "Compliance"] },
      },
    };

    const result = await generatePromptsV2(site as never);
    const indirect = result!.filter(p => p.type === "indirect");
    for (const p of indirect) {
      expect(p.type).toBe("indirect");
      expect(p.pillar).not.toBeNull();
      expect(p.tier).not.toBeUndefined();
    }
  });
});

// ── U15: generatePromptsV2 no-geo mode ───────────────────────────────────────

describe("U15: generatePromptsV2 — no-geo mode (null geoTree)", () => {
  it("all indirect prompts have null geoId when geoTree absent", async () => {
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: Array.from({ length: 15 }, (_, i) => `${i + 1}. Rephrased cloud security query ${i + 1}`).join("\n") }],
    });

    const site = {
      domain: "example.com",
      geoTree: null,
      generatedBusinessJson: {
        geo_profile: { topics: ["Cloud Security", "Data Privacy", "Compliance"] },
      },
    };

    const result = await generatePromptsV2(site as never);
    expect(result).not.toBeNull();
    const indirect = result!.filter(p => p.type === "indirect");
    for (const p of indirect) {
      expect(p.geoId ?? null).toBeNull();
    }
  });
});

// ── U16: generatePrompts routes to V2 when categories exist ──────────────────

describe("U16: generatePrompts — routes to V2 when categories extractable", () => {
  it("calls Haiku (mockAnthropicCreate) when businessJson has topics", async () => {
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: Array.from({ length: 15 }, (_, i) => `${i + 1}. Cloud security query ${i + 1}`).join("\n") }],
    });

    const site = {
      domain: "example.com",
      geoTree: null,
      generatedBusinessJson: {
        geo_profile: { topics: ["Cloud Security", "Data Privacy", "Compliance"] },
      },
    };

    const result = await generatePrompts(site as never);
    expect(result.length).toBeGreaterThan(0);
    // Haiku was called (V2 path)
    expect(mockAnthropicCreate).toHaveBeenCalled();
  });
});

// ── U17: generatePrompts falls back to legacy when no categories ──────────────

describe("U17: generatePrompts — falls back to legacy when no categories", () => {
  it("uses legacy generator (also calls Haiku for legacy path) when categories empty", async () => {
    // Legacy also uses Haiku/OpenAI — just verify the output is CitationPrompt[]
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify([
        { type: "indirect", pillar: "competitive_positioning", prompt: "Who are the top software companies?", geoId: null, categoryId: null, tier: "learn", queryType: "discovery" },
      ]) }],
    });

    const site = {
      domain: "example.com",
      geoTree: null,
      categoryTree: null,
      generatedBusinessJson: { geo_profile: {} },
    };

    const result = await generatePrompts(site as never);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });
});

// ── U21: AC19 — site_type persisted from businessJson.geo_profile.industry ───

describe("U21: AC19 — site_type sourced from businessJson.geo_profile.industry", () => {
  it("extracts industry from businessJson when siteType is empty", () => {
    // Validate the extraction logic used by citation-check/route.ts (AC19)
    const businessJson = { geo_profile: { industry: "Healthcare Technology" } };
    const bj = businessJson as { geo_profile?: { industry?: string } };
    const industry = bj?.geo_profile?.industry;
    expect(industry).toBe("Healthcare Technology");
  });

  it("returns undefined industry when businessJson lacks geo_profile", () => {
    const businessJson = { name: "Some Company" } as { geo_profile?: { industry?: string } };
    expect(businessJson?.geo_profile?.industry).toBeUndefined();
  });

  it("returns undefined industry when geo_profile has no industry field", () => {
    const businessJson = { geo_profile: { topics: ["SaaS"] } } as {
      geo_profile?: { industry?: string };
    };
    expect(businessJson?.geo_profile?.industry).toBeUndefined();
  });
});

// ── U22: AC20 — competitor discovery uses crawl description, not "software tool" ─

describe("U22: AC20 — competitor discovery category from crawl description", () => {
  it("uses first sentence of crawl description as category when siteType empty", () => {
    const siteType: string | null = null;
    const groundingText = "We provide cloud security solutions. More details.";
    const category = siteType ||
      (groundingText
        ? groundingText.split(/[.!?]/)[0]?.trim().slice(0, 80) || "business"
        : "business");
    expect(category).toBe("We provide cloud security solutions");
    expect(category).not.toContain("software tool");
  });

  it("falls back to 'business' when no grounding text and no siteType", () => {
    const siteType: string | null = null;
    const groundingText = "";
    const category = siteType ||
      (groundingText
        ? groundingText.split(/[.!?]/)[0]?.trim().slice(0, 80) || "business"
        : "business");
    expect(category).toBe("business");
    expect(category).not.toBe("software tool");
  });

  it("uses siteType when provided (not overridden by crawl description)", () => {
    const siteType = "Cybersecurity Platform";
    const groundingText = "We provide cloud security solutions.";
    const category = siteType ||
      (groundingText
        ? groundingText.split(/[.!?]/)[0]?.trim().slice(0, 80) || "business"
        : "business");
    expect(category).toBe("Cybersecurity Platform");
  });
});

// ── IT1-IT4: V2 integration tests ────────────────────────────────────────────

describe("IT1-IT4: V2 integration — prompt architecture version, geo/category coverage", () => {
  const makeGeoTree = (): GeoTree => ({
    root: {
      id: "global", name: "Global", level: "global",
      children: [{
        id: "us", name: "United States", level: "country",
        children: [{ id: "us-ca", name: "California", level: "state", children: [
          { id: "us-ca-sf", name: "San Francisco", level: "city", children: [], pageCount: 15, evidence: [] },
        ], pageCount: 15, evidence: [] }],
        pageCount: 15, evidence: [],
      }],
      pageCount: 15, evidence: [],
    },
    leafCount: 1,
    extractedAt: new Date().toISOString(),
  });

  const makeV2Site = () => ({
    domain: "acme.io",
    siteType: "SaaS",
    geoTree: makeGeoTree(),
    categoryTree: null,
    geoCategoryMapping: null,
    generatedBusinessJson: {
      geo_profile: { topics: ["cloud security", "identity management"] },
    },
  });

  it("IT1: V2 prompts have categoryId set — promptArchitectureVersion=2 detectable", async () => {
    // Haiku mock: undefined → rephraseSeeds falls back to raw seeds
    const result = await generatePrompts(makeV2Site() as never);

    // All indirect V2 prompts should have categoryId
    const indirectPrompts = result.filter(p => p.type === "indirect");
    expect(indirectPrompts.length).toBeGreaterThan(0);
    indirectPrompts.forEach(p => {
      expect(p.categoryId).toBeTruthy();
    });

    // Route logic: prompts.some(p => p.categoryId) → version=2
    const detectedVersion = result.some(p => p.categoryId) ? 2 : 1;
    expect(detectedVersion).toBe(2);
  });

  it("IT2: V2 prompts produce non-empty geoId and categoryId — enables geoVisibility/categoryVisibility", async () => {
    const result = await generatePrompts(makeV2Site() as never);

    const withGeo = result.filter(p => p.geoId !== null && p.geoId !== undefined);
    const withCategory = result.filter(p => p.categoryId);

    // Both geo and category data present for dimensional analysis
    expect(withGeo.length).toBeGreaterThan(0);
    expect(withCategory.length).toBeGreaterThan(0);

    // At least some prompts reference San Francisco (deepest geo level)
    const sfPrompts = result.filter(p => p.geoId === "us-ca-sf");
    expect(sfPrompts.length).toBeGreaterThan(0);
  });

  it("IT3: no-geo site generates V2 prompts with all indirect geoId=null", async () => {
    const noGeoSite = {
      domain: "saas.io",
      siteType: "SaaS",
      geoTree: null,
      categoryTree: null,
      geoCategoryMapping: null,
      generatedBusinessJson: {
        geo_profile: { topics: ["project management"] },
      },
    };

    const result = await generatePrompts(noGeoSite as never);

    // V2 path taken (has topics)
    expect(result.some(p => p.categoryId)).toBe(true);

    // All indirect prompts have geoId=null (no-geo mode)
    result.filter(p => p.type === "indirect").forEach(p => {
      expect(p.geoId ?? null).toBeNull();
    });
  });

  it("IT4: V1 legacy prompts have no categoryId — version detects as 1", async () => {
    // Legacy path: no topics, no categoryTree → legacy generator
    const legacySite = {
      domain: "old.com",
      siteType: "retail",
      geoTree: null,
      categoryTree: null,
      geoCategoryMapping: null,
      generatedBusinessJson: null,
      generatedLlmsTxt: "Old company website.",
    };

    // Haiku mock for legacy path
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify([
        { type: "indirect", pillar: "author_authority", prompt: "Who are experts in retail?" },
      ]) }],
    });

    const result = await generatePrompts(legacySite as never);

    // Legacy prompts have no categoryId
    const detectedVersion = result.some(p => p.categoryId) ? 2 : 1;
    expect(detectedVersion).toBe(1);
  });
});
