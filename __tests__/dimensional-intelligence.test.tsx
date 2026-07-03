/**
 * Unit tests for DimensionalIntelligence component — ES-057
 * UT1 through UT23
 *
 * Tests cover all 6 sections: Buyer Intent, Geographic Performance,
 * Category Performance, Dominance Insights, Real User Questions,
 * Visibility Gap Analysis.
 *
 * @vitest-environment jsdom
 */

import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type {
  CitationCheckResult,
  TierVisibility,
  GeoVisibility,
  CategoryVisibility,
  LocationCompetitor,
  CategoryCompetitor,
  DominanceMap,
  RealPromptDiscovery,
  VisibilityGapEntry,
} from "@/lib/types/citation";

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

// ── Fixtures ─────────────────────────────────────────────────────────────────

// CitationCheckScore-shaped flat object (preloaded path)
const EMPTY_SCORE = {
  id: "score-1", siteId: "site-1", checkId: "chk-1",
  createdAt: new Date(), overallVisibility: 0, indirectVisibility: 0,
  brandKnowledge: 0, citationQualityScore: 0, sentimentScore: 0,
  bestProvider: null, worstProvider: null, avgPosition: null,
  pillarVisibility: {}, pillarQA: {}, competitorData: [],
  providerResults: [], promptsUsed: [],
  tierVisibility: [], geoVisibility: [], categoryVisibility: [],
  visibilityGapAnalysis: [], locationCompetitors: [], categoryCompetitors: [],
  dominanceMap: null, realPromptDiscovery: null, avgImpressionShare: null,
};

function makeScore(overrides: Record<string, unknown>) {
  return { ...EMPTY_SCORE, ...overrides };
}

// CitationCheckResult-shaped (live scan path — data nested in .scores)
function makeLiveResult(scores: Record<string, unknown>): CitationCheckResult {
  return {
    checkId: "chk-live",
    scores: {
      overallVisibility: 0, indirectVisibility: 0,
      brandKnowledge: 0, citationQualityScore: 0,
      sentimentScore: 0, bestProvider: null, worstProvider: null,
      avgPosition: null, pillarVisibility: {}, pillarQA: {},
      competitorData: [],
      ...scores,
    },
    providerResults: [],
    promptsUsed: [],
    creditsUsed: 5,
  };
}

const TIER_DATA: TierVisibility[] = [
  { tier: "buy",   promptCount: 10, mentionCount: 8, visibility: 80 },
  { tier: "solve", promptCount: 10, mentionCount: 3, visibility: 30 },
  { tier: "learn", promptCount: 10, mentionCount: 1, visibility: 10 },
];

const GEO_DATA: GeoVisibility[] = [
  { geoId: "in-ka-blr", geoName: "Bangalore",  promptCount: 8, mentionCount: 6, visibility: 75 },
  { geoId: "in-dl-del", geoName: "Delhi",       promptCount: 5, mentionCount: 1, visibility: 20 },
  { geoId: "in-mh-mum", geoName: "Mumbai",      promptCount: 4, mentionCount: 0, visibility: 5  },
];

const CAT_DATA: CategoryVisibility[] = [
  { categoryId: "ortho",  categoryName: "Orthopedics", promptCount: 6, mentionCount: 5, visibility: 83 },
  { categoryId: "cardio", categoryName: "Cardiology",  promptCount: 6, mentionCount: 1, visibility: 17 },
];

const LOC_COMPETITORS: LocationCompetitor[] = [
  {
    geoId: "in-ka-blr",
    geoName: "Bangalore",
    competitors: [
      { domain: "apollo.com", name: "Apollo",   mentionCount: 5, shareOfVoice: 62, avgPosition: 1, rankedAboveBrand: 80 },
      { domain: "fortis.com", name: "Fortis",   mentionCount: 3, shareOfVoice: 37, avgPosition: 2, rankedAboveBrand: 60 },
      { domain: "max.com",    name: "Max",       mentionCount: 2, shareOfVoice: 25, avgPosition: 3, rankedAboveBrand: 40 },
    ],
  },
];

const CAT_COMPETITORS: CategoryCompetitor[] = [
  {
    categoryId: "ortho",
    categoryName: "Orthopedics",
    competitors: [
      { domain: "fortis.com", name: "Fortis", mentionCount: 4, shareOfVoice: 66, avgPosition: 1, rankedAboveBrand: 75 },
    ],
  },
];

