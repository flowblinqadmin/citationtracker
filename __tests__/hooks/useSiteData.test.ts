/**
 * TDD tests — app/sites/[id]/hooks/useSiteData.ts
 * PR-A monolith extraction: all derived computations from (site, lastCitationCheck)
 *
 * These tests are RED until hooks/useSiteData.ts is created.
 *
 * NOTE: useSiteData is a pure computation hook (no async, no effects).
 * We call it via renderHook so React rules are respected, but all assertions
 * are synchronous — no act/waitFor needed.
 */

/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useSiteData } from "@/app/sites/[id]/hooks/useSiteData";
import type { SiteData } from "@/app/sites/[id]/types";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const baseSite = {
  id: "site-123",
  domain: "example.com",
  pipelineStatus: "complete",
  geoScorecard: {
    overallScore: 72,
    pillars: [
      { pillar: "schema", pillarName: "Schema", score: 80, findings: "Good", recommendation: "None", priority: "low", impactedPages: [] },
      { pillar: "faq", pillarName: "FAQ", score: 20, findings: "Missing", recommendation: "Add FAQ", priority: "critical", impactedPages: ["/about"] },
      { pillar: "content", pillarName: "Content", score: 55, findings: "OK", recommendation: "Improve", priority: "medium", impactedPages: [] },
    ],
  },
  rankedRecommendations: [
    { rank: 1, pillar: "faq", title: "Add FAQ", priority: "critical", estimatedBoost: "Pages with FAQ content average 4.9 AI citations", description: "Add FAQ sections", effort: "medium", specificAction: "Add FAQ schema" },
    { rank: 2, pillar: "schema", title: "Fix schema", priority: "HIGH", estimatedBoost: "+5 points", description: "Fix schema", effort: "low" },
    { rank: 3, pillar: "content", title: "Add content", priority: "MED", estimatedBoost: "+3", description: "More content", effort: "high" },
    { rank: 4, pillar: "meta", title: "Fix meta", priority: "LOW", estimatedBoost: "2x improvement", description: "Fix meta", effort: "low" },
  ],
  pageCount: 10,
  crawlData: { pages: new Array(10).fill({ url: "https://example.com/page" }) },
  perPageResults: [
    { url: "https://example.com/", pageType: "homepage", title: "Home", overallPageHealth: "good", vulnerabilities: [] },
    { url: "https://example.com/about", pageType: "about", title: "About", overallPageHealth: "needs-work", vulnerabilities: [
      { pillar: "faq", pillarName: "FAQ", severity: "high", finding: "No FAQ", recommendation: "Add FAQ" },
      { pillar: "schema", pillarName: "Schema", severity: "critical", finding: "No schema", recommendation: "Add schema" },
    ]},
    { url: "https://example.com/blog", pageType: "blog", title: "Blog", overallPageHealth: "poor", vulnerabilities: [
      { pillar: "content", pillarName: "Content", severity: "critical", finding: "Thin", recommendation: "Expand" },
      { pillar: "faq", pillarName: "FAQ", severity: "high", finding: "No FAQ", recommendation: "Add FAQ" },
      { pillar: "schema", pillarName: "Schema", severity: "high", finding: "No schema", recommendation: "Add schema" },
    ]},
  ],
  projectedScore: 82,
  changeLog: [
    { runAt: "2026-03-01T00:00:00Z", overallScore: 65, projectedScore: 75, crawlQuality: { goodPages: 8, errorPages: 2, coverageScore: 80, blockedByAntiBot: false, usable: true }, pillarScores: { schema: 70, faq: 15, content: 50 } },
    { runAt: "2026-03-15T00:00:00Z", overallScore: 72, projectedScore: 82, crawlQuality: { goodPages: 10, errorPages: 0, coverageScore: 100, blockedByAntiBot: false, usable: true }, pillarScores: { schema: 80, faq: 20, content: 55 } },
  ],
  tier: "paid",
  credits: 20,
  token: "test-token",
  slug: "example-com",
  pipelineError: null,
  executiveSummary: null,
  generatedLlmsTxt: "llms content",
  generatedLlmsFullTxt: null,
  generatedBusinessJson: null,
  generatedSchemaBlocks: null,
  discoveryData: null,
  platformDetected: null,
  manualRunsThisMonth: null,
  crawlCount: null,
  lastCrawlAt: "2026-03-20T00:00:00Z",
  nextCrawlAt: null,
  createdAt: "2026-03-01T00:00:00Z",
  domainVerified: true,
  verifyToken: null,
  baselineScore: 65,
  improvementDelta: 7,
  citationNarrative: null,
} as unknown as SiteData;

