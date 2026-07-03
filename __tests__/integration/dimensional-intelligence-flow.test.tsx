/**
 * Integration tests for DimensionalIntelligence component — ES-057
 * IT1 through IT7
 *
 * Tests SSE flow, preloaded path, backward compat, co-render with CitationAnalytics,
 * and expand/collapse state preservation.
 *
 * @vitest-environment jsdom
 */

import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { CitationCheckResult, TierVisibility, GeoVisibility } from "@/lib/types/citation";

// ── Recharts mock — renders data item labels as text for querying ─────────────
vi.mock("recharts", () => ({
  BarChart: ({ data, children }: { data?: Record<string, unknown>[]; children: React.ReactNode }) => (
    <div data-testid="bar-chart" data-item-count={data?.length ?? 0}>
      {(data ?? []).map((d, i) => (
        <div key={i} data-testid="bar-item">
          {String(d.geoName ?? d.categoryName ?? d.name ?? "")}
        </div>
      ))}
      {children}
    </div>
  ),
  Bar:                 ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  XAxis:               () => null,
  YAxis:               () => null,
  Cell:                () => null,
  LabelList:           () => null,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

afterEach(() => cleanup());

import { DimensionalIntelligence } from "@/app/components/dimensional-intelligence";

// ── Shared fixtures ───────────────────────────────────────────────────────────

const EMPTY_SCORE = {
  id: "s1", siteId: "site-1", checkId: "c1", createdAt: new Date(),
  overallVisibility: 50, indirectVisibility: 45, brandKnowledge: 60,
  citationQualityScore: 55, sentimentScore: 0.5, bestProvider: "openai",
  worstProvider: "google", avgPosition: 2, pillarVisibility: {}, pillarQA: {},
  competitorData: [], providerResults: [], promptsUsed: [],
  tierVisibility: [], geoVisibility: [], categoryVisibility: [],
  visibilityGapAnalysis: [], locationCompetitors: [], categoryCompetitors: [],
  dominanceMap: null, realPromptDiscovery: null, avgImpressionShare: null,
};

const TIER_DATA: TierVisibility[] = [
  { tier: "buy",   promptCount: 10, mentionCount: 8, visibility: 80 },
  { tier: "solve", promptCount: 10, mentionCount: 3, visibility: 30 },
  { tier: "learn", promptCount: 10, mentionCount: 1, visibility: 10 },
];

const GEO_DATA: GeoVisibility[] = [
  { geoId: "in-ka-blr", geoName: "Bangalore", promptCount: 8, mentionCount: 6, visibility: 75 },
  { geoId: "in-dl-del", geoName: "Delhi",     promptCount: 5, mentionCount: 1, visibility: 20 },
];

// ── IT1: SSE complete path includes dimensional data ──────────────────────────

describe("IT1: SSE complete path — CitationCheckResult with Tier 2-4 data", () => {
  it("renders dimensional sections from nested .scores", () => {
    const liveResult: CitationCheckResult = {
      checkId: "chk-live",
      scores: {
        overallVisibility: 50, indirectVisibility: 45,
        brandKnowledge: 60, citationQualityScore: 55,
        sentimentScore: 0.5, bestProvider: "openai", worstProvider: "google",
        avgPosition: 2, pillarVisibility: {}, pillarQA: {}, competitorData: [],
        tierVisibility: TIER_DATA,
        geoVisibility: GEO_DATA,
      },
      providerResults: [], promptsUsed: [], creditsUsed: 5,
    };
    render(<DimensionalIntelligence result={liveResult} domain="example.com" />);
    // Tier section (Section 1)
    expect(screen.getByText("Buy")).toBeDefined();
    // Geo section (Section 2)
    expect(screen.getByText("Bangalore")).toBeDefined();
  });
});

// ── IT2: Preloaded lastCheck renders dimensional data ────────────────────────

describe("IT2: preloaded CitationCheckScore path", () => {
  it("renders sections from flat CitationCheckScore fields on initial load", () => {
    const score = { ...EMPTY_SCORE, tierVisibility: TIER_DATA, geoVisibility: GEO_DATA };
    render(<DimensionalIntelligence result={score as never} domain="example.com" />);
    expect(screen.getByText("Buy")).toBeDefined();
    expect(screen.getByText("Bangalore")).toBeDefined();
  });
});

// ── IT3: Old SSE event without Tier 2-4 fields ───────────────────────────────

describe("IT3: old SSE event (no Tier 2-4 fields) — no crash", () => {
  it("renders empty container when SSE result lacks dimensional fields", () => {
    const oldResult: CitationCheckResult = {
      checkId: "chk-old",
      scores: {
        overallVisibility: 40, indirectVisibility: 35,
        brandKnowledge: 50, citationQualityScore: 45,
        sentimentScore: 0.3, bestProvider: null, worstProvider: null,
        avgPosition: null, pillarVisibility: {}, pillarQA: {}, competitorData: [],
        // No Tier 2-4 fields — old format
      },
      providerResults: [], promptsUsed: [], creditsUsed: 5,
    };
    const { container } = render(
      <DimensionalIntelligence result={oldResult} domain="example.com" />
    );
    // Sections hidden, no crash
    expect(container.textContent?.trim()).toBe("");
  });
});

// ── IT4: DimensionalIntelligence renders after CitationAnalytics ──────────────

describe("IT4: DimensionalIntelligence renders below CitationAnalytics in DOM order", () => {
  it("dimensional section heading appears in document", () => {
    // Simulating the page layout — DimensionalIntelligence placed after CitationAnalytics
    const score = { ...EMPTY_SCORE, tierVisibility: TIER_DATA };
    render(
      <div>
        <div data-testid="analytics">CitationAnalytics placeholder</div>
        <DimensionalIntelligence result={score as never} domain="example.com" />
      </div>
    );
    const analyticsEl = screen.getByTestId("analytics");
    const buyerEl = screen.getByText("Buy");
    // Both present; analytics appears before dimensional in DOM
    expect(analyticsEl).toBeDefined();
    expect(buyerEl).toBeDefined();
    const pos = analyticsEl.compareDocumentPosition(buyerEl);
    // DOCUMENT_POSITION_FOLLOWING = 4
    expect(pos & 4).toBeTruthy();
  });
});

// ── IT5: Expand/collapse state preserved across multiple rows ────────────────

describe("IT5: expand/collapse preserves independent state per row", () => {
  it("expanding geo row and category row keeps both expanded independently", () => {
    const score = {
      ...EMPTY_SCORE,
      geoVisibility: [
        { geoId: "in-ka-blr", geoName: "Bangalore", promptCount: 8, mentionCount: 6, visibility: 75 },
      ],
      locationCompetitors: [{
        geoId: "in-ka-blr", geoName: "Bangalore",
        competitors: [{ domain: "apollo.com", name: "Apollo", mentionCount: 5, shareOfVoice: 62, avgPosition: 1, rankedAboveBrand: 80 }],
      }],
      categoryVisibility: [
        { categoryId: "ortho", categoryName: "Orthopedics", promptCount: 6, mentionCount: 5, visibility: 83 },
      ],
      categoryCompetitors: [{
        categoryId: "ortho", categoryName: "Orthopedics",
        competitors: [{ domain: "fortis.com", name: "Fortis", mentionCount: 4, shareOfVoice: 66, avgPosition: 1, rankedAboveBrand: 75 }],
      }],
    };
    render(<DimensionalIntelligence result={score as never} domain="example.com" />);

    // Expand geo row
    fireEvent.click(screen.getByRole("button", { name: /Bangalore/i }));
    expect(screen.getByText("Apollo")).toBeDefined();

    // Expand category row
    fireEvent.click(screen.getByRole("button", { name: /Orthopedics/i }));
    expect(screen.getByText("Fortis")).toBeDefined();

    // Both still expanded
    expect(screen.getByText("Apollo")).toBeDefined();
    expect(screen.getByText("Fortis")).toBeDefined();
  });
});

// ── IT6: Responsive — mobile layout (class present) ─────────────────────────

describe("IT6: responsive — mobile CSS class present", () => {
  it("di-table class applied to geo table when fallback expandable is active (1 locationCompetitor)", () => {
    // 1 locationCompetitor triggers ES-057 expandable fallback which uses .di-table
    const score = {
      ...EMPTY_SCORE,
      geoVisibility: GEO_DATA,
      locationCompetitors: [{ geoId: "in-ka-blr", geoName: "Bangalore", competitors: [] }],
    };
    const { container } = render(
      <DimensionalIntelligence result={score as never} domain="example.com" />
    );
    expect(container.querySelector(".di-table")).not.toBeNull();
  });
});

// ── IT7: Responsive — desktop layout (class present) ────────────────────────

describe("IT7: responsive — di-table-row class present", () => {
  it("expandable rows have di-table-row class when fallback expandable is active (1 locationCompetitor)", () => {
    // 1 locationCompetitor triggers ES-057 expandable fallback which uses .di-table-row
    const score = {
      ...EMPTY_SCORE,
      geoVisibility: GEO_DATA,
      locationCompetitors: [{ geoId: "in-ka-blr", geoName: "Bangalore", competitors: [] }],
    };
    const { container } = render(
      <DimensionalIntelligence result={score as never} domain="example.com" />
    );
    expect(container.querySelector(".di-table-row")).not.toBeNull();
  });
});