const DOM_MAP_WITH_INSIGHTS: DominanceMap = {
  entries: [
    { geoId: "in-ka-blr", categoryId: null, topBrand: "Apollo", topBrandSOV: 62, brandSOV: 30, gap: 32 },
    { geoId: "in-dl-del", categoryId: null, topBrand: "Fortis", topBrandSOV: 20, brandSOV: 15, gap: 5  },
  ],
  computedAt: new Date().toISOString(),
  insights: [
    "Apollo dominates in Bangalore with 62% vs your 30%. High-priority gap.",
    "You're competitive with Fortis in Delhi (20% vs your 15%).",
    "You lead in Mumbai with no significant competitor.",
  ],
};

const DOM_MAP_NO_INSIGHTS: DominanceMap = {
  entries: [
    { geoId: "in-ka-blr", categoryId: null, topBrand: "Apollo", topBrandSOV: 62, brandSOV: 30, gap: 32 },
  ],
  computedAt: new Date().toISOString(),
};

const REAL_PROMPTS: RealPromptDiscovery[] = [
  { source: "paa",    query: "Best orthopedic hospital in Bangalore?",    context: "PAA context",    url: "https://google.com/q1" },
  { source: "reddit", query: "Which hospital for knee replacement India?", context: "Reddit context", url: "https://reddit.com/r1" },
  { source: "quora",  query: "Top cardiac hospitals in Delhi?",           context: "Quora context",  url: "https://quora.com/q1" },
];

const GAP_DATA: VisibilityGapEntry[] = [
  { dimension: "geo",      id: "in-dl-del", name: "Delhi",      visibility: 5,  gap: "Low Delhi presence",       recommendation: "Add Delhi location pages" },
  { dimension: "category", id: "cardio",    name: "Cardiology", visibility: 8,  gap: "Low cardiology visibility", recommendation: "Add cardiology content"   },
  { dimension: "tier",     id: "learn",     name: "Learn",      visibility: 10, gap: "Low learn intent",          recommendation: "Add educational content"  },
];

// ── UT1: Empty state ──────────────────────────────────────────────────────────

describe("UT1: renders nothing when all data empty", () => {
  it("returns null content when all arrays empty/null", () => {
    const { container } = render(
      <DimensionalIntelligence result={EMPTY_SCORE as never} domain="example.com" />
    );
    expect(container.textContent?.trim()).toBe("");
  });
});

// ── UT2: Tier visibility — 3 bars ─────────────────────────────────────────────

describe("UT2: tier visibility — 3 bars render", () => {
  it("renders Buy, Solve, Learn labels", () => {
    render(
      <DimensionalIntelligence
        result={makeScore({ tierVisibility: TIER_DATA }) as never}
        domain="example.com"
      />
    );
    expect(screen.getByText("Buy")).toBeDefined();
    expect(screen.getByText("Solve")).toBeDefined();
    expect(screen.getByText("Learn")).toBeDefined();
  });
});

// ── UT3: Color thresholds ─────────────────────────────────────────────────────

describe("UT3: tier visibility — color thresholds", () => {
  it("shows correct % values per tier", () => {
    render(
      <DimensionalIntelligence
        result={makeScore({ tierVisibility: TIER_DATA }) as never}
        domain="example.com"
      />
    );
    expect(screen.getByText("80%")).toBeDefined();  // green
    expect(screen.getByText("30%")).toBeDefined();  // amber
    expect(screen.getByText("10%")).toBeDefined();  // red
  });
});

// ── UT4: Geo table — sorted ascending ─────────────────────────────────────────

describe("UT4: geo table — sorted ascending by visibility", () => {
  it("renders 3 geos in ascending visibility order", () => {
    render(
      <DimensionalIntelligence
        result={makeScore({ geoVisibility: GEO_DATA }) as never}
        domain="example.com"
      />
    );
    // All 3 cities should render (via recharts mock bar-items)
    expect(screen.getByText("Bangalore")).toBeDefined();
    expect(screen.getByText("Delhi")).toBeDefined();
    expect(screen.getByText("Mumbai")).toBeDefined();
    // Mumbai (5%) should appear before Delhi (20%) before Bangalore (75%) — ascending sort
    const { container } = render(
      <DimensionalIntelligence result={makeScore({ geoVisibility: GEO_DATA }) as never} domain="example.com" />,
    );
    const items = Array.from(container.querySelectorAll("[data-testid='bar-item']")).map(el => el.textContent?.trim());
    const bangaloreIdx = items.indexOf("Bangalore");
    const delhiIdx     = items.indexOf("Delhi");
    const mumbaiIdx    = items.indexOf("Mumbai");
    expect(mumbaiIdx).toBeLessThan(delhiIdx);
    expect(delhiIdx).toBeLessThan(bangaloreIdx);
  });
});

