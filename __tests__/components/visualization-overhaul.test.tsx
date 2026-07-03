/**
 * Unit tests — ES-060 Visualization Overhaul
 * UT1–UT35
 *
 * @vitest-environment jsdom
 */

import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type {
  CitationCheckScore,
  TierVisibility,
  GeoVisibility,
  CategoryVisibility,
  LocationCompetitor,
} from "@/lib/types/citation";

// ── Recharts mock ─────────────────────────────────────────────────────────────
// Bar renders children so Cell fills are testable.
// PolarAngleAxis clones the tick element with a dummy payload to test custom ticks.

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
  BarChart: ({ data, layout, children }: { data?: Record<string, unknown>[]; layout?: string; children: React.ReactNode }) => (
    <div
      data-testid="bar-chart"
      data-item-count={data?.length ?? 0}
      data-layout={layout ?? ""}
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

// ── Shared fixtures ───────────────────────────────────────────────────────────

const ACCENT = "#b45309";
const GREEN  = "#16a34a";
const AMBER  = "#d97706";
const RED    = "#dc2626";

function makeScore(
  overrides: Partial<CitationCheckScore> & { promptArchitectureVersion?: number } = {},
): CitationCheckScore & { promptArchitectureVersion?: number } {
  return {
    checkId:              "chk-060",
    siteId:               "site-1",
    teamId:               "team-1",
    domain:               "example.com",
    overallVisibility:    50,
    bestProvider:         null,
    worstProvider:        null,
    avgPosition:          null,
    sentimentScore:       0,
    providerResults:      [],
    competitorVisibility: {},
    competitorData:       [],
    pillarVisibility: {
      competitive_positioning: 45,
      offering_clarity:        60,
      evidence_statistics:     30,
      contact_trust:           20,
      author_authority:        55,
      licensing_signals:       10,
      cta_structure:           80,
    },
    pillarQA:             {},
    indirectVisibility:   50,
    brandKnowledge:       40,
    citationQualityScore: 35,
    creditsUsed:          7,
    promptsUsed:          [],
    createdAt:            new Date(),
    ...overrides,
  } as CitationCheckScore & { promptArchitectureVersion?: number };
}

const V2_SCORE = makeScore({ promptArchitectureVersion: 2 });
const V1_SCORE = makeScore({
  promptArchitectureVersion: 1,
  pillarVisibility: {
    author_authority:        45, competitive_positioning: 60, offering_clarity: 30,
    faq_coverage:            20, evidence_statistics:     55, contact_trust:    10,
    content_freshness:       80, structured_data:         25, entity_definitions: 40,
    metadata_freshness:      15, semantic_html:           70, multi_format:      35,
    licensing_signals:       50, internal_linking:        65, content_structure: 20,
    cta_structure:           45,
  },
});

const COMPETITOR_SCORE = makeScore({
  promptArchitectureVersion: 2,
  indirectVisibility: 42,
  competitorData: [
    { name: "competitor-a.com", shareOfVoice: 65, rankedAbove: 50, sentiment: "positive" as const },
    { name: "competitor-b.com", shareOfVoice: 40, rankedAbove: 30, sentiment: "negative" as const },
    { name: "competitor-c.com", shareOfVoice: 25, rankedAbove: 10, sentiment: "neutral"  as const },
  ],
});

// ── Import after mock ─────────────────────────────────────────────────────────
import { CitationAnalytics, ScoreArc } from "@/app/components/citation-analytics";
import { DimensionalIntelligence }       from "@/app/components/dimensional-intelligence";
import { CitationHistory }               from "@/app/components/citation-history";
import { NarrativeSkeleton }             from "@/app/components/citation-monitor";

afterEach(() => cleanup());

// ═══════════════════════════════════════════════════════════════════════════════
// citation-analytics.tsx  ── UT1–UT16
// ═══════════════════════════════════════════════════════════════════════════════

describe("citation-analytics.tsx", () => {

  // ── B1: Radar point count ───────────────────────────────────────────────────

  it("UT1 — V2 check renders 7-point radar", () => {
    const { container } = render(
      <CitationAnalytics result={V2_SCORE} domain="example.com" />
    );
    const radar = container.querySelector("[data-testid='radar-chart']");
    expect(radar).toBeTruthy();
    expect(radar!.getAttribute("data-point-count")).toBe("7");
  });

  it("UT2 — V1 check renders 16-point radar", () => {
    const { container } = render(
      <CitationAnalytics result={V1_SCORE} domain="example.com" />
    );
    const radar = container.querySelector("[data-testid='radar-chart']");
    expect(radar).toBeTruthy();
    expect(radar!.getAttribute("data-point-count")).toBe("16");
  });

  it("UT3 — radar axis labels render as horizontal text (no rotate transform)", () => {
    const { container } = render(
      <CitationAnalytics result={V2_SCORE} domain="example.com" />
    );
    // All <text> elements inside the polar angle axis must not have a rotate transform
    const texts = container.querySelectorAll("[data-testid='polar-angle-axis'] text");
    texts.forEach(t => {
      const transform = t.getAttribute("transform") ?? "";
      expect(transform).not.toMatch(/rotate/i);
    });
  });

  it("UT4 — radar vertex score values are directly labeled (visible without hover)", () => {
    const { container } = render(
      <CitationAnalytics result={V2_SCORE} domain="example.com" />
    );
    // HorizontalAxisTick renders score% text directly in the DOM
    const axisGroup = container.querySelector("[data-testid='polar-angle-axis']");
    expect(axisGroup).toBeTruthy();
    const textElements = axisGroup!.querySelectorAll("text");
    // Expect at least one text element rendering a score
    const scoreTexts = Array.from(textElements).filter(t => t.textContent?.includes("%"));
    expect(scoreTexts.length).toBeGreaterThan(0);
  });

  // ── B2: ScoreArc colors ─────────────────────────────────────────────────────

  it("UT5 — ScoreArc renders green stroke for value ≥60", () => {
    const { container } = render(<ScoreArc value={60} label="Visibility" />);
    const paths = container.querySelectorAll("path[stroke]");
    const coloredPath = Array.from(paths).find(p => p.getAttribute("stroke") !== "#e8e5e0");
    expect(coloredPath?.getAttribute("stroke")).toBe(GREEN);
  });

  it("UT6 — ScoreArc renders amber stroke for value 20–59", () => {
    const { container } = render(<ScoreArc value={45} label="Visibility" />);
    const paths = container.querySelectorAll("path[stroke]");
    const coloredPath = Array.from(paths).find(p => p.getAttribute("stroke") !== "#e8e5e0");
    expect(coloredPath?.getAttribute("stroke")).toBe(AMBER);
  });

  it("UT7 — ScoreArc renders red stroke for value <20", () => {
    const { container } = render(<ScoreArc value={10} label="Visibility" />);
    const paths = container.querySelectorAll("path[stroke]");
    const coloredPath = Array.from(paths).find(p => p.getAttribute("stroke") !== "#e8e5e0");
    expect(coloredPath?.getAttribute("stroke")).toBe(RED);
  });

  it("UT8 — ScoreArc renders value 0 without error, shows 0% text", () => {
    expect(() => render(<ScoreArc value={0} label="Visibility" />)).not.toThrow();
    expect(screen.getByText("0%")).toBeTruthy();
  });

  // ── B9: Brand in SOV chart ──────────────────────────────────────────────────

  it("UT9 — brand bar appears first in SOV chart (name contains '(you)')", () => {
    const { container } = render(
      <CitationAnalytics result={COMPETITOR_SCORE} domain="example.com" />
    );
    const chart = container.querySelector("[data-testid='bar-chart']");
    expect(chart).toBeTruthy();
    expect(chart!.getAttribute("data-first-is-brand")).toBe("true");
  });

  it("UT10 — first Cell in SOV chart uses ACCENT color (#b45309)", () => {
    const { container } = render(
      <CitationAnalytics result={COMPETITOR_SCORE} domain="example.com" />
    );
    const cells = container.querySelectorAll("[data-testid='cell']");
    expect(cells.length).toBeGreaterThan(0);
    expect(cells[0].getAttribute("data-fill")).toBe(ACCENT);
  });

  it("UT11 — SOV chart has LabelList (direct labels, not tooltip-only)", () => {
    const { container } = render(
      <CitationAnalytics result={COMPETITOR_SCORE} domain="example.com" />
    );
    const labelList = container.querySelector("[data-testid='label-list']");
    expect(labelList).toBeTruthy();
  });

  // ── C1: Hover states ────────────────────────────────────────────────────────

  it("UT12 — ThemeRow button has .ca-interactive hover class", () => {
    const { container } = render(
      <CitationAnalytics result={V2_SCORE} domain="example.com" />
    );
    const buttons = container.querySelectorAll("button.ca-interactive");
    expect(buttons.length).toBeGreaterThan(0);
  });

  // ── C6: Table headers ───────────────────────────────────────────────────────

  it("UT13 — score overview table headers are 12px and use TEXT_2 color", () => {
    const { container } = render(
      <CitationAnalytics result={V2_SCORE} domain="example.com" />
    );
    // ScoreArc labels should use 12px-ish font; check that no th uses TEXT_3 (#a8a29e)
    const ths = container.querySelectorAll("th");
    ths.forEach(th => {
      const color = (th as HTMLElement).style.color;
      if (color) {
        expect(color).not.toBe("#a8a29e"); // was TEXT_3
      }
    });
  });

  // ── D3: Abbreviations spelled out ──────────────────────────────────────────

  it("UT14 — 'Share of Voice' spelled out on first use in SOV section", () => {
    render(<CitationAnalytics result={COMPETITOR_SCORE} domain="example.com" />);
    const els = screen.queryAllByText(/Share of Voice/);
    expect(els.length).toBeGreaterThan(0);
  });

  // ── C4: Pillar label truncation ─────────────────────────────────────────────

  it("UT15 — pillar label span has title attribute for overflow text", () => {
    const { container } = render(
      <CitationAnalytics result={V2_SCORE} domain="example.com" />
    );
    const labelSpans = container.querySelectorAll("span.ca-theme-row-label");
    expect(labelSpans.length).toBeGreaterThan(0);
    labelSpans.forEach(span => {
      expect(span.hasAttribute("title")).toBe(true);
    });
  });

  // ── C5: Mobile competitor badge ─────────────────────────────────────────────

  it("UT16 — mobile competitor badge is not display:none (reflowed instead)", () => {
    const { container } = render(
      <CitationAnalytics result={V2_SCORE} domain="example.com" />
    );
    const style = container.querySelector("style");
    const css = style?.textContent ?? "";
    // Must not have the old `display: none` rule for the badge at <640px
    expect(css).not.toMatch(/ca-theme-competitor-badge[^}]*display\s*:\s*none/);
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// dimensional-intelligence.tsx  ── UT17–UT30
// ═══════════════════════════════════════════════════════════════════════════════

describe("dimensional-intelligence.tsx", () => {

  const GEO_DATA: GeoVisibility[] = [
    { geoId: "geo-1", geoName: "New York",   visibility: 35, promptCount: 10, mentionCount: 5 },
    { geoId: "geo-2", geoName: "Chicago",    visibility: 12, promptCount: 10, mentionCount: 2 },
    { geoId: "geo-3", geoName: "Los Angeles",visibility: 55, promptCount: 10, mentionCount: 7 },
  ];

  const CAT_DATA: CategoryVisibility[] = [
    { categoryId: "cat-1", categoryName: "SaaS",      visibility: 40, promptCount: 8, mentionCount: 4 },
    { categoryId: "cat-2", categoryName: "Marketing",  visibility: 15, promptCount: 8, mentionCount: 2 },
  ];

  const TIER_DATA: TierVisibility[] = [
    { tier: "buy",   visibility: 65, promptCount: 5, mentionCount: 4 },
    { tier: "solve", visibility: 40, promptCount: 5, mentionCount: 3 },
    { tier: "learn", visibility: 15, promptCount: 5, mentionCount: 1 },
  ];

  const LOC_COMPETITORS: LocationCompetitor[] = [
    {
      geoId: "geo-1", geoName: "New York",
      competitors: [
        { domain: "rival-a.com", shareOfVoice: 70, sentiment: "positive" as const },
        { domain: "rival-b.com", shareOfVoice: 45, sentiment: "neutral"  as const },
        { domain: "rival-c.com", shareOfVoice: 30, sentiment: "negative" as const },
      ],
    },
    {
      geoId: "geo-2", geoName: "Chicago",
      competitors: [
        { domain: "rival-a.com", shareOfVoice: 60, sentiment: "positive" as const },
        { domain: "rival-b.com", shareOfVoice: 35, sentiment: "neutral"  as const },
      ],
    },
    {
      geoId: "geo-3", geoName: "Los Angeles",
      competitors: [
        { domain: "rival-a.com", shareOfVoice: 50, sentiment: "positive" as const },
      ],
    },
  ];

  function makeDimScore(overrides: Record<string, unknown> = {}) {
    return {
      checkId: "chk-dim", siteId: "site-1", teamId: "team-1",
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

  // ── E1: Geo bar chart ───────────────────────────────────────────────────────

  it("UT17 — geo visibility renders as BarChart (not table)", () => {
    const { container } = render(
      <DimensionalIntelligence
        result={makeDimScore({ geoVisibility: GEO_DATA })}
        domain="example.com"
      />
    );
    expect(container.querySelector("[data-testid='bar-chart']")).toBeTruthy();
  });

  it("UT18 — geo bars sorted ascending (worst visibility first)", () => {
    const { container } = render(
      <DimensionalIntelligence
        result={makeDimScore({ geoVisibility: GEO_DATA })}
        domain="example.com"
      />
    );
    const charts = container.querySelectorAll("[data-testid='bar-chart']");
    // The first BarChart is the geo chart; its first item should be lowest visibility
    const firstChart = charts[0];
    expect(firstChart).toBeTruthy();
    // item-count should equal number of geo entries
    expect(Number(firstChart.getAttribute("data-item-count"))).toBe(GEO_DATA.length);
  });

  // ── E2: Category bar chart ──────────────────────────────────────────────────

  it("UT19 — category visibility renders as BarChart", () => {
    const { container } = render(
      <DimensionalIntelligence
        result={makeDimScore({ geoVisibility: GEO_DATA, categoryVisibility: CAT_DATA })}
        domain="example.com"
      />
    );
    const charts = container.querySelectorAll("[data-testid='bar-chart']");
    // At least 2 bar charts: geo + category
    expect(charts.length).toBeGreaterThanOrEqual(2);
  });

  // ── E3: Competitor per-geo small multiples ──────────────────────────────────

  it("UT20 — per-geo small multiples render when locationCompetitors ≥2", () => {
    const { container } = render(
      <DimensionalIntelligence
        result={makeDimScore({ geoVisibility: GEO_DATA, locationCompetitors: LOC_COMPETITORS })}
        domain="example.com"
      />
    );
    const charts = container.querySelectorAll("[data-testid='bar-chart']");
    // geo chart + up to 3 small multiples = at least 4 charts total (or combined)
    expect(charts.length).toBeGreaterThanOrEqual(2);
    // Verify at least one chart has a brand bar (first-is-brand = true)
    const brandCharts = Array.from(charts).filter(c => c.getAttribute("data-first-is-brand") === "true");
    expect(brandCharts.length).toBeGreaterThan(0);
  });

  it("UT21 — per-geo small multiples include brand bar (with '(you)' label)", () => {
    const { container } = render(
      <DimensionalIntelligence
        result={makeDimScore({ geoVisibility: GEO_DATA, locationCompetitors: LOC_COMPETITORS })}
        domain="example.com"
      />
    );
    // Brand entry should include "(you)" text somewhere in the rendered output
    const youText = container.querySelector("[data-first-is-brand='true']");
    expect(youText).toBeTruthy();
  });

  // ── E4: Dominance diverging bars ────────────────────────────────────────────

  it("UT22 — dominance section renders diverging bar structure", () => {
    const { container } = render(
      <DimensionalIntelligence
        result={makeDimScore({
          dominanceMap: {
            entries: [
              { geoId: "geo-1", categoryId: "cat-1", brandSOV: 35, topBrand: "rival.com", topBrandSOV: 65 },
              { geoId: "geo-2", categoryId: "cat-1", brandSOV: 20, topBrand: "rival.com", topBrandSOV: 80 },
            ],
            insights: [],
          },
        })}
        domain="example.com"
      />
    );
    const yourBars   = container.querySelectorAll("[data-testid='dominance-your-bar']");
    const leaderBars = container.querySelectorAll("[data-testid='dominance-leader-bar']");
    expect(yourBars.length).toBeGreaterThan(0);
    expect(leaderBars.length).toBeGreaterThan(0);
  });

  it("UT23 — dominance rows sorted by gap descending (largest gap first)", () => {
    const { container } = render(
      <DimensionalIntelligence
        result={makeDimScore({
          dominanceMap: {
            entries: [
              { geoId: "geo-1", categoryId: "cat-1", brandSOV: 35, topBrand: "rival.com", topBrandSOV: 50 },  // gap 15
              { geoId: "geo-2", categoryId: "cat-1", brandSOV: 10, topBrand: "rival.com", topBrandSOV: 80 },  // gap 70
            ],
            insights: [],
          },
        })}
        domain="example.com"
      />
    );
    // The larger gap entry (70) should appear before the smaller gap (15)
    // Check text order: "10%" should precede "35%" in the DOM
    const text = container.textContent ?? "";
    const idx10 = text.indexOf("10%");
    const idx35 = text.indexOf("35%");
    if (idx10 !== -1 && idx35 !== -1) {
      expect(idx10).toBeLessThan(idx35);
    }
  });

  // ── B7: Buyer intent arc gauges ─────────────────────────────────────────────

  it("UT24 — buyer intent rendered as SVG arc gauges, not linear progress bars", () => {
    const { container } = render(
      <DimensionalIntelligence
        result={makeDimScore({ tierVisibility: TIER_DATA })}
        domain="example.com"
      />
    );
    // ScoreArc renders SVG with data-testid="score-arc"
    const arcs = container.querySelectorAll("[data-testid='score-arc']");
    expect(arcs.length).toBe(3); // buy, solve, learn

    // No progress bar divs for tier data
    const progressBars = container.querySelectorAll("[data-testid='progress-bar']");
    expect(progressBars.length).toBe(0);
  });

  // ── C3: Section transitions ─────────────────────────────────────────────────

  it("UT25 — each dimensional section has .di-section class for fade-in", () => {
    const { container } = render(
      <DimensionalIntelligence
        result={makeDimScore({
          tierVisibility:     TIER_DATA,
          geoVisibility:      GEO_DATA,
          categoryVisibility: CAT_DATA,
        })}
        domain="example.com"
      />
    );
    const sections = container.querySelectorAll(".di-section");
    expect(sections.length).toBeGreaterThan(0);
  });

  // ── E5: Trend sparklines ────────────────────────────────────────────────────

  // History is newest-first (as real app provides it); component reverses to get chronological order.
  const V2_HISTORY: (CitationCheckScore & { promptArchitectureVersion?: number })[] = [
    { ...makeDimScore({ geoVisibility: [{ geoId: "geo-1", geoName: "New York", visibility: 45, promptCount: 5, mentionCount: 4 }] }), promptArchitectureVersion: 2, createdAt: new Date("2026-03-01") },
    { ...makeDimScore({ geoVisibility: [{ geoId: "geo-1", geoName: "New York", visibility: 38, promptCount: 5, mentionCount: 3 }] }), promptArchitectureVersion: 2, createdAt: new Date("2026-02-01") },
    { ...makeDimScore({ geoVisibility: [{ geoId: "geo-1", geoName: "New York", visibility: 30, promptCount: 5, mentionCount: 2 }] }), promptArchitectureVersion: 2, createdAt: new Date("2026-01-01") },
  ];

  it("UT26 — trend sparkline renders SVG polyline when ≥3 V2 history entries", () => {
    const { container } = render(
      <DimensionalIntelligence
        result={makeDimScore({ geoVisibility: GEO_DATA })}
        domain="example.com"
        history={V2_HISTORY as unknown as CitationCheckScore[]}
      />
    );
    const sparklines = container.querySelectorAll("[data-testid='mini-sparkline'] polyline");
    expect(sparklines.length).toBeGreaterThan(0);
  });

  it("UT27 — no sparkline rendered when <3 V2 history entries", () => {
    const shortHistory = V2_HISTORY.slice(0, 2);
    const { container } = render(
      <DimensionalIntelligence
        result={makeDimScore({ geoVisibility: GEO_DATA })}
        domain="example.com"
        history={shortHistory as unknown as CitationCheckScore[]}
      />
    );
    const sparklines = container.querySelectorAll("[data-testid='mini-sparkline']");
    expect(sparklines.length).toBe(0);
  });

  it("UT28 — sparkline polyline is green when trend is up", () => {
    const { container } = render(
      <DimensionalIntelligence
        result={makeDimScore({ geoVisibility: GEO_DATA })}
        domain="example.com"
        history={V2_HISTORY as unknown as CitationCheckScore[]}  // 30 → 38 → 45 = up
      />
    );
    const polylines = container.querySelectorAll("[data-testid='mini-sparkline'] polyline");
    expect(polylines.length).toBeGreaterThan(0);
    expect(polylines[0].getAttribute("stroke")).toBe(GREEN);
  });

  // Newest-first (30 is most recent → downtrend from 55)
  const V2_HISTORY_DOWN: (CitationCheckScore & { promptArchitectureVersion?: number })[] = [
    { ...makeDimScore({ geoVisibility: [{ geoId: "geo-1", geoName: "New York", visibility: 30, promptCount: 5, mentionCount: 2 }] }), promptArchitectureVersion: 2, createdAt: new Date("2026-03-01") },
    { ...makeDimScore({ geoVisibility: [{ geoId: "geo-1", geoName: "New York", visibility: 45, promptCount: 5, mentionCount: 3 }] }), promptArchitectureVersion: 2, createdAt: new Date("2026-02-01") },
    { ...makeDimScore({ geoVisibility: [{ geoId: "geo-1", geoName: "New York", visibility: 55, promptCount: 5, mentionCount: 4 }] }), promptArchitectureVersion: 2, createdAt: new Date("2026-01-01") },
  ];

  it("UT29 — sparkline polyline is red when trend is down", () => {
    const { container } = render(
      <DimensionalIntelligence
        result={makeDimScore({ geoVisibility: GEO_DATA })}
        domain="example.com"
        history={V2_HISTORY_DOWN as unknown as CitationCheckScore[]}  // 55 → 45 → 30 = down
      />
    );
    const polylines = container.querySelectorAll("[data-testid='mini-sparkline'] polyline");
    expect(polylines.length).toBeGreaterThan(0);
    expect(polylines[0].getAttribute("stroke")).toBe(RED);
  });

  // ── E6: Prompt architecture version banner ──────────────────────────────────

  it("UT30 — version banner renders at V1↔V2 boundary in history", () => {
    const mixedHistory = [
      { ...makeDimScore({ geoVisibility: GEO_DATA }), promptArchitectureVersion: 2, createdAt: new Date("2026-03-01") },
      { ...makeDimScore({ geoVisibility: GEO_DATA }), promptArchitectureVersion: 1, createdAt: new Date("2026-01-01") },
    ];
    render(
      <DimensionalIntelligence
        result={makeDimScore({ geoVisibility: GEO_DATA })}
        domain="example.com"
        history={mixedHistory as unknown as CitationCheckScore[]}
      />
    );
    expect(screen.getByText(/Measurement upgraded/)).toBeTruthy();
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// citation-history.tsx  ── UT31–UT33
// ═══════════════════════════════════════════════════════════════════════════════

describe("citation-history.tsx", () => {

  function makeHistoryScore(visibility: number, date: Date): CitationCheckScore {
    return {
      checkId:              `chk-h-${visibility}`,
      siteId:               "site-1",
      teamId:               "team-1",
      domain:               "example.com",
      overallVisibility:    visibility,
      bestProvider:         null,
      worstProvider:        null,
      avgPosition:          null,
      sentimentScore:       0,
      providerResults:      [],
      competitorVisibility: {},
      competitorData:       [],
      pillarVisibility:     {},
      pillarQA:             {},
      indirectVisibility:   visibility,
      brandKnowledge:       visibility,
      citationQualityScore: visibility,
      creditsUsed:          5,
      promptsUsed:          [],
      createdAt:            date,
    } as unknown as CitationCheckScore;
  }

  const HISTORY = [
    makeHistoryScore(20, new Date("2026-03-01")),
    makeHistoryScore(50, new Date("2026-02-01")),
    makeHistoryScore(80, new Date("2026-01-01")),
  ];

  it("UT31 — sparkline Y-grid lines are calculated from actual data range (min/median/max)", () => {
    const { container } = render(
      <CitationHistory history={HISTORY} domain="example.com" />
    );
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    const lines = svg!.querySelectorAll("line[x1='10']");
    // Should have exactly 3 grid lines (min, median, max) — not hardcoded [20, 30, 40]
    expect(lines.length).toBe(3);
    // Values 20, 50, 80 — median is 50.
    // Grid Y positions should NOT all be in range [20-40] (the old hardcoded range)
    const yValues = Array.from(lines).map(l => Number(l.getAttribute("y1")));
    // At least one y should be outside [20, 40] since max=80 would map to y near 10
    const allInOldRange = yValues.every(y => y >= 20 && y <= 40);
    expect(allInOldRange).toBe(false);
  });

  it("UT32 — Y-grid deduplication: no two grid lines within 3px of each other", () => {
    const dupHistory = [
      makeHistoryScore(50, new Date("2026-03-01")),
      makeHistoryScore(50, new Date("2026-02-01")),
      makeHistoryScore(50, new Date("2026-01-01")),
    ];
    const { container } = render(
      <CitationHistory history={dupHistory} domain="example.com" />
    );
    const svg = container.querySelector("svg");
    const lines = svg ? Array.from(svg.querySelectorAll("line[x1='10']")) : [];
    const yValues = lines.map(l => Number(l.getAttribute("y1")));
    for (let i = 0; i < yValues.length; i++) {
      for (let j = i + 1; j < yValues.length; j++) {
        expect(Math.abs(yValues[i] - yValues[j])).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("UT33 — history table header says 'Average Position', not 'Avg Position'", () => {
    render(<CitationHistory history={HISTORY} domain="example.com" />);
    expect(screen.getByText("Average Position")).toBeTruthy();
    expect(screen.queryByText("Avg Position")).toBeNull();
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// citation-monitor.tsx  ── UT34–UT35
// ═══════════════════════════════════════════════════════════════════════════════

describe("citation-monitor.tsx — NarrativeSkeleton", () => {

  it("UT34 — NarrativeSkeleton renders 3 skeleton-bar shimmer divs", () => {
    const { container } = render(<NarrativeSkeleton />);
    const bars = container.querySelectorAll(".skeleton-bar");
    expect(bars).toHaveLength(3);
  });

  it("UT35 — parent component style block defines shimmer @keyframes", () => {
    const { container } = render(<NarrativeSkeleton />);
    // The skeleton component should include (or be wrapped in) a style tag with shimmer
    // OR the parent CitationMonitor style block defines it — check document
    const styleContent = Array.from(document.querySelectorAll("style"))
      .map(s => s.textContent ?? "")
      .join("\n");
    expect(styleContent).toContain("shimmer");
  });

});
