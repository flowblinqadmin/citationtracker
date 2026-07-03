/**
 * TDD tests for TS-058 Additional Scope: Pillar Ladder UI Split
 * U18 through U20
 *
 * Written before implementation (Phase 1).
 * Tests cover: citation-analytics.tsx pillar split for V2 vs V1 checks.
 *
 * @vitest-environment jsdom
 */

import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CitationAnalytics } from "@/app/components/citation-analytics";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeV2Score(pillarVisibility: Record<string, number> = {}) {
  return {
    checkId: "test-v2",
    domain: "example.com",
    siteId: "site-1",
    teamId: "team-1",
    overallVisibility: 42,
    indirectVisibility: 42,
    brandKnowledge: 60,
    citationQualityScore: 55,
    sentimentScore: 70,
    avgPosition: null,
    bestProvider: null,
    worstProvider: null,
    pillarVisibility,
    pillarQA: {},
    competitorData: [],
    competitorVisibility: {},
    providerResults: [],
    promptsUsed: [],
    promptMetadata: null,
    geoVisibility: [],
    categoryVisibility: [],
    tierVisibility: [],
    avgImpressionShare: null,
    visibilityGapAnalysis: [],
    locationCompetitors: [],
    categoryCompetitors: [],
    dominanceMap: null,
    realPromptDiscovery: null,
    promptArchitectureVersion: 2,
    creditsUsed: 5,
    createdAt: new Date(),
  } as never;
}

function makeV1Score(pillarVisibility: Record<string, number> = {}) {
  return {
    ...makeV2Score(pillarVisibility),
    checkId: "test-v1",
    promptArchitectureVersion: 1,
  } as never;
}

const SAMPLE_PILLAR_VISIBILITY: Record<string, number> = {
  competitive_positioning: 80,
  entity_definitions: 60,
  offering_clarity: 45,
  evidence_statistics: 30,
  contact_trust: 55,
  author_authority: 70,
  faq_coverage: 20,
  content_freshness: 10,
  structured_data: 5,
  metadata_freshness: 15,
  semantic_html: 25,
  multi_format: 35,
  licensing_signals: 40,
  internal_linking: 50,
  content_structure: 60,
  cta_structure: 65,
};

const SAMPLE_GEO_SCORECARD = {
  overallScore: 60,
  pillars: [
    { pillar: "competitive_positioning", pillarName: "Positioning", score: 80, findings: "", recommendation: "", priority: "low" as const, impactedPages: [] },
    { pillar: "entity_definitions", pillarName: "Entities", score: 60, findings: "", recommendation: "", priority: "low" as const, impactedPages: [] },
    { pillar: "offering_clarity", pillarName: "Clarity", score: 45, findings: "", recommendation: "", priority: "medium" as const, impactedPages: [] },
    { pillar: "evidence_statistics", pillarName: "Evidence", score: 30, findings: "", recommendation: "", priority: "high" as const, impactedPages: [] },
    { pillar: "contact_trust", pillarName: "Trust", score: 55, findings: "", recommendation: "", priority: "medium" as const, impactedPages: [] },
    { pillar: "author_authority", pillarName: "Authority", score: 70, findings: "", recommendation: "", priority: "low" as const, impactedPages: [] },
    { pillar: "faq_coverage", pillarName: "FAQ", score: 20, findings: "", recommendation: "", priority: "high" as const, impactedPages: [] },
    { pillar: "content_freshness", pillarName: "Freshness", score: 10, findings: "", recommendation: "", priority: "high" as const, impactedPages: [] },
    { pillar: "structured_data", pillarName: "Structured", score: 5, findings: "", recommendation: "", priority: "high" as const, impactedPages: [] },
    { pillar: "metadata_freshness", pillarName: "Meta", score: 15, findings: "", recommendation: "", priority: "high" as const, impactedPages: [] },
    { pillar: "semantic_html", pillarName: "Semantic", score: 25, findings: "", recommendation: "", priority: "high" as const, impactedPages: [] },
    { pillar: "multi_format", pillarName: "Formats", score: 35, findings: "", recommendation: "", priority: "medium" as const, impactedPages: [] },
    { pillar: "licensing_signals", pillarName: "Licensing", score: 40, findings: "", recommendation: "", priority: "medium" as const, impactedPages: [] },
    { pillar: "internal_linking", pillarName: "Linking", score: 50, findings: "", recommendation: "", priority: "medium" as const, impactedPages: [] },
    { pillar: "content_structure", pillarName: "Structure", score: 60, findings: "", recommendation: "", priority: "low" as const, impactedPages: [] },
    { pillar: "cta_structure", pillarName: "CTA", score: 65, findings: "", recommendation: "", priority: "low" as const, impactedPages: [] },
  ],
  topThreeImprovements: [],
};