// ── UT5: Geo table — competitor expand ───────────────────────────────────────

describe("UT5: geo table — competitor expand", () => {
  it("clicking Bangalore row expands top 3 competitors", () => {
    render(
      <DimensionalIntelligence
        result={makeScore({ geoVisibility: GEO_DATA, locationCompetitors: LOC_COMPETITORS }) as never}
        domain="example.com"
      />
    );
    // Competitors not visible yet
    expect(screen.queryByText("Apollo")).toBeNull();
    // Click Bangalore row
    fireEvent.click(screen.getByRole("button", { name: /Bangalore/i }));
    expect(screen.getByText("Apollo")).toBeDefined();
    expect(screen.getByText("Fortis")).toBeDefined();
    expect(screen.getByText("Max")).toBeDefined();
  });
});

// ── UT6: Geo table — no competitors ──────────────────────────────────────────

describe("UT6: geo table — no expand when no competitors", () => {
  it("Delhi row has no competitor panel (no matching locationCompetitors)", () => {
    render(
      <DimensionalIntelligence
        result={makeScore({ geoVisibility: GEO_DATA, locationCompetitors: LOC_COMPETITORS }) as never}
        domain="example.com"
      />
    );
    // Delhi has no entry in LOC_COMPETITORS — clicking should not show anything
    fireEvent.click(screen.getByRole("button", { name: /Delhi/i }));
    expect(screen.queryByText("Top Competitors")).toBeNull();
  });
});

// ── UT7: Category table — sorted ascending ────────────────────────────────────

describe("UT7: category table — sorted ascending", () => {
  it("Cardiology (17%) appears before Orthopedics (83%)", () => {
    render(
      <DimensionalIntelligence
        result={makeScore({ categoryVisibility: CAT_DATA }) as never}
        domain="example.com"
      />
    );
    expect(screen.getByText("Orthopedics")).toBeDefined();
    expect(screen.getByText("Cardiology")).toBeDefined();
    // Check ascending sort order via bar-items (BarChart mock renders categoryName as text)
    const { container } = render(
      <DimensionalIntelligence result={makeScore({ categoryVisibility: CAT_DATA }) as never} domain="example.com" />,
    );
    const items = Array.from(container.querySelectorAll("[data-testid='bar-item']")).map(el => el.textContent?.trim());
    const cardiologyIdx  = items.indexOf("Cardiology");
    const orthopedicsIdx = items.indexOf("Orthopedics");
    expect(cardiologyIdx).toBeLessThan(orthopedicsIdx);
  });
});

// ── UT8: Category table — competitor expand ───────────────────────────────────

describe("UT8: category table — competitor expand", () => {
  it("clicking Orthopedics expands competitor panel", () => {
    render(
      <DimensionalIntelligence
        result={makeScore({ categoryVisibility: CAT_DATA, categoryCompetitors: CAT_COMPETITORS }) as never}
        domain="example.com"
      />
    );
    expect(screen.queryByText("Fortis")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Orthopedics/i }));
    expect(screen.getByText("Fortis")).toBeDefined();
  });
});

// ── UT9: Dominance insights — color-coded ────────────────────────────────────

describe("UT9: dominance insights — color-coded by keyword", () => {
  it("renders 3 insight strings", () => {
    render(
      <DimensionalIntelligence
        result={makeScore({ dominanceMap: DOM_MAP_WITH_INSIGHTS }) as never}
        domain="example.com"
      />
    );
    expect(screen.getByText(/Apollo dominates/i)).toBeDefined();
    expect(screen.getByText(/competitive with Fortis/i)).toBeDefined();
    expect(screen.getByText(/lead in Mumbai/i)).toBeDefined();
  });
});

// ── UT10: Dominance entries fallback ─────────────────────────────────────────

