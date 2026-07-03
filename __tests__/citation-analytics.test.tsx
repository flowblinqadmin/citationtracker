/**
 * Unit tests for CitationAnalytics radar gate — ES-032
 * RZ-1 through RZ-5
 *
 * @vitest-environment jsdom
 */

import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { type CitationCheckScore, type ProviderResult } from "@/lib/types/citation";

// ─── Mock recharts — jsdom has no SVG layout engine ──────────────────────────

vi.mock("recharts", () => ({
  RadarChart: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="radar-chart">{children}</div>
  ),
  Radar:            () => null,
  PolarGrid:        () => null,
  PolarAngleAxis:   () => null,
  PolarRadiusAxis:  () => null,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  BarChart: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="bar-chart">{children}</div>
  ),
  Bar:     () => null,
  XAxis:   () => null,
  YAxis:   () => null,
  Tooltip: () => null,
  Cell:    () => null,
}));

import { CitationAnalytics } from "@/app/components/citation-analytics";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ALL_16_PILLARS_ZERO: Record<string, number> = {
  author_authority:        0,
  competitive_positioning: 0,
  offering_clarity:        0,
  faq_coverage:            0,
  evidence_statistics:     0,
  contact_trust:           0,
  content_freshness:       0,
  structured_data:         0,
  entity_definitions:      0,
  metadata_freshness:      0,
  semantic_html:           0,
  multi_format:            0,
  licensing_signals:       0,
  internal_linking:        0,
  content_structure:       0,
  cta_structure:           0,
};

const PROVIDER_ROW: ProviderResult = {
  provider:        "perplexity",
  model:           "sonar",
  mentionCount:    3,
  totalQueries:    10,
  visibilityScore: 30,
  avgPosition:     null,
  sentiment:       "neutral",
};

function makeScore(
  pillarVisibility: Record<string, number>,
  providerResults: ProviderResult[] = [],
): CitationCheckScore {
  return {
    checkId:              "chk-rz",
    siteId:               "site-1",
    teamId:               "team-1",
    domain:               "example.com",
    overallVisibility:    42,
    bestProvider:         null,
    worstProvider:        null,
    avgPosition:          null,
    sentimentScore:       0,
    providerResults,
    competitorVisibility: {},
    competitorData:       [],
    pillarVisibility,
    indirectVisibility:   25,
    brandKnowledge:       50,
    citationQualityScore: 35,
    creditsUsed:          5,
    promptsUsed:          [],
    createdAt:            new Date(),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("CitationAnalytics — radar gate (ES-032)", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("RZ-1 — 16 pillars all 0 → radar renders, empty state absent", () => {
    render(
      <CitationAnalytics result={makeScore(ALL_16_PILLARS_ZERO)} domain="example.com" />
    );
    expect(screen.queryByTestId("radar-chart")).toBeTruthy();
    expect(screen.queryByText(/No pillar data yet/)).toBeNull();
  });

  it("RZ-2 — pillarVisibility={} → empty state shown, no radar", () => {
    render(
      <CitationAnalytics result={makeScore({})} domain="example.com" />
    );
    expect(
      screen.getByText("No pillar data yet. Run a citation check to see GEO Pillar Visibility.")
    ).toBeTruthy();
    expect(screen.queryByTestId("radar-chart")).toBeNull();
  });

  it("RZ-3 — non-zero pillar values → radar renders, empty state absent", () => {
    render(
      <CitationAnalytics
        result={makeScore({ faq_coverage: 67, author_authority: 33 })}
        domain="example.com"
      />
    );
    expect(screen.queryByTestId("radar-chart")).toBeTruthy();
    expect(screen.queryByText(/No pillar data yet/)).toBeNull();
  });

  it("RZ-4 — score triptych and provider bars unaffected by gate change", () => {
    render(
      <CitationAnalytics
        result={makeScore(ALL_16_PILLARS_ZERO, [PROVIDER_ROW])}
        domain="example.com"
      />
    );
    // Score triptych heading
    expect(screen.getByText("Score Overview")).toBeTruthy();
    // Provider visibility heading (providerResults is non-empty)
    expect(screen.getByText("Provider Visibility")).toBeTruthy();
    // GEO Pillar Visibility heading still present
    expect(screen.getByText("GEO Pillar Visibility")).toBeTruthy();
  });

  it("RZ-5 — null result renders fallback without crash (regression guard)", () => {
    expect(() =>
      render(<CitationAnalytics result={null} domain="example.com" />)
    ).not.toThrow();
    expect(screen.getByText(/Run a citation check to see analytics/)).toBeTruthy();
  });
});