const baseCitationCheck = {
  overallVisibility: 48,
  citationQualityScore: 87,
  providerResults: [
    { provider: "perplexity", visibilityScore: 38, mentionCount: 5, totalQueries: 13, samples: [{ question: "What is example.com?", answer: "Example is...", mentioned: true }] },
    { provider: "openai", visibilityScore: 62, mentionCount: 8, totalQueries: 13 },
    { provider: "anthropic", visibilityScore: 54, mentionCount: 7, totalQueries: 13 },
    { provider: "google", visibilityScore: 38, mentionCount: 5, totalQueries: 13 },
  ],
  competitorData: [
    { name: "Stripe", domain: "stripe.com", shareOfVoice: 4 },
    { name: "Square", domain: "square.com", shareOfVoice: 0 },
  ],
  pillarVisibility: { schema: 60, faq: 10, content: 45 },
  geoVisibility: [],
  categoryVisibility: [],
  tierVisibility: [],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function run(site: SiteData | null, lastCitationCheck: typeof baseCitationCheck | null = null) {
  const { result } = renderHook(() => useSiteData(site, lastCitationCheck));
  return result.current;
}

// ── Scorecard derivations ─────────────────────────────────────────────────────

describe("useSiteData — scorecard", () => {
  it("D1 — scorecard returns the geoScorecard object", () => {
    const data = run(baseSite);
    expect(data.scorecard).toEqual(baseSite.geoScorecard);
    expect(data.scorecard?.overallScore).toBe(72);
  });

  it("D2 — pillars returns the 3-element pillars array", () => {
    const data = run(baseSite);
    expect(data.pillars).toHaveLength(3);
    expect(data.pillars[0].pillar).toBe("schema");
    expect(data.pillars[1].pillar).toBe("faq");
    expect(data.pillars[2].pillar).toBe("content");
  });

  it("D3 — liveScore returns overallScore (72)", () => {
    const data = run(baseSite);
    expect(data.liveScore).toBe(72);
  });
});

// ── pageCount ─────────────────────────────────────────────────────────────────

describe("useSiteData — pageCount", () => {
  it("D4 — pageCount returns site.pageCount (10) when present", () => {
    const data = run(baseSite);
    expect(data.pageCount).toBe(10);
  });

  it("D4b — pageCount falls back to crawlData.pages.length when pageCount absent", () => {
    const site = { ...baseSite, pageCount: undefined } as unknown as SiteData;
    const data = run(site);
    expect(data.pageCount).toBe(10); // crawlData has 10 pages
  });

  it("D4c — pageCount is 0 when both pageCount and crawlData are absent", () => {
    const site = { ...baseSite, pageCount: undefined, crawlData: null } as unknown as SiteData;
    const data = run(site);
    expect(data.pageCount).toBe(0);
  });
});

// ── criticalCount ─────────────────────────────────────────────────────────────

describe("useSiteData — criticalCount", () => {
  it("D5 — criticalCount counts pillars with score < 25 OR priority 'critical'", () => {
    // faq: score 20 (< 25) AND priority 'critical' → counts as 1
    // schema: score 80, priority 'low' → 0
    // content: score 55, priority 'medium' → 0
    const data = run(baseSite);
    expect(data.criticalCount).toBe(1);
  });

  it("D5b — criticalCount counts a pillar with priority critical even if score >= 25", () => {
    const site = {
      ...baseSite,
      geoScorecard: {
        overallScore: 60,
        pillars: [
          { pillar: "a", pillarName: "A", score: 30, priority: "critical" }, // score OK but priority critical
          { pillar: "b", pillarName: "B", score: 80, priority: "low" },
        ],
      },
    } as unknown as SiteData;
    const data = run(site);
    expect(data.criticalCount).toBe(1);
  });

  it("D5c — criticalCount counts a pillar with score < 25 even if priority is not critical", () => {
    const site = {
      ...baseSite,
      geoScorecard: {
        overallScore: 60,
        pillars: [
          { pillar: "a", pillarName: "A", score: 10, priority: "low" }, // score < 25
          { pillar: "b", pillarName: "B", score: 80, priority: "low" },
        ],
      },
    } as unknown as SiteData;
    const data = run(site);
    expect(data.criticalCount).toBe(1);
  });
});

// ── tierCounts ────────────────────────────────────────────────────────────────

describe("useSiteData — tierCounts", () => {
  it("D6 — tierCounts buckets pillars by score: Poor=1, Weak=0, Fair=1, Good=1", () => {
    // schema=80 → Good, faq=20 → Poor, content=55 → Fair
    const data = run(baseSite);
    expect(data.tierCounts).toEqual({ Poor: 1, Weak: 0, Fair: 1, Good: 1 });
  });

  it("D6b — all pillars at 0 gives Poor=N", () => {
    const site = {
      ...baseSite,
      geoScorecard: {
        overallScore: 0,
        pillars: [
          { pillar: "a", pillarName: "A", score: 0, priority: "low" },
          { pillar: "b", pillarName: "B", score: 0, priority: "low" },
        ],
      },
    } as unknown as SiteData;
    const data = run(site);
    expect(data.tierCounts.Poor).toBe(2);
    expect(data.tierCounts.Good).toBe(0);
  });
});

// ── recs (recommendations sorted by priority) ─────────────────────────────────

describe("useSiteData — recs", () => {
  it("D7 — recs sorted by priority: critical first, then HIGH, MED, LOW", () => {
    const data = run(baseSite);
    expect(data.recs).toHaveLength(4);
    // critical (rank 1 in fixture) stays first
    expect(data.recs[0].priority).toBe("critical");
    expect(data.recs[0].pillar).toBe("faq");
    // HIGH comes second
    expect(data.recs[1].priority).toBe("HIGH");
    expect(data.recs[1].pillar).toBe("schema");
    // MED third
    expect(data.recs[2].priority).toBe("MED");
    expect(data.recs[2].pillar).toBe("content");
    // LOW last
    expect(data.recs[3].priority).toBe("LOW");
    expect(data.recs[3].pillar).toBe("meta");
  });

  it("D7b — recs is empty when site has no rankedRecommendations", () => {
    const site = { ...baseSite, rankedRecommendations: null } as unknown as SiteData;
    const data = run(site);
    expect(data.recs).toHaveLength(0);
  });

  it("D7c — recs treats 'high' (lowercase) same as 'HIGH'", () => {
    const site = {
      ...baseSite,
      rankedRecommendations: [
        { rank: 1, pillar: "x", title: "X", priority: "high", estimatedBoost: "+1" },
        { rank: 2, pillar: "y", title: "Y", priority: "LOW", estimatedBoost: "+2" },
      ],
    } as unknown as SiteData;
    const data = run(site);
    expect(data.recs[0].pillar).toBe("x");
    expect(data.recs[1].pillar).toBe("y");
  });
});

// ── sortedPages ───────────────────────────────────────────────────────────────

describe("useSiteData — sortedPages", () => {
  it("D8 — sortedPages orders worst-first: poor → needs-work → good", () => {
    const data = run(baseSite);
    expect(data.sortedPages).toHaveLength(3);
    expect(data.sortedPages[0].url).toBe("https://example.com/blog");         // poor
    expect(data.sortedPages[1].url).toBe("https://example.com/about");        // needs-work
    expect(data.sortedPages[2].url).toBe("https://example.com/");             // good
  });

  it("D8b — sortedPages is empty when perPageResults is null", () => {
    const site = { ...baseSite, perPageResults: null } as unknown as SiteData;
    const data = run(site);
    expect(data.sortedPages).toHaveLength(0);
  });

  it("D8c — among same health tier, more critical/high vulns sort first", () => {
    const site = {
      ...baseSite,
      perPageResults: [
        { url: "https://example.com/a", overallPageHealth: "poor", vulnerabilities: [{ severity: "high" }] },
        { url: "https://example.com/b", overallPageHealth: "poor", vulnerabilities: [{ severity: "critical" }, { severity: "high" }] },
      ],
    } as unknown as SiteData;
    const data = run(site);
    // b has 2 critical/high, a has 1 → b sorts first
    expect(data.sortedPages[0].url).toBe("https://example.com/b");
    expect(data.sortedPages[1].url).toBe("https://example.com/a");
  });
});

// ── projectedScore ────────────────────────────────────────────────────────────

describe("useSiteData — projectedScore", () => {
  it("D10 — projectedScore returns site.projectedScore (82)", () => {
    const data = run(baseSite);
    expect(data.projectedScore).toBe(82);
  });

  it("D10b — projectedScore is null when site.projectedScore is absent", () => {
    const site = { ...baseSite, projectedScore: null } as unknown as SiteData;
    const data = run(site);
    expect(data.projectedScore).toBeNull();
  });
});

// ── changeLog ─────────────────────────────────────────────────────────────────

describe("useSiteData — changeLog", () => {
  it("D11 — changeLog returns the 2 entries from site.changeLog", () => {
    const data = run(baseSite);
    expect(data.changeLog).toHaveLength(2);
    expect(data.changeLog[0].overallScore).toBe(65);
    expect(data.changeLog[1].overallScore).toBe(72);
  });

  it("D11b — changeLog is empty array when site.changeLog is absent", () => {
    const site = { ...baseSite, changeLog: null } as unknown as SiteData;
    const data = run(site);
    expect(data.changeLog).toHaveLength(0);
  });
});

// ── pillarDisplayName ─────────────────────────────────────────────────────────

describe("useSiteData — pillarDisplayName", () => {
  it("D12 — 'schema' maps to 'Schema' via pillarNameMap", () => {
    const data = run(baseSite);
    expect(data.pillarDisplayName("schema")).toBe("Schema");
  });

  it("D12b — 'faq' maps to 'FAQ' via pillarNameMap", () => {
    const data = run(baseSite);
    expect(data.pillarDisplayName("faq")).toBe("FAQ");
  });

  it("D12c — unknown pillar ID is title-cased with underscores as spaces", () => {
    const data = run(baseSite);
    // e.g. "my_custom_pillar" → "My Custom Pillar"
    expect(data.pillarDisplayName("my_custom_pillar")).toBe("My Custom Pillar");
  });

  it("D12d — 'evidence_statistics' maps to short name 'Evidence'", () => {
    const data = run(baseSite);
    expect(data.pillarDisplayName("evidence_statistics")).toBe("Evidence");
  });

  it("D12e — 'entity_definitions' maps to short name 'Entities'", () => {
    const data = run(baseSite);
    expect(data.pillarDisplayName("entity_definitions")).toBe("Entities");
  });

  it("D12f — 'competitive_positioning' maps to short name 'Positioning'", () => {
    const data = run(baseSite);
    expect(data.pillarDisplayName("competitive_positioning")).toBe("Positioning");
  });
});

// ── null site: defaults ───────────────────────────────────────────────────────

describe("useSiteData — null site", () => {
  it("D13 — scorecard is null", () => {
    const data = run(null);
    expect(data.scorecard).toBeNull();
  });

  it("D13 — pillars is empty array", () => {
    const data = run(null);
    expect(data.pillars).toHaveLength(0);
  });

  it("D13 — liveScore is null", () => {
    const data = run(null);
    expect(data.liveScore).toBeNull();
  });

  it("D13 — pageCount is 0", () => {
    const data = run(null);
    expect(data.pageCount).toBe(0);
  });

  it("D13 — criticalCount is 0", () => {
    const data = run(null);
    expect(data.criticalCount).toBe(0);
  });

  it("D13 — tierCounts all zeros", () => {
    const data = run(null);
    expect(data.tierCounts).toEqual({ Poor: 0, Weak: 0, Fair: 0, Good: 0 });
  });

  it("D13 — recs is empty array", () => {
    const data = run(null);
    expect(data.recs).toHaveLength(0);
  });

  it("D13 — sortedPages is empty array", () => {
    const data = run(null);
    expect(data.sortedPages).toHaveLength(0);
  });

  it("D13 — projectedScore is null", () => {
    const data = run(null);
    expect(data.projectedScore).toBeNull();
  });

  it("D13 — changeLog is empty array", () => {
    const data = run(null);
    expect(data.changeLog).toHaveLength(0);
  });

  it("D13 — pillarDisplayName still title-cases unknown ids", () => {
    const data = run(null);
    expect(data.pillarDisplayName("some_pillar")).toBe("Some Pillar");
  });
});

// ── Citation check derivations ────────────────────────────────────────────────

describe("useSiteData — providerAggregates (with citationCheck)", () => {
  it("D14 — providerAggregates returns 4 entries with correct names", () => {
    const data = run(baseSite, baseCitationCheck);
    expect(data.providerAggregates).toHaveLength(4);
    const names = data.providerAggregates.map((p) => p.name);
    expect(names).toContain("Perplexity");
    expect(names).toContain("OpenAI");
    expect(names).toContain("Anthropic");
    // "google" → title-cased to "Google"
    expect(names).toContain("Google");
  });

  it("D14b — Perplexity aggregate has mentionCount=5, totalQueries=13", () => {
    const data = run(baseSite, baseCitationCheck);
    const perp = data.providerAggregates.find((p) => p.name === "Perplexity");
    expect(perp).toBeDefined();
    expect(perp!.mentionCount).toBe(5);
    expect(perp!.totalQueries).toBe(13);
  });

  it("D14c — OpenAI aggregate has mentionCount=8, totalQueries=13", () => {
    const data = run(baseSite, baseCitationCheck);
    const openai = data.providerAggregates.find((p) => p.name === "OpenAI");
    expect(openai!.mentionCount).toBe(8);
    expect(openai!.totalQueries).toBe(13);
  });
});

describe("useSiteData — citationRate", () => {
  it("D15 — citationRate = round((5+8+7+5)/(13+13+13+13)*100) = 48", () => {
    // totalMentions = 25, totalQueries = 52
    // 25/52 = 0.4807... → round = 48
    const data = run(baseSite, baseCitationCheck);
    expect(data.citationRate).toBe(48);
  });

  it("D15b — citationRate is null when no citation check", () => {
    const data = run(baseSite, null);
    expect(data.citationRate).toBeNull();
  });

  it("D15c — citationRate is null when totalQueries=0", () => {
    const check = {
      ...baseCitationCheck,
      providerResults: [
        { provider: "openai", visibilityScore: 0, mentionCount: 0, totalQueries: 0 },
      ],
    };
    const data = run(baseSite, check);
    expect(data.citationRate).toBeNull();
  });
});

describe("useSiteData — ourSOV", () => {
  it("D16 — ourSOV returns overallVisibility (48)", () => {
    const data = run(baseSite, baseCitationCheck);
    expect(data.ourSOV).toBe(48);
  });

  it("D16b — ourSOV is null when no citation check", () => {
    const data = run(baseSite, null);
    expect(data.ourSOV).toBeNull();
  });
});

describe("useSiteData — topCompetitor", () => {
  it("D17 — topCompetitor is Stripe (highest shareOfVoice=4)", () => {
    const data = run(baseSite, baseCitationCheck);
    expect(data.topCompetitor).not.toBeNull();
    expect(data.topCompetitor!.name).toBe("Stripe");
    expect(data.topCompetitor!.shareOfVoice).toBe(4);
  });

  it("D17b — topCompetitor is null when competitorData is empty", () => {
    const check = { ...baseCitationCheck, competitorData: [] };
    const data = run(baseSite, check);
    expect(data.topCompetitor).toBeNull();
  });

  it("D17c — topCompetitor is null when no citation check", () => {
    const data = run(baseSite, null);
    expect(data.topCompetitor).toBeNull();
  });
});

describe("useSiteData — hasSovSamples", () => {
  it("D18 — hasSovSamples is true when at least one provider has samples", () => {
    // perplexity has 1 sample in baseCitationCheck
    const data = run(baseSite, baseCitationCheck);
    expect(data.hasSovSamples).toBe(true);
  });

  it("D18b — hasSovSamples is false when no provider has samples", () => {
    const check = {
      ...baseCitationCheck,
      providerResults: [
        { provider: "openai", visibilityScore: 62, mentionCount: 8, totalQueries: 13, samples: [] },
        { provider: "anthropic", visibilityScore: 54, mentionCount: 7, totalQueries: 13 },
      ],
    };
    const data = run(baseSite, check);
    expect(data.hasSovSamples).toBe(false);
  });

  it("D18c — hasSovSamples is false when no citation check", () => {
    const data = run(baseSite, null);
    expect(data.hasSovSamples).toBe(false);
  });
});

describe("useSiteData — competitorData and visibleCompetitors", () => {
  it("D19 — competitorData returns all 2 entries including 0% Square", () => {
    const data = run(baseSite, baseCitationCheck);
    expect(data.competitorData).toHaveLength(2);
    const names = data.competitorData.map((c) => c.name);
    expect(names).toContain("Stripe");
    expect(names).toContain("Square");
  });

  it("D20 — visibleCompetitors equals competitorData (no tier gating)", () => {
    const data = run(baseSite, baseCitationCheck);
    expect(data.visibleCompetitors).toEqual(data.competitorData);
  });

  it("D19b — competitorData is empty array when no citation check", () => {
    const data = run(baseSite, null);
    expect(data.competitorData).toHaveLength(0);
  });
});
