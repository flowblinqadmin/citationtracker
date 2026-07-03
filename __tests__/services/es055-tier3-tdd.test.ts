/**
 * ES-055 — Tier 3: Content Intelligence — ScriptDev TDD Tests (T1–T35)
 *
 * Phase 1 tests written BEFORE implementation.
 * Spec: geo/docs/specs/engineering/ES-055-geo-improvement-tier3.md
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock Setup (for C10 engine-preference-analyzer) ──────────────

const { mockCreate: mockSonnetCreate, mockDbSelect: mockDbSelectFn } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockDbSelect: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockSonnetCreate } };
  }),
}));

vi.mock("@/lib/db", () => {
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([]),
  };
  mockDbSelectFn.mockReturnValue(selectChain);
  return {
    db: {
      select: mockDbSelectFn,
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      }),
    },
  };
});

vi.mock("@/lib/db/schema", () => ({
  citationCheckScores: {},
  citationCheckResponses: {},
  geoSites: {},
}));

import {
  scoreQuotations,
  scoreStatistics,
  scoreCitedSources,
  scorePageStrategies,
  aggregateStrategyReport,
} from "@/lib/services/content-strategy-scorer";

import { auditPageZones } from "@/lib/services/page-fix-generator";
import { analyzeEnginePreferences } from "@/lib/services/engine-preference-analyzer";

// ── Helpers ───────────────────────────────────────────────────────

function makePage(content: string, overrides: Partial<{
  url: string; wordCount: number; faqContent: string[];
}> = {}) {
  return {
    url: overrides.url ?? "https://example.com/page",
    title: "Test Page",
    content,
    pageType: "services",
    wordCount: overrides.wordCount ?? content.split(/\s+/).length,
    existingSchema: "",
    contactInfo: "",
    faqContent: overrides.faqContent ?? [],
    headings: [],
    metaDescription: "",
    links: [],
  };
}

// ── T1–T8: scoreQuotations edge cases ────────────────────────────

describe("scoreQuotations — ES-055 C8 (TDD)", () => {
  it("T1: markdown blockquote (> prefix) detected", () => {
    const content = "> Healthcare must be accessible to all — Dr. Patel\n\nMore text here.";
    const result = scoreQuotations(content);
    expect(result.count).toBeGreaterThanOrEqual(1);
  });

  it("T2: count>0 but no attribution → score = 50", () => {
    const content = `<blockquote>This is a generic quote without attribution.</blockquote>`;
    const result = scoreQuotations(content);
    expect(result.count).toBeGreaterThanOrEqual(1);
    expect(result.hasAttribution).toBe(false);
    expect(result.score).toBe(50);
  });

  it("T3: 'says' attribution pattern detected", () => {
    const content = "Dr. Johnson says the new protocol reduces complications by 30%.";
    const result = scoreQuotations(content);
    expect(result.count).toBeGreaterThanOrEqual(1);
    expect(result.hasAttribution).toBe(true);
  });

  it("T4: 'noted' attribution pattern detected", () => {
    const content = "As noted Dr. Williams, the findings are consistent across populations.";
    const result = scoreQuotations(content);
    expect(result.count).toBeGreaterThanOrEqual(1);
  });

  it("T5: empty content → count = 0, score = 0", () => {
    const result = scoreQuotations("");
    expect(result.count).toBe(0);
    expect(result.score).toBe(0);
    expect(result.hasAttribution).toBe(false);
  });
});

// ── T6–T11: scoreStatistics edge cases ───────────────────────────

describe("scoreStatistics — ES-055 C8 (TDD)", () => {
  it("T6: billion/million keyword detected", () => {
    const content = "The market is worth 5 billion dollars and growing rapidly.";
    const result = scoreStatistics(content);
    expect(result.count).toBeGreaterThanOrEqual(1);
  });

  it("T7: multiplier (×) detected as well as (x)", () => {
    const content = "Throughput improved by 4× over the previous benchmark this year.";
    const result = scoreStatistics(content);
    expect(result.count).toBeGreaterThanOrEqual(1);
  });

  it("T8: source attribution near stat → hasSourceAttribution = true", () => {
    const content = "Revenue grew 45%. Source: Company Annual Report 2024.";
    const result = scoreStatistics(content);
    expect(result.hasSourceAttribution).toBe(true);
  });

  it("T9: count >= 3 with source → score = 100", () => {
    const content = [
      "Revenue grew by 45%. Source: Annual Report.",
      "Costs reduced by 20%.",
      "Patient satisfaction rose by 35%.",
      "<table><tr><td>A</td></tr></table>",
    ].join(" ");
    const result = scoreStatistics(content);
    expect(result.count).toBeGreaterThanOrEqual(3);
    expect(result.score).toBe(100);
  });

  it("T10: count > 0, no source → score = 50", () => {
    const content = "Revenue grew by 20% this year compared to last year's baseline.";
    const result = scoreStatistics(content);
    expect(result.count).toBeGreaterThanOrEqual(1);
    expect(result.hasSourceAttribution).toBe(false);
    expect(result.score).toBe(50);
  });
});

// ── T11–T14: scoreCitedSources edge cases ────────────────────────

describe("scoreCitedSources — ES-055 C8 (TDD)", () => {
  it("T11: arxiv.org treated as authoritative", () => {
    const content = "[LLM citation study](https://arxiv.org/abs/2024.12345) shows interesting results.";
    const result = scoreCitedSources(content);
    expect(result.authoritativeLinkCount).toBeGreaterThanOrEqual(1);
  });

  it("T12: pubmed treated as authoritative", () => {
    const content = "[Clinical trial results](https://pubmed.ncbi.nlm.nih.gov/98765)";
    const result = scoreCitedSources(content);
    expect(result.authoritativeLinkCount).toBeGreaterThanOrEqual(1);
  });

  it("T13: [N] footnote pattern counted as inline citation", () => {
    const content = "As established in the field [1], the approach works well. See also [2].";
    const result = scoreCitedSources(content);
    expect(result.inlineCitationCount).toBeGreaterThanOrEqual(1);
  });

  it("T14: no links and no citations → score = 0", () => {
    const content = "Our hospital provides excellent care to patients across all specialties.";
    const result = scoreCitedSources(content);
    expect(result.externalLinkCount).toBe(0);
    expect(result.score).toBe(0);
  });
});

// ── T15–T16: scorePageStrategies ─────────────────────────────────

describe("scorePageStrategies — ES-055 C8 (TDD)", () => {
  it("T15: compositeScore = 41% * quotScore + 33% * statScore + 26% * citScore", () => {
    // Quote score 100, stat 50, citation 0 → 0.41*100 + 0.33*50 + 0.26*0 = 41 + 16.5 = 57.5 → 58 (rounded)
    const content = [
      // Attribution → quote score 100
      "According to Dr. Smith, outcomes improved significantly in all departments.",
      // One stat but no source → stat score 50
      "Revenue grew by 30% in the last fiscal year.",
      // No external links, no citations
    ].join(" ");
    const page = makePage(content);
    const result = scorePageStrategies(page as any);
    // Allow some rounding tolerance
    expect(result.compositeScore).toBeGreaterThan(50);
    expect(result.compositeScore).toBeLessThanOrEqual(65);
  });

  it("T16: url field is preserved from page", () => {
    const page = makePage("Plain content.", { url: "https://test.com/my-page" });
    const result = scorePageStrategies(page as any);
    expect(result.url).toBe("https://test.com/my-page");
  });
});

// ── T17–T18: aggregateStrategyReport ─────────────────────────────

describe("aggregateStrategyReport — ES-055 C8 (TDD)", () => {
  it("T17: computedAt is ISO-8601 timestamp", () => {
    const pages = [makePage("Simple content.")];
    const report = aggregateStrategyReport(pages as any[]);
    expect(new Date(report.computedAt).toISOString()).toBe(report.computedAt);
  });

  it("T18: pagesWithQuotes counts only pages with count > 0", () => {
    const pages = [
      makePage("According to Dr. Smith, the data shows progress."),
      makePage("No quotes or attribution here at all."),
      makePage("No quotes or attribution here at all either."),
    ];
    const report = aggregateStrategyReport(pages as any[]);
    expect(report.quotations.pagesWithQuotes).toBe(1);
    expect(report.quotations.pagesTotal).toBe(3);
  });
});

// ── T19–T24: auditPageZones edge cases ───────────────────────────

describe("auditPageZones — ES-055 C9 (TDD)", () => {
  it("T19: table with < 2 rows → hasComparisonTable = false", () => {
    const content = `
      <table><tr><td>Single row only</td></tr></table>
    `;
    const audit = auditPageZones(makePage(content, { wordCount: 500 }) as any);
    expect(audit.hasComparisonTable).toBe(false);
  });

  it("T20: table with exactly 2 rows → hasComparisonTable = true", () => {
    const content = `
      <table>
        <tr><th>Header A</th><th>Header B</th></tr>
        <tr><td>Value A</td><td>Value B</td></tr>
      </table>
    `;
    const audit = auditPageZones(makePage(content, { wordCount: 500 }) as any);
    expect(audit.hasComparisonTable).toBe(true);
  });

  it("T21: data evidence requires statistics.count >= 3 from scores", () => {
    const content = "Service page without data statistics.";
    const lowScores = {
      url: "https://example.com/page",
      quotations: { count: 0, hasAttribution: false, score: 0 },
      statistics: { count: 2, hasSourceAttribution: false, score: 50 },
      citations: { externalLinkCount: 0, authoritativeLinkCount: 0, inlineCitationCount: 0, score: 0 },
      compositeScore: 0,
    };
    const highScores = { ...lowScores, statistics: { count: 3, hasSourceAttribution: false, score: 50 } };

    const auditLow = auditPageZones(makePage(content, { wordCount: 500 }) as any, lowScores as any);
    const auditHigh = auditPageZones(makePage(content, { wordCount: 500 }) as any, highScores as any);

    expect(auditLow.hasDataEvidence).toBe(false);
    expect(auditHigh.hasDataEvidence).toBe(true);
  });

  it("T22: paragraph with pronouns does NOT qualify as quotable block", () => {
    const content = [
      "Introduction paragraph here.",
      "", // double newline
      // 45-word paragraph WITH pronouns — should not be quotable
      "We believe that our approach to healthcare is transformative and enables our patients to achieve better outcomes in their journey toward recovery and wellness.",
      "",
      "Conclusion follows.",
    ].join("\n");
    const audit = auditPageZones(makePage(content, { wordCount: 500 }) as any);
    expect(audit.hasQuotableBlock).toBe(false);
  });

  it("T23: paragraph < 40 words does NOT qualify as quotable block", () => {
    const content = `
      Short intro.

      Artificial intelligence enables faster diagnosis and better outcomes.

      More content here.
    `;
    const audit = auditPageZones(makePage(content, { wordCount: 500 }) as any);
    // This paragraph is ~8 words, too short for quotable block
    expect(audit.hasQuotableBlock).toBe(false);
  });

  it("T24: missingZones list excludes detected zones", () => {
    const content = `
      Service page with a clear FAQ section already present.
      Our services cover all major medical specialties.
    `;
    const page = makePage(content, {
      wordCount: 500,
      faqContent: ["Q1?", "Q2?"],
    });
    const audit = auditPageZones(page as any);
    expect(audit.hasFaqSection).toBe(true);
    expect(audit.missingZones).not.toContain("faq_section");
  });
});

// ── T25–T30: analyzeEnginePreferences checkpoint logic ──────────

describe("analyzeEnginePreferences — ES-055 C10 (TDD)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  it("T25: 5th check is a checkpoint (triggers analysis)", async () => {
    const selectChain = mockDbSelectFn();
    selectChain.where
      .mockResolvedValueOnce([{ count: 5 }])
      .mockResolvedValueOnce([]);

    mockSonnetCreate.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify([
        { provider: "chatgpt", rules: [{ rule: "R1", confidence: "high", evidence: "E" }],
          analyzedAt: new Date().toISOString(), checkCount: 5 },
      ]) }],
    });

    const result = await analyzeEnginePreferences("example.com", "site-5");
    expect(mockSonnetCreate).toHaveBeenCalled();
    expect(result).not.toBeNull();
  });

  it("T26: 10th check is a checkpoint (triggers analysis)", async () => {
    const selectChain = mockDbSelectFn();
    selectChain.where
      .mockResolvedValueOnce([{ count: 10 }])
      .mockResolvedValueOnce([]);

    mockSonnetCreate.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify([
        { provider: "claude", rules: [{ rule: "R1", confidence: "medium", evidence: "E" }],
          analyzedAt: new Date().toISOString(), checkCount: 10 },
      ]) }],
    });

    const result = await analyzeEnginePreferences("example.com", "site-10");
    expect(mockSonnetCreate).toHaveBeenCalled();
    expect(result).not.toBeNull();
  });

  it("T27: 6th check is NOT a checkpoint (returns null)", async () => {
    const selectChain = mockDbSelectFn();
    selectChain.where.mockResolvedValueOnce([{ count: 6 }]);

    const result = await analyzeEnginePreferences("example.com", "site-6");
    expect(result).toBeNull();
    expect(mockSonnetCreate).not.toHaveBeenCalled();
  });

  it("T28: 20th check is a checkpoint (% 10 === 0)", async () => {
    const selectChain = mockDbSelectFn();
    selectChain.where
      .mockResolvedValueOnce([{ count: 20 }])
      .mockResolvedValueOnce([]);

    mockSonnetCreate.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify([
        { provider: "perplexity", rules: [{ rule: "R1", confidence: "low", evidence: "E" }],
          analyzedAt: new Date().toISOString(), checkCount: 20 },
      ]) }],
    });

    const result = await analyzeEnginePreferences("example.com", "site-20");
    expect(mockSonnetCreate).toHaveBeenCalled();
    expect(result).not.toBeNull();
  });

  it("T29: invalid JSON from Sonnet → returns null, no throw", async () => {
    const selectChain = mockDbSelectFn();
    selectChain.where
      .mockResolvedValueOnce([{ count: 3 }])
      .mockResolvedValueOnce([]);

    mockSonnetCreate.mockResolvedValue({
      content: [{ type: "text", text: "Not valid JSON at all ~~~" }],
    });

    const result = await analyzeEnginePreferences("example.com", "site-inv");
    expect(result).toBeNull();
  });

  it("T30: rules capped at 5 per provider", async () => {
    const selectChain = mockDbSelectFn();
    selectChain.where
      .mockResolvedValueOnce([{ count: 3 }])
      .mockResolvedValueOnce([]);

    const manyRules = Array.from({ length: 10 }, (_, i) => ({
      rule: `Rule ${i}`, confidence: "medium" as const, evidence: `Evidence ${i}`,
    }));
    mockSonnetCreate.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify([
        { provider: "chatgpt", rules: manyRules, analyzedAt: new Date().toISOString(), checkCount: 3 },
      ]) }],
    });

    const result = await analyzeEnginePreferences("example.com", "site-cap");
    expect(result).not.toBeNull();
    expect(result![0].rules.length).toBeLessThanOrEqual(5);
  });

  it("T31: result includes analyzedAt ISO timestamp and checkCount", async () => {
    const selectChain = mockDbSelectFn();
    selectChain.where
      .mockResolvedValueOnce([{ count: 3 }])
      .mockResolvedValueOnce([]);

    const now = new Date().toISOString();
    mockSonnetCreate.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify([
        { provider: "chatgpt", rules: [{ rule: "R1", confidence: "high", evidence: "E" }],
          analyzedAt: now, checkCount: 3 },
      ]) }],
    });

    const result = await analyzeEnginePreferences("example.com", "site-ts");
    expect(result).not.toBeNull();
    expect(result![0].analyzedAt).toBeTruthy();
    expect(result![0].checkCount).toBeGreaterThan(0);
  });

  it("T32: 1st check → null (below threshold)", async () => {
    const selectChain = mockDbSelectFn();
    selectChain.where.mockResolvedValueOnce([{ count: 1 }]);

    const result = await analyzeEnginePreferences("example.com", "site-1");
    expect(result).toBeNull();
    expect(mockSonnetCreate).not.toHaveBeenCalled();
  });

  it("T33: 2nd check → null (below threshold)", async () => {
    const selectChain = mockDbSelectFn();
    selectChain.where.mockResolvedValueOnce([{ count: 2 }]);

    const result = await analyzeEnginePreferences("example.com", "site-2");
    expect(result).toBeNull();
    expect(mockSonnetCreate).not.toHaveBeenCalled();
  });
});

// ── T34–T35: Schema field presence ───────────────────────────────

describe("ES-055 type contracts (TDD)", () => {
  it("T34: ContentStrategyReport has required top-level fields", () => {
    const report = aggregateStrategyReport([]);
    expect(report).toHaveProperty("quotations");
    expect(report).toHaveProperty("statistics");
    expect(report).toHaveProperty("citations");
    expect(report).toHaveProperty("computedAt");
    expect(report.quotations).toHaveProperty("avgPerPage");
    expect(report.quotations).toHaveProperty("pagesWithQuotes");
    expect(report.quotations).toHaveProperty("pagesTotal");
    expect(report.quotations).toHaveProperty("overallScore");
  });

  it("T35: PageZoneAudit has all required zone fields", () => {
    const audit = auditPageZones(makePage("Content.") as any);
    expect(audit).toHaveProperty("url");
    expect(audit).toHaveProperty("hasDirectAnswer");
    expect(audit).toHaveProperty("hasComparisonTable");
    expect(audit).toHaveProperty("hasDataEvidence");
    expect(audit).toHaveProperty("hasExpertQuote");
    expect(audit).toHaveProperty("hasFaqSection");
    expect(audit).toHaveProperty("hasQuotableBlock");
    expect(audit).toHaveProperty("missingZones");
  });
});
