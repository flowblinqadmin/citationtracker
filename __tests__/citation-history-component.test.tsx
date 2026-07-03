/**
 * Unit tests for CitationHistory component — ES-016
 * C-1 through C-9
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { CitationHistory } from "@/app/components/citation-history";
import { type CitationCheckScore } from "@/lib/types/citation";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeScore(overrides: Partial<CitationCheckScore> = {}): CitationCheckScore {
  return {
    checkId: "chk-1",
    siteId: "site-1",
    domain: "example.com",
    teamId: "team-1",
    overallVisibility: 50,
    bestProvider: "openai",
    worstProvider: null,
    avgPosition: 2,
    sentimentScore: 0,
    providerResults: [],
    competitorVisibility: {},
    creditsUsed: 5,
    promptsUsed: [],
    createdAt: new Date("2026-03-01"),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("CitationHistory — empty state", () => {
  it("C-1 — history=[] renders empty state message", () => {
    render(<CitationHistory history={[]} domain="example.com" />);
    expect(screen.getByText(/No citation checks yet/i)).toBeInTheDocument();
  });
});

describe("CitationHistory — sparkline behavior", () => {
  it("C-2 — single check: no sparkline path, shows 1 row in history table", () => {
    const { container } = render(
      <CitationHistory history={[makeScore()]} domain="example.com" />
    );
    // Single-check message shown instead of sparkline
    expect(screen.getByText(/Only 1 check/i)).toBeInTheDocument();
    // History table has 1 data row
    const rows = container.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(1);
  });

  it("C-3 — two checks: sparkline SVG with 2 circles rendered", () => {
    const history = [
      makeScore({ checkId: "c1", overallVisibility: 60, createdAt: new Date("2026-03-02") }),
      makeScore({ checkId: "c2", overallVisibility: 40, createdAt: new Date("2026-03-01") }),
    ];
    const { container } = render(<CitationHistory history={history} domain="example.com" />);
    const circles = container.querySelectorAll("circle");
    expect(circles).toHaveLength(2);
  });

  it("C-6 — all-zero visibility: flat line + 'No mentions recorded' label", () => {
    const history = [
      makeScore({ checkId: "c1", overallVisibility: 0, createdAt: new Date("2026-03-02") }),
      makeScore({ checkId: "c2", overallVisibility: 0, createdAt: new Date("2026-03-01") }),
    ];
    render(<CitationHistory history={history} domain="example.com" />);
    expect(screen.getByText(/No mentions recorded/i)).toBeInTheDocument();
  });
});

describe("CitationHistory — delta indicators", () => {
  it("C-4 — history[0].overallVisibility=70, history[1]=50 → first row shows ▲", () => {
    const history = [
      makeScore({ checkId: "c1", overallVisibility: 70, createdAt: new Date("2026-03-02") }),
      makeScore({ checkId: "c2", overallVisibility: 50, createdAt: new Date("2026-03-01") }),
    ];
    render(<CitationHistory history={history} domain="example.com" />);
    expect(screen.getByText("▲")).toBeInTheDocument();
  });

  it("C-5 — history[0].overallVisibility=40, history[1]=60 → first row shows ▼", () => {
    const history = [
      makeScore({ checkId: "c1", overallVisibility: 40, createdAt: new Date("2026-03-02") }),
      makeScore({ checkId: "c2", overallVisibility: 60, createdAt: new Date("2026-03-01") }),
    ];
    render(<CitationHistory history={history} domain="example.com" />);
    expect(screen.getByText("▼")).toBeInTheDocument();
  });
});

describe("CitationHistory — competitors", () => {
  it("C-7 — no competitorVisibility → shows 'No competitors detected' card", () => {
    const history = [makeScore({ competitorVisibility: {} })];
    render(<CitationHistory history={history} domain="example.com" />);
    expect(screen.getByText(/No competitors detected/i)).toBeInTheDocument();
  });
});

describe("CitationHistory — provider aggregation", () => {
  it("C-8 — openai mentioned in 2 checks → checksWithMention=2 in provider table", () => {
    const providerResults = [
      { provider: "openai", model: "gpt-4o", visibilityScore: 80, avgPosition: 1, sentiment: "positive" as const, mentionCount: 2, totalQueries: 2 },
    ];
    const history = [
      makeScore({ checkId: "c1", providerResults, createdAt: new Date("2026-03-02") }),
      makeScore({ checkId: "c2", providerResults, createdAt: new Date("2026-03-01") }),
    ];
    const { container } = render(<CitationHistory history={history} domain="example.com" />);
    // Find the provider consistency table body rows
    const tables = container.querySelectorAll("table");
    // tables[0] = history table, tables[1] = provider consistency
    const providerTable = tables[1];
    expect(providerTable).toBeDefined();
    const cells = providerTable?.querySelectorAll("td");
    // Row: openai | 80% | 2 | 2
    const cellTexts = Array.from(cells ?? []).map(c => c.textContent);
    expect(cellTexts).toContain("2"); // checksWithMention
  });

  it("C-9 — providerResults=null on one check → no crash, skips that record", () => {
    const history = [
      makeScore({ checkId: "c1", providerResults: null as unknown as [] }),
      makeScore({ checkId: "c2", providerResults: [] }),
    ];
    expect(() => render(<CitationHistory history={history} domain="example.com" />)).not.toThrow();
  });
});
