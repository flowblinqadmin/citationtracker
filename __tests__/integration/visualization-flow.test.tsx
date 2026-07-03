/**
 * Integration tests — ES-060 Visualization Overhaul
 * IT1–IT7
 *
 * Full render scenarios combining multiple components and data paths.
 *
 * @vitest-environment jsdom
 */

import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { CitationCheckScore } from "@/lib/types/citation";

// ── Recharts mock (same as unit tests) ───────────────────────────────────────

vi.mock("recharts", () => ({
  RadarChart: ({ data, children }: { data?: unknown[]; children: React.ReactNode }) => (
    <div data-testid="radar-chart" data-point-count={data?.length ?? 0}>{children}</div>
  ),
  Radar:           () => null,
  PolarGrid:       () => null,
  PolarAngleAxis:  ({ tick }: { tick?: React.ReactElement }) => {
    if (React.isValidElement(tick)) {
      return (
        <g data-testid="polar-angle-axis">
          {React.cloneElement(tick as React.ReactElement<Record<string, unknown>>, {
            payload: { value: "Positioning" }, x: 200, y: 50, cx: 150, cy: 150,
          })}
        </g>
      );
    }
    return <g data-testid="polar-angle-axis" />;
  },
  PolarRadiusAxis: () => null,
  BarChart: ({ data, children }: { data?: Record<string, unknown>[]; children: React.ReactNode }) => (
    <div
      data-testid="bar-chart"
      data-item-count={data?.length ?? 0}
      data-first-is-brand={(data?.[0] as { isBrand?: boolean })?.isBrand ? "true" : "false"}
    >
      {children}
    </div>
  ),
  Bar:      ({ children }: { children?: React.ReactNode }) => <g data-testid="bar">{children}</g>,
  XAxis:    () => null,
  YAxis:    () => null,
  Tooltip:  () => null,
  Cell:     ({ fill }: { fill?: string }) => <rect data-testid="cell" data-fill={fill ?? ""} />,
  LabelList: () => <text data-testid="label-list" />,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { CitationAnalytics } from "@/app/components/citation-analytics";
import { DimensionalIntelligence } from "@/app/components/dimensional-intelligence";
import { CitationHistory } from "@/app/components/citation-history";

afterEach(() => cleanup());

// ── Shared helpers ────────────────────────────────────────────────────────────

function makeScore(
  overrides: Partial<CitationCheckScore> & { promptArchitectureVersion?: number } = {},
): CitationCheckScore & { promptArchitectureVersion?: number } {
  return {
    checkId: "chk-it", siteId: "site-1", teamId: "team-1", domain: "example.com",
    overallVisibility: 50, bestProvider: null, worstProvider: null, avgPosition: null,
    sentimentScore: 0, providerResults: [], competitorVisibility: {}, competitorData: [],
    pillarVisibility: {
      competitive_positioning: 45, offering_clarity: 60, evidence_statistics: 30,
      contact_trust: 20, author_authority: 55, licensing_signals: 10, cta_structure: 80,
    },
    pillarQA: {}, indirectVisibility: 50, brandKnowledge: 40, citationQualityScore: 35,
    creditsUsed: 7, promptsUsed: [], createdAt: new Date(),
    ...overrides,
  } as CitationCheckScore & { promptArchitectureVersion?: number };
}

function makeDimScore(overrides: Record<string, unknown> = {}) {
  return {
    checkId: "chk-dim-it", siteId: "site-1", teamId: "team-1",
    createdAt: new Date(), overallVisibility: 42,
    indirectVisibility: 42, brandKnowledge: 30, citationQualityScore: 25,
    sentimentScore: 0, bestProvider: null, worstProvider: null, avgPosition: null,
    pillarVisibility: {}, pillarQA: {}, competitorData: [],
    providerResults: [], promptsUsed: [],
    tierVisibility: [], geoVisibility: [], categoryVisibility: [],
    visibilityGapAnalysis: [], locationCompetitors: [], categoryCompetitors: [],
    dominanceMap: null, realPromptDiscovery: null, avgImpressionShare: null,
    ...overrides,
  } as unknown as CitationCheckScore;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("IT1-IT7 — Visualization flow integration", () => {

  // IT1: V2 full render — 7-point radar
  it("IT1 — V2 check full render: radar chart has 7 vertices", () => {
    const result = makeScore({ promptArchitectureVersion: 2 });
    const { container } = render(
      <CitationAnalytics result={result} domain="example.com" />
    );
    const radar = container.querySelector("[data-testid='radar-chart']");
    expect(radar).toBeTruthy();
    expect(radar!.getAttribute("data-point-count")).toBe("7");
  });

  // IT2: V1 full render — 16-point radar
  it("IT2 — V1 check full render: radar chart has 16 vertices", () => {
    const result = makeScore({
      promptArchitectureVersion: 1,
      pillarVisibility: {
        author_authority: 45, competitive_positioning: 60, offering_clarity: 30,
        faq_coverage: 20, evidence_statistics: 55, contact_trust: 10,
        content_freshness: 80, structured_data: 25, entity_definitions: 40,
        metadata_freshness: 15, semantic_html: 70, multi_format: 35,
        licensing_signals: 50, internal_linking: 65, content_structure: 20,
        cta_structure: 45,
      },
    });
    const { container } = render(
      <CitationAnalytics result={result} domain="example.com" />
    );
    const radar = container.querySelector("[data-testid='radar-chart']");
    expect(radar!.getAttribute("data-point-count")).toBe("16");
  });

  // IT3: Full result with all data — all sections visible
  it("IT3 — full result with score arcs, SOV chart, and geo bars all render", () => {
    const analyticsResult = makeScore({
      promptArchitectureVersion: 2,
      indirectVisibility: 55,
      competitorData: [
        { name: "rival.com", shareOfVoice: 70, rankedAbove: 50, sentiment: "positive" as const },
      ],
    });
    const dimResult = makeDimScore({
      geoVisibility: [
        { geoId: "g1", geoName: "London",   visibility: 40, promptCount: 5, mentionCount: 3 },
        { geoId: "g2", geoName: "New York",  visibility: 20, promptCount: 5, mentionCount: 1 },
      ],
      tierVisibility: [
        { tier: "buy",  visibility: 60, promptCount: 5, mentionCount: 4 },
        { tier: "solve",visibility: 35, promptCount: 5, mentionCount: 2 },
        { tier: "learn",visibility: 15, promptCount: 5, mentionCount: 1 },
      ],
    });

    const { container: analyticsContainer } = render(
      <CitationAnalytics result={analyticsResult} domain="example.com" />
    );
    const { container: dimContainer } = render(
      <DimensionalIntelligence result={dimResult} domain="example.com" />
    );

    // Score arcs in analytics
    expect(analyticsContainer.querySelectorAll("[data-testid='score-arc']").length).toBe(3);
    // SOV bar chart
    expect(analyticsContainer.querySelector("[data-testid='bar-chart']")).toBeTruthy();
    // Geo bar chart in dimensional
    expect(dimContainer.querySelector("[data-testid='bar-chart']")).toBeTruthy();
    // Buyer intent arcs
    expect(dimContainer.querySelectorAll("[data-testid='score-arc']").length).toBe(3);
  });

  // IT4: Mixed V1/V2 history — version banner visible
  it("IT4 — history with mixed V1/V2 checks shows measurement upgrade banner", () => {
    const geoData = [{ geoId: "g1", geoName: "London", visibility: 40, promptCount: 5, mentionCount: 3 }];
    const mixedHistory: (CitationCheckScore & { promptArchitectureVersion?: number })[] = [
      { ...makeDimScore({ geoVisibility: geoData }), promptArchitectureVersion: 2, createdAt: new Date("2026-03-01") } as unknown as CitationCheckScore & { promptArchitectureVersion?: number },
      { ...makeDimScore({ geoVisibility: geoData }), promptArchitectureVersion: 2, createdAt: new Date("2026-02-15") } as unknown as CitationCheckScore & { promptArchitectureVersion?: number },
      { ...makeDimScore({ geoVisibility: geoData }), promptArchitectureVersion: 1, createdAt: new Date("2026-01-01") } as unknown as CitationCheckScore & { promptArchitectureVersion?: number },
      { ...makeDimScore({ geoVisibility: geoData }), promptArchitectureVersion: 1, createdAt: new Date("2025-12-01") } as unknown as CitationCheckScore & { promptArchitectureVersion?: number },
    ];

    render(
      <DimensionalIntelligence
        result={makeDimScore({ geoVisibility: geoData })}
        domain="example.com"
        history={mixedHistory as unknown as CitationCheckScore[]}
      />
    );
    expect(screen.getByText(/Measurement upgraded/)).toBeTruthy();
  });

  // IT5: Trend sparklines render when 3+ V2 history entries
  it("IT5 — trend sparklines appear in geo bar chart rows when ≥3 V2 checks in history", () => {
    const geoData = [
      { geoId: "geo-1", geoName: "New York", visibility: 35, promptCount: 10, mentionCount: 5 },
    ];
    // Newest-first order (as real app provides)
    const v2History = [
      { ...makeDimScore({ geoVisibility: [{ geoId: "geo-1", geoName: "New York", visibility: 45, promptCount: 5, mentionCount: 4 }] }), promptArchitectureVersion: 2, createdAt: new Date("2026-03-01") },
      { ...makeDimScore({ geoVisibility: [{ geoId: "geo-1", geoName: "New York", visibility: 38, promptCount: 5, mentionCount: 3 }] }), promptArchitectureVersion: 2, createdAt: new Date("2026-02-01") },
      { ...makeDimScore({ geoVisibility: [{ geoId: "geo-1", geoName: "New York", visibility: 30, promptCount: 5, mentionCount: 2 }] }), promptArchitectureVersion: 2, createdAt: new Date("2026-01-01") },
    ];

    const { container } = render(
      <DimensionalIntelligence
        result={makeDimScore({ geoVisibility: geoData })}
        domain="example.com"
        history={v2History as unknown as CitationCheckScore[]}
      />
    );
    const sparklines = container.querySelectorAll("[data-testid='mini-sparkline']");
    expect(sparklines.length).toBeGreaterThan(0);
  });

  // IT6: Mobile responsive — no information hidden at 320px
  it("IT6 — mobile render: competitor badge reflowed, not hidden (no display:none)", () => {
    const { container } = render(
      <CitationAnalytics
        result={makeScore({
          promptArchitectureVersion: 2,
          pillarQA: {
            competitive_positioning: {
              score: 45, samples: [],
              topCompetitor: "rival.com",
            },
          } as unknown as CitationCheckScore["pillarQA"],
        })}
        domain="example.com"
      />
    );
    const style = container.querySelector("style");
    const css = style?.textContent ?? "";
    // Old rule: `.ca-theme-competitor-badge { display: none !important; }` at <640px
    // New rule: should use display:block at small screens, not hide
    expect(css).not.toMatch(/ca-theme-competitor-badge[^}]*display\s*:\s*none/);
  });

  // IT7: Empty data — no crashes
  it("IT7 — empty dimensional data renders without errors", () => {
    expect(() =>
      render(
        <DimensionalIntelligence
          result={makeDimScore()}
          domain="example.com"
        />
      )
    ).not.toThrow();
  });

});
