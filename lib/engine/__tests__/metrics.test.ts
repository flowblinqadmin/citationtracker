import { describe, it, expect } from "vitest";
import { computeRunMetrics, type ComputeMetricsInput } from "@/lib/engine/metrics";

function base(overrides: Partial<ComputeMetricsInput> = {}): ComputeMetricsInput {
  return {
    promptVersionIds: ["p1", "p2", "p3", "p4"],
    responses: [],
    citations: [],
    articles: [
      { id: "a1", url: "https://outlet.com/story-1", outlet: "Outlet", headline: "H1", publishedAt: "2026-06-05" },
      { id: "a2", url: "https://outlet.com/story-2", outlet: "Outlet", headline: "H2", publishedAt: "2026-05-01" },
    ],
    competitors: [{ name: "Rival", domain: "rival.com" }],
    period: "2026-06",
    ...overrides,
  };
}

describe("computeRunMetrics — counting semantics", () => {
  it("counts exact and confirmed-partial citations, ignores pending/rejected/unmatched", () => {
    const m = computeRunMetrics(base({
      citations: [
        { promptVersionId: "p1", platform: "openai", matchType: "exact", reviewStatus: null, articleId: "a1", competitorDomain: null },
        { promptVersionId: "p2", platform: "openai", matchType: "partial", reviewStatus: "confirmed", articleId: "a2", competitorDomain: null },
        { promptVersionId: "p3", platform: "openai", matchType: "partial", reviewStatus: "pending", articleId: null, competitorDomain: null },
        { promptVersionId: "p4", platform: "openai", matchType: "unmatched", reviewStatus: null, articleId: null, competitorDomain: null },
      ],
    }));
    expect(m.totalCitations).toBe(2);            // exact + confirmed partial
    expect(m.citationRate).toBeCloseTo(2 / 4);    // p1, p2 → 2 of 4 prompts
    expect(m.uniqueArticlesCited).toBe(2);
  });
});

describe("computeRunMetrics — rates use prompt denominator", () => {
  it("citation rate counts DISTINCT prompts, not citation instances", () => {
    const m = computeRunMetrics(base({
      citations: [
        { promptVersionId: "p1", platform: "openai", matchType: "exact", reviewStatus: null, articleId: "a1", competitorDomain: null },
        { promptVersionId: "p1", platform: "google", matchType: "exact", reviewStatus: null, articleId: "a1", competitorDomain: null },
        { promptVersionId: "p1", platform: "perplexity", matchType: "exact", reviewStatus: null, articleId: "a2", competitorDomain: null },
      ],
    }));
    expect(m.totalCitations).toBe(3);
    expect(m.citationRate).toBeCloseTo(1 / 4); // only p1 cited → 1 of 4 prompts
  });

  it("brand mention rate counts prompts with any brand-mentioned response", () => {
    const m = computeRunMetrics(base({
      responses: [
        { promptVersionId: "p1", platform: "openai", brandMentioned: true },
        { promptVersionId: "p1", platform: "google", brandMentioned: false },
        { promptVersionId: "p2", platform: "openai", brandMentioned: true },
        { promptVersionId: "p3", platform: "openai", brandMentioned: false },
      ],
    }));
    expect(m.brandMentionRate).toBeCloseTo(2 / 4); // p1, p2
  });
});

describe("computeRunMetrics — top articles + new this month", () => {
  it("ranks top cited articles by frequency", () => {
    const m = computeRunMetrics(base({
      citations: [
        { promptVersionId: "p1", platform: "openai", matchType: "exact", reviewStatus: null, articleId: "a2", competitorDomain: null },
        { promptVersionId: "p2", platform: "openai", matchType: "exact", reviewStatus: null, articleId: "a1", competitorDomain: null },
        { promptVersionId: "p3", platform: "google", matchType: "exact", reviewStatus: null, articleId: "a1", competitorDomain: null },
      ],
    }));
    expect(m.topCitedArticles[0].articleId).toBe("a1");
    expect(m.topCitedArticles[0].count).toBe(2);
    expect(m.topCitedArticles[1].articleId).toBe("a2");
  });

  it("counts citations of articles published in the run period", () => {
    const m = computeRunMetrics(base({
      // a1 published 2026-06 (this period), a2 published 2026-05
      citations: [
        { promptVersionId: "p1", platform: "openai", matchType: "exact", reviewStatus: null, articleId: "a1", competitorDomain: null },
        { promptVersionId: "p2", platform: "openai", matchType: "exact", reviewStatus: null, articleId: "a2", competitorDomain: null },
      ],
    }));
    expect(m.newThisMonthCited).toBe(1); // only a1
  });
});

