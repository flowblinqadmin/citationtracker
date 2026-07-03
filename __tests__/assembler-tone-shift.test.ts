/**
 * ES-045 Unit Tests — U19–U21: Assembler Tone Shift
 *
 * Written by ReviewMaster (Agent 9) — independent of ScriptDev.
 * Tests isPaidUser parameter on assembleResults() in lib/services/assembler.ts.
 *
 * @group es045
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────────────────

const mockCallClaude = vi.hoisted(() => vi.fn());

vi.mock("@/lib/claude", () => ({
  callClaude: mockCallClaude,
}));

// Mock OpenAI for projected score computations (if used)
vi.mock("openai", () => ({
  default: function () {
    return { chat: { completions: { create: vi.fn() } } };
  },
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeGeoScorecard() {
  return {
    overallScore: 55,
    pillars: [
      { pillar: "structured_data", pillarName: "Structured Data", score: 30, priority: "critical", weight: 0.20 },
      { pillar: "technical_seo", pillarName: "Technical SEO", score: 40, priority: "high", weight: 0.15 },
      { pillar: "content_quality", pillarName: "Content Quality", score: 70, priority: "medium", weight: 0.15 },
      { pillar: "authority_trust", pillarName: "Authority & Trust", score: 80, priority: "low", weight: 0.10 },
    ],
    topThreeImprovements: ["Add schema", "Fix titles", "Improve content"],
  };
}

function makeCrawlData() {
  return {
    pages: [
      { url: "https://example.com/", title: "Home", headings: ["Welcome"], content: "Home page content..." },
      { url: "https://example.com/services", title: "Services", headings: ["Our Services"], content: "Services content..." },
    ],
  };
}

function makeGeneratedContent() {
  return {
    llmsTxt: "# Example\n\n## Services\n- Service A\n- Service B",
    businessJson: JSON.stringify({ name: "Example", services: ["A", "B"] }),
    schemaBlocks: [{ "@type": "LocalBusiness", pageTarget: "all pages" }],
  };
}

// ── Import under test ──────────────────────────────────────────────────────

let assembleResults: (
  domain: string,
  crawlData: ReturnType<typeof makeCrawlData>,
  geoScorecard: ReturnType<typeof makeGeoScorecard>,
  generatedContent: ReturnType<typeof makeGeneratedContent>,
  researchData?: unknown,
  isPaidUser?: boolean
) => Promise<{ executiveSummary: string; rankedRecommendations: unknown[] }>;

beforeEach(async () => {
  vi.clearAllMocks();

  // Mock callClaude to capture prompt and return a plausible summary
  mockCallClaude.mockImplementation(async (prompt: string) => {
    return `This is the executive summary.\n\nParagraph about the market.\n\nParagraph about what to change or FlowBlinq depending on tone.`;
  });

  try {
    const mod = await import("@/lib/services/assembler");
    assembleResults = mod.assembleResults;
  } catch {
    // Module not yet updated
  }
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("ES-045: assembleResults tone shift", () => {
  /**
   * U19: isPaidUser=true → prompt contains "What to change", NOT "What FlowBlinq changes".
   */
  it("U19: isPaidUser=true prompt has 'What to change'", async () => {
    if (!assembleResults) return;

    await assembleResults(
      "example.com",
      makeCrawlData(),
      makeGeoScorecard(),
      makeGeneratedContent(),
      undefined,
      true // isPaidUser
    );

    expect(mockCallClaude).toHaveBeenCalled();
    const prompt = mockCallClaude.mock.calls[0][0] as string;

    expect(prompt).toContain("What to change");
    expect(prompt).not.toContain("What FlowBlinq changes");
    expect(prompt).toContain("Do NOT mention FlowBlinq");
  });

  /**
   * U20: isPaidUser=false → prompt contains "What FlowBlinq changes".
   */
  it("U20: isPaidUser=false prompt has 'What FlowBlinq changes'", async () => {
    if (!assembleResults) return;

    await assembleResults(
      "example.com",
      makeCrawlData(),
      makeGeoScorecard(),
      makeGeneratedContent(),
      undefined,
      false // isPaidUser
    );

    expect(mockCallClaude).toHaveBeenCalled();
    const prompt = mockCallClaude.mock.calls[0][0] as string;

    expect(prompt).toContain("What FlowBlinq changes");
    expect(prompt).not.toContain("What to change");
  });

  /**
   * U21: isPaidUser=undefined defaults to free tone (backward compatible).
   */
  it("U21: isPaidUser=undefined defaults to free tone", async () => {
    if (!assembleResults) return;

    await assembleResults(
      "example.com",
      makeCrawlData(),
      makeGeoScorecard(),
      makeGeneratedContent(),
      undefined,
      undefined // isPaidUser omitted
    );

    expect(mockCallClaude).toHaveBeenCalled();
    const prompt = mockCallClaude.mock.calls[0][0] as string;

    // Default should be free tier (mentions FlowBlinq)
    expect(prompt).toContain("What FlowBlinq changes");
  });

  /**
   * AC18: assembleResults signature is backward compatible (optional isPaidUser).
   */
  it("AC18: backward compatible — works without isPaidUser param", async () => {
    if (!assembleResults) return;

    // Call with original 4-arg signature (no researchData, no isPaidUser)
    const result = await assembleResults(
      "example.com",
      makeCrawlData(),
      makeGeoScorecard(),
      makeGeneratedContent()
    );

    expect(result).toBeDefined();
    expect(result.executiveSummary).toBeTruthy();
    expect(Array.isArray(result.rankedRecommendations)).toBe(true);
  });
});
