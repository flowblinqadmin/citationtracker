/**
 * ES-054 — Cross: Evidence-Based Recommendations + Visibility Gap Analysis
 * Tests U28–U32
 *
 * Spec: EVIDENCE_DATABASE enriches assembleResults() prompt.
 * Spec: generateVisibilityGapAnalysis() — pure function.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock LLM (Claude used by assembler)
const { mockClaudeCall } = vi.hoisted(() => {
  const mockClaudeCall = vi.fn();
  return { mockClaudeCall };
});

vi.mock("@/lib/claude", () => ({
  callClaude: mockClaudeCall,
}));

// Mock OpenAI (used by page-fix-generator if needed)
vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(function () {
    return { chat: { completions: { create: vi.fn() } } };
  }),
}));

import { assembleResults } from "@/lib/services/assembler";
import { generateVisibilityGapAnalysis } from "@/app/api/sites/[id]/citation-check/route";

import type {
  GeoVisibility,
  CategoryVisibility,
  TierVisibility,
  VisibilityGapEntry,
} from "@/lib/types/citation";

// ── Helpers ──────────────────────────────────────────────────────

function makeScorecard() {
  return {
    overallScore: 55,
    pillars: [
      {
        pillar: "faq_coverage",
        pillarName: "FAQ Coverage",
        score: 30,
        weight: 3.8,
        findings: "No FAQ sections found",
        recommendation: "Add FAQ sections",
        priority: "high" as const,
        impactedPages: [],
      },
      {
        pillar: "expert_quotes",
        pillarName: "Expert Quotes",
        score: 20,
        weight: 4.9,
        findings: "No expert quotes",
        recommendation: "Add expert quotes",
        priority: "critical" as const,
        impactedPages: [],
      },
    ],
    topThreeImprovements: ["Add FAQ", "Add quotes", "Improve schema"],
  };
}

function makeCrawlData() {
  return {
    pages: [{ url: "https://example.com", title: "Home", content: "Content", pageType: "homepage", wordCount: 500 }],
    domain: "example.com",
    crawledAt: new Date().toISOString(),
  };
}

function makeGeneratedContent() {
  return {
    schemaBlocks: [],
    executiveSummary: "",
    rankedRecommendations: [],
  };
}

// ── U28–U29: Evidence in recommendations ────────────────────────

describe("Evidence-based recommendations — ES-054 Cross", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  it("U28 — RankedRecommendation includes evidence field", async () => {
    mockClaudeCall.mockResolvedValue(
      JSON.stringify({
        executiveSummary: "Site needs improvement in FAQ and expert content.",
        rankedRecommendations: [
          {
            rank: 1,
            title: "Add FAQ Sections",
            description: "Add comprehensive FAQ sections to service pages.",
            impact: "high",
            effort: "low",
            pillar: "faq_coverage",
            specificAction: "Create FAQ blocks for top 10 service pages.",
            estimatedBoost: "+8 points",
            evidence: "4.9 avg citations vs 4.4 without (SE Ranking, 2025)",
          },
        ],
      })
    );

    const result = await assembleResults(
      "example.com",
      makeCrawlData() as any,
      makeScorecard() as any,
      makeGeneratedContent() as any,
      undefined,
      true
    );

    const faqRec = result.rankedRecommendations.find((r) => r.pillar === "faq_coverage");
    expect(faqRec).toBeDefined();
    expect(faqRec!).toHaveProperty("evidence");
    expect(faqRec!.evidence).toBeTruthy();
  });

  it("U29 — evidence injected into LLM prompt (Princeton GEO reference)", async () => {
    mockClaudeCall.mockResolvedValue(
      JSON.stringify({
        executiveSummary: "Summary",
        rankedRecommendations: [],
      })
    );

    await assembleResults(
      "example.com",
      makeCrawlData() as any,
      makeScorecard() as any,
      makeGeneratedContent() as any,
      undefined,
      true
    );

    // Check that the LLM call included evidence in the prompt
    expect(mockClaudeCall).toHaveBeenCalled();
    const callArgs = mockClaudeCall.mock.calls[0];
    const prompt = typeof callArgs[0] === "string" ? callArgs[0] : JSON.stringify(callArgs);
    expect(prompt.toLowerCase()).toContain("princeton");
  });
});

// ── U30–U32: Visibility Gap Analysis ────────────────────────────

describe("generateVisibilityGapAnalysis — ES-054 Cross", () => {
  it("U30 — prioritizes worst gaps (lowest visibility first)", () => {
    const geo: GeoVisibility[] = [
      { geoId: "blr", geoName: "Bangalore", promptCount: 10, mentionCount: 4, visibility: 40 },
      { geoId: "del", geoName: "Delhi", promptCount: 10, mentionCount: 0, visibility: 0 },
      { geoId: "kol", geoName: "Kolkata", promptCount: 10, mentionCount: 0, visibility: 5 },
    ];
    const cat: CategoryVisibility[] = [];
    const tier: TierVisibility[] = [];

    const gaps = generateVisibilityGapAnalysis(geo, cat, tier);

    // Delhi (0%) and Kolkata (5%) are below 10% threshold
    // Bangalore (40%) is above threshold — excluded
    expect(gaps.length).toBeGreaterThanOrEqual(2);
    expect(gaps[0].visibility).toBeLessThanOrEqual(gaps[1]?.visibility ?? 100);
    expect(gaps[0].id).toBe("del"); // worst first
  });

  it("U31 — caps at 10 entries", () => {
    const geo: GeoVisibility[] = Array.from({ length: 20 }, (_, i) => ({
      geoId: `city-${i}`,
      geoName: `City ${i}`,
      promptCount: 10,
      mentionCount: 0,
      visibility: i, // all below 10% except last few
    }));
    const cat: CategoryVisibility[] = [];
    const tier: TierVisibility[] = [];

    const gaps = generateVisibilityGapAnalysis(geo, cat, tier);

    expect(gaps.length).toBeLessThanOrEqual(10);
  });

  it("U32 — ignores entries with visibility >= 10%", () => {
    const geo: GeoVisibility[] = [
      { geoId: "blr", geoName: "Bangalore", promptCount: 10, mentionCount: 5, visibility: 50 },
      { geoId: "del", geoName: "Delhi", promptCount: 10, mentionCount: 3, visibility: 30 },
    ];
    const cat: CategoryVisibility[] = [
      { categoryId: "cat-1", categoryName: "Ortho", promptCount: 10, mentionCount: 2, visibility: 20 },
    ];
    const tier: TierVisibility[] = [];

    const gaps = generateVisibilityGapAnalysis(geo, cat, tier);

    // All entries above 10% — no gaps
    expect(gaps).toEqual([]);
  });
});