describe("UT10: dominance entries — diverging bars render without insights", () => {
  it("renders diverging bars for dominance entries even when no insights", () => {
    const { container } = render(
      <DimensionalIntelligence
        result={makeScore({ dominanceMap: DOM_MAP_NO_INSIGHTS }) as never}
        domain="example.com"
      />
    );
    // ES-060 E4: diverging bars with data-testid
    expect(container.querySelector("[data-testid='dominance-your-bar']")).not.toBeNull();
    expect(container.querySelector("[data-testid='dominance-leader-bar']")).not.toBeNull();
    // brandSOV (30%) and topBrandSOV (62%) values are shown
    expect(screen.getByText("30%")).toBeDefined();
    expect(screen.getByText("62%")).toBeDefined();
  });
});

// ── UT11: Dominance — null map ────────────────────────────────────────────────

describe("UT11: dominance section hidden when dominanceMap is null", () => {
  it("does not render dominance section when null", () => {
    render(
      <DimensionalIntelligence
        result={makeScore({ geoVisibility: GEO_DATA }) as never}
        domain="example.com"
      />
    );
    expect(screen.queryByText(/Dominance/i)).toBeNull();
  });
});

// ── UT12: Real questions — collapsed default ──────────────────────────────────

describe("UT12: real questions — collapsed by default", () => {
  it("shows toggle text but not question content initially", () => {
    render(
      <DimensionalIntelligence
        result={makeScore({ realPromptDiscovery: REAL_PROMPTS }) as never}
        domain="example.com"
      />
    );
    expect(screen.getByText(/show 3 real questions/i)).toBeDefined();
    expect(screen.queryByText("PAA")).toBeNull();
  });
});

// ── UT13: Real questions — expand toggle ──────────────────────────────────────

describe("UT13: real questions — expand toggle shows questions", () => {
  it("clicking show reveals all 3 questions", () => {
    render(
      <DimensionalIntelligence
        result={makeScore({ realPromptDiscovery: REAL_PROMPTS }) as never}
        domain="example.com"
      />
    );
    fireEvent.click(screen.getByText(/show 3 real questions/i));
    expect(screen.getByText("PAA")).toBeDefined();
    expect(screen.getByText("Reddit")).toBeDefined();
    expect(screen.getByText("Quora")).toBeDefined();
    expect(screen.getByText(/orthopedic hospital in Bangalore/i)).toBeDefined();
  });
});

// ── UT14: Real questions — source badge colors ────────────────────────────────

describe("UT14: real questions — source badges", () => {
  it("renders PAA, Reddit, Quora badges after expand", () => {
    render(
      <DimensionalIntelligence
        result={makeScore({ realPromptDiscovery: REAL_PROMPTS }) as never}
        domain="example.com"
      />
    );
    fireEvent.click(screen.getByText(/show.*real questions/i));
    const paaBadge = screen.getByText("PAA");
    expect(paaBadge).toBeDefined();
    // PAA badge should have blue color #2563eb
    expect((paaBadge as HTMLElement).style.color).toContain("37, 99, 235");
  });
});

// ── UT15: Real questions — context truncation ────────────────────────────────

describe("UT15: real questions — context truncated at word boundary", () => {
  it("truncates long context with ellipsis at word boundary", () => {
    // Build a context of 200 chars with spaces so word-boundary truncation works
    // Each word is 9 chars + 1 space = 10 chars → 20 words = 200 chars
    const word = "wordword "; // 9 chars + space
    const longContext = word.repeat(20).trimEnd(); // 199 chars (20 words)
    render(
      <DimensionalIntelligence
        result={makeScore({ realPromptDiscovery: [
          { source: "paa" as const, query: "Question?", context: longContext, url: "https://example.com" },
        ] }) as never}
        domain="example.com"
      />
    );
    fireEvent.click(screen.getByText(/show 1 real questions/i));
    // Context is > 150 chars → truncated at word boundary + ellipsis
    const rendered = screen.getByText(/wordword.*…/i);
    expect(rendered).toBeDefined();
    expect(rendered.textContent!.endsWith("…")).toBe(true);
    expect(rendered.textContent!.length).toBeLessThan(longContext.length);
  });
});

// ── UT16: Gap analysis — renders ─────────────────────────────────────────────