describe("computeRunMetrics — platform breakdown", () => {
  it("computes per-platform citation + brand rates", () => {
    const m = computeRunMetrics(base({
      responses: [
        { promptVersionId: "p1", platform: "openai", brandMentioned: true },
        { promptVersionId: "p2", platform: "google", brandMentioned: false },
      ],
      citations: [
        { promptVersionId: "p1", platform: "openai", matchType: "exact", reviewStatus: null, articleId: "a1", competitorDomain: null },
      ],
    }));
    const openai = m.platformBreakdown.find((p) => p.platform === "openai")!;
    const google = m.platformBreakdown.find((p) => p.platform === "google")!;
    expect(openai.citationRate).toBeCloseTo(1 / 4);
    expect(openai.brandMentionRate).toBeCloseTo(1 / 4);
    expect(openai.totalCitations).toBe(1);
    expect(google.citationRate).toBe(0);
  });
});

describe("computeRunMetrics — share of AI voice + competitors", () => {
  it("computes share of voice as client / (client + competitor)", () => {
    const m = computeRunMetrics(base({
      citations: [
        { promptVersionId: "p1", platform: "openai", matchType: "exact", reviewStatus: null, articleId: "a1", competitorDomain: null },
        { promptVersionId: "p2", platform: "openai", matchType: "exact", reviewStatus: null, articleId: "a2", competitorDomain: null },
        { promptVersionId: "p3", platform: "openai", matchType: "unmatched", reviewStatus: null, articleId: null, competitorDomain: "rival.com" },
      ],
    }));
    expect(m.shareOfAiVoice).toBeCloseTo(2 / 3); // 2 client, 1 competitor
    const rival = m.competitorMetrics.find((c) => c.domain === "rival.com")!;
    expect(rival.totalCitations).toBe(1);
    expect(rival.citationRate).toBeCloseTo(1 / 4);
  });

  // R24: when there are no client AND no competitor citations the contest is
  // undefined — returning 0 is a silent-zero antipattern that renders a
  // fabricated "0% Share of AI Voice" KPI card.  Must return null so the
  // consumer renders "—" via pct(null).
  it("returns null for shareOfAiVoice when both client and competitor counts are zero (no-contest run)", () => {
    const m = computeRunMetrics(base({
      citations: [],
    }));
    expect(m.shareOfAiVoice).toBeNull();
  });

  it("returns a numeric value when there are competitor citations even if client has none", () => {
    const m = computeRunMetrics(base({
      citations: [
        { promptVersionId: "p1", platform: "openai", matchType: "unmatched", reviewStatus: null, articleId: null, competitorDomain: "rival.com" },
      ],
    }));
    // 0 client, 1 competitor → 0 / 1 = 0 (numeric, not null)
    expect(m.shareOfAiVoice).toBe(0);
  });
});

describe("computeRunMetrics — review fixes", () => {
  // Fix #3: a confirmed-partial that also carries competitorDomain must not be
  // counted in BOTH the client and competitor buckets.
  it("does not double-count a confirmed partial as both client and competitor", () => {
    const m = computeRunMetrics(base({
      promptVersionIds: ["p1"],
      citations: [
        {
          promptVersionId: "p1", platform: "openai", matchType: "partial",
          reviewStatus: "confirmed", articleId: "a1", competitorDomain: "rival.com",
        },
      ],
    }));
    // 1 client citation, 0 true competitor citations → SoV = 1, not 0.5.
    expect(m.totalCitations).toBe(1);
    expect(m.shareOfAiVoice).toBe(1);
    const rival = m.competitorMetrics.find((c) => c.domain === "rival.com")!;
    expect(rival.totalCitations).toBe(0);
  });

  // Fix #9: Top-5 is deterministic across input-row orderings when counts tie.
  it("produces a stable Top-5 regardless of citation-row order at a tie boundary", () => {
    const ids = ["a1", "a2", "a3", "a4", "a5", "a6"];
    const mk = (order: string[]) =>
      computeRunMetrics(base({
        promptVersionIds: ["p1"],
        articles: ids.map((id) => ({ id, url: `https://o.com/${id}`, outlet: "O", headline: id, publishedAt: "2026-05-01" })),
        // each article cited exactly twice (tie at count=2)
        citations: order.flatMap((id) => [0, 1].map(() => ({
          promptVersionId: "p1", platform: "openai" as const, matchType: "exact" as const,
          reviewStatus: null, articleId: id, competitorDomain: null,
        }))),
      })).topCitedArticles.map((t) => t.articleId);
    const forward = mk(ids);
    const reversed = mk([...ids].reverse());
    expect(forward).toEqual(reversed);
    expect(forward).toEqual(["a1", "a2", "a3", "a4", "a5"]); // articleId asc tie-break
  });
});

describe("computeRunMetrics — edge cases", () => {
  it("never divides by zero with no prompts", () => {
    const m = computeRunMetrics(base({ promptVersionIds: [] }));
    expect(m.promptsTotal).toBe(0);
    expect(m.citationRate).toBe(0);
    expect(m.brandMentionRate).toBe(0);
    // No citations at all → no contest → null (not a fabricated 0%)
    expect(m.shareOfAiVoice).toBeNull();
  });
});