// ── U18: V2 check shows split view ────────────────────────────────────────────

describe("U18: CitationAnalytics — V2 check shows AI Citation Visibility (7 buyer pillars)", () => {
  it("renders 'AI Citation Visibility' heading for promptArchitectureVersion=2", () => {
    const result = makeV2Score(SAMPLE_PILLAR_VISIBILITY);
    render(<CitationAnalytics result={result} domain="example.com" />);
    expect(screen.queryByText("AI Citation Visibility")).not.toBeNull();
  });

  it("does NOT render 'GEO Pillar Visibility' for V2 check", () => {
    const result = makeV2Score(SAMPLE_PILLAR_VISIBILITY);
    render(<CitationAnalytics result={result} domain="example.com" />);
    expect(screen.queryByText("GEO Pillar Visibility")).toBeNull();
  });

  it("shows buyer-facing pillar labels in AI Citation Visibility section", () => {
    const result = makeV2Score(SAMPLE_PILLAR_VISIBILITY);
    render(<CitationAnalytics result={result} domain="example.com" />);
    // Buyer pillar labels should be present
    expect(screen.queryByText("Positioning")).not.toBeNull();  // competitive_positioning
    expect(screen.queryByText("Authority")).not.toBeNull();    // author_authority
    expect(screen.queryByText("CTA")).not.toBeNull();           // cta_structure (replaces faq_coverage, removed in ES-060 B1)
  });
});

// ── U19: V1 check shows unified view ─────────────────────────────────────────

describe("U19: CitationAnalytics — V1 check shows unified GEO Pillar Visibility (16 pillars)", () => {
  it("renders 'GEO Pillar Visibility' heading for promptArchitectureVersion=1", () => {
    const result = makeV1Score(SAMPLE_PILLAR_VISIBILITY);
    render(<CitationAnalytics result={result} domain="example.com" />);
    expect(screen.queryByText("GEO Pillar Visibility")).not.toBeNull();
  });

  it("does NOT render 'AI Citation Visibility' for V1 check", () => {
    const result = makeV1Score(SAMPLE_PILLAR_VISIBILITY);
    render(<CitationAnalytics result={result} domain="example.com" />);
    expect(screen.queryByText("AI Citation Visibility")).toBeNull();
  });

  it("renders non-buyer technical pillar labels in V1 unified view", () => {
    const result = makeV1Score(SAMPLE_PILLAR_VISIBILITY);
    render(<CitationAnalytics result={result} domain="example.com" />);
    // These are non-buyer pillars that only appear in unified V1 view
    expect(screen.queryByText("Freshness")).not.toBeNull();  // content_freshness
    expect(screen.queryByText("Semantic")).not.toBeNull();   // semantic_html
  });
});

// ── U20: Content Quality Scores section ──────────────────────────────────────

describe("U20: CitationAnalytics — Content Quality Scores section for V2 check with geoScorecard", () => {
  it("renders 'Content Quality Scores' heading when V2 and geoScorecard provided", () => {
    const result = makeV2Score(SAMPLE_PILLAR_VISIBILITY);
    render(<CitationAnalytics result={result} domain="example.com" geoScorecard={SAMPLE_GEO_SCORECARD} />);
    expect(screen.queryByText("Content Quality Scores")).not.toBeNull();
  });

  it("does NOT render 'Content Quality Scores' for V1 check even with geoScorecard", () => {
    const result = makeV1Score(SAMPLE_PILLAR_VISIBILITY);
    render(<CitationAnalytics result={result} domain="example.com" geoScorecard={SAMPLE_GEO_SCORECARD} />);
    expect(screen.queryByText("Content Quality Scores")).toBeNull();
  });

  it("does NOT render 'Content Quality Scores' for V2 check without geoScorecard", () => {
    const result = makeV2Score(SAMPLE_PILLAR_VISIBILITY);
    render(<CitationAnalytics result={result} domain="example.com" />);
    expect(screen.queryByText("Content Quality Scores")).toBeNull();
  });
});