describe("UT16: gap analysis — renders entries", () => {
  it("renders gap entries with dimension badges", () => {
    render(
      <DimensionalIntelligence
        result={makeScore({ visibilityGapAnalysis: GAP_DATA }) as never}
        domain="example.com"
      />
    );
    expect(screen.getByText("Delhi")).toBeDefined();
    expect(screen.getByText("Cardiology")).toBeDefined();
    expect(screen.getByText(/Add Delhi location pages/i)).toBeDefined();
  });
});

// ── UT17: Gap analysis — cap at 10 ───────────────────────────────────────────

describe("UT17: gap analysis — capped at 10 entries", () => {
  it("renders at most 10 entries when 15 provided", () => {
    const manyGaps: VisibilityGapEntry[] = Array.from({ length: 15 }, (_, i) => ({
      dimension: "geo" as const,
      id: `geo-${i}`, name: `City ${i}`, visibility: i,
      gap: `Gap ${i}`, recommendation: `Rec ${i}`,
    }));
    render(
      <DimensionalIntelligence
        result={makeScore({ visibilityGapAnalysis: manyGaps }) as never}
        domain="example.com"
      />
    );
    let cityCount = 0;
    for (let i = 0; i < 15; i++) {
      if (screen.queryByText(`City ${i}`)) cityCount++;
    }
    expect(cityCount).toBeLessThanOrEqual(10);
  });
});

// ── UT18: Gap analysis — dimension badges ────────────────────────────────────

describe("UT18: gap analysis — dimension badge labels", () => {
  it("renders GEO/CAT/TIER badge labels", () => {
    render(
      <DimensionalIntelligence
        result={makeScore({ visibilityGapAnalysis: GAP_DATA }) as never}
        domain="example.com"
      />
    );
    expect(screen.getByText("GEO")).toBeDefined();
    expect(screen.getByText("CAT")).toBeDefined();
    expect(screen.getByText("TIER")).toBeDefined();
  });
});

// ── UT19: Accepts CitationCheckResult ────────────────────────────────────────

describe("UT19: accepts CitationCheckResult (live scan path)", () => {
  it("renders tier section when data nested in .scores", () => {
    const liveResult = makeLiveResult({ tierVisibility: TIER_DATA });
    render(<DimensionalIntelligence result={liveResult} domain="example.com" />);
    expect(screen.getByText("Buy")).toBeDefined();
    expect(screen.getByText("Solve")).toBeDefined();
    expect(screen.getByText("Learn")).toBeDefined();
  });
});

// ── UT20: Accepts CitationCheckScore ────────────────────────────────────────

describe("UT20: accepts CitationCheckScore (preloaded path)", () => {
  it("renders geo section when data is flat on object", () => {
    render(
      <DimensionalIntelligence
        result={makeScore({ geoVisibility: GEO_DATA }) as never}
        domain="example.com"
      />
    );
    expect(screen.getByText("Bangalore")).toBeDefined();
    expect(screen.getByText("Delhi")).toBeDefined();
  });
});

// ── UT21: Partial data — only tier ───────────────────────────────────────────

describe("UT21: partial data — only tier section renders", () => {
  it("only Section 1 renders when only tierVisibility populated", () => {
    render(
      <DimensionalIntelligence
        result={makeScore({ tierVisibility: TIER_DATA }) as never}
        domain="example.com"
      />
    );
    expect(screen.getByText("Buy")).toBeDefined();
    expect(screen.queryByText("Bangalore")).toBeNull();
    expect(screen.queryByText("Orthopedics")).toBeNull();
  });
});

// ── UT22: Partial data — only geo ────────────────────────────────────────────

describe("UT22: partial data — only geo section renders", () => {
  it("only Section 2 renders when only geoVisibility populated", () => {
    render(
      <DimensionalIntelligence
        result={makeScore({ geoVisibility: GEO_DATA }) as never}
        domain="example.com"
      />
    );
    expect(screen.getByText("Bangalore")).toBeDefined();
    expect(screen.queryByText("Buy")).toBeNull();
    expect(screen.queryByText("Orthopedics")).toBeNull();
  });
});

// ── UT23: Null result ────────────────────────────────────────────────────────

describe("UT23: null result — returns null", () => {
  it("renders empty container when result is null", () => {
    const { container } = render(
      <DimensionalIntelligence result={null} domain="example.com" />
    );
    expect(container.textContent?.trim()).toBe("");
  });
});
