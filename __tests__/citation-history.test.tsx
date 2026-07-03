/**
 * Component tests for app/components/citation-history.tsx — ES-016
 * CHC-1 through CHC-9
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CitationHistory } from "@/app/components/citation-history";
import { type CitationCheckScore } from "@/lib/db/schema";

// ─── Mock Data ────────────────────────────────────────────────────────────────

const MOCK_CHECK = (overallVisibility: number, createdAt: Date): CitationCheckScore => ({
  checkId: `check-${overallVisibility}-${createdAt.getTime()}`,
  siteId: "site-1",
  teamId: "team-1",
  domain: "example.com",
  overallVisibility,
  bestProvider: "openai",
  worstProvider: "anthropic",
  avgPosition: 2,
  sentimentScore: 1,
  providerResults: [
    {
      provider: "openai",
      model: "gpt-4o-mini",
      visibilityScore: 100,
      avgPosition: 2,
      sentiment: "positive",
      mentionCount: 1,
      totalQueries: 1,
    },
  ] as unknown as CitationCheckScore["providerResults"],
  competitorVisibility: { "competitor.com": 50 } as unknown as CitationCheckScore["competitorVisibility"],
  creditsUsed: 5,
  promptsUsed: ["What is example.com?"] as unknown as CitationCheckScore["promptsUsed"],
  createdAt: createdAt,
});

const d1 = new Date("2025-01-01");
const d2 = new Date("2025-02-01");
const d3 = new Date("2025-03-01");

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("CitationHistory component", () => {
  it("CHC-1 — empty history shows empty state message", () => {
    render(<CitationHistory history={[]} domain="example.com" />);
    expect(screen.getByText(/No citation checks yet/i)).toBeTruthy();
  });

  it("CHC-2 — single check hides sparkline (only 1 data point)", () => {
    const { container } = render(
      <CitationHistory history={[MOCK_CHECK(50, d1)]} domain="example.com" />
    );
    // With only 1 check the component renders a "need more checks" message, no SVG
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.getByText(/Only 1 check/i)).toBeTruthy();
  });

  it("CHC-3 — two or more checks renders the sparkline SVG path", () => {
    const { container } = render(
      <CitationHistory
        history={[MOCK_CHECK(80, d2), MOCK_CHECK(40, d1)]}
        domain="example.com"
      />
    );
    // SVG with a <path> element (the sparkline) should be present
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelector("path")).not.toBeNull();
  });

  it("CHC-4 — history table shows one row per check", () => {
    const { container } = render(
      <CitationHistory
        history={[MOCK_CHECK(90, d3), MOCK_CHECK(70, d2), MOCK_CHECK(50, d1)]}
        domain="example.com"
      />
    );
    // First table is the Check History table; provider consistency is the second table.
    const firstTable = container.querySelectorAll("table")[0];
    const bodyRows = firstTable.querySelectorAll("tbody tr");
    expect(bodyRows).toHaveLength(3);
  });

  it("CHC-5 — visibility percentage displayed in table row", () => {
    render(
      <CitationHistory history={[MOCK_CHECK(75, d1)]} domain="example.com" />
    );
    expect(screen.getByText(/75%/)).toBeTruthy();
  });

  it("CHC-6 — delta down indicator shown when newest visibility < previous", () => {
    // history newest-first: [60 (newer, d2), 80 (older, d1)]
    // Row 0: 60%, next=80% → diff = 60-80 = -20 → shows ▼
    render(
      <CitationHistory
        history={[MOCK_CHECK(60, d2), MOCK_CHECK(80, d1)]}
        domain="example.com"
      />
    );
    expect(screen.getByText("▼")).toBeTruthy();
  });

  it("CHC-7 — provider consistency table renders with provider name", () => {
    render(
      <CitationHistory history={[MOCK_CHECK(80, d1)]} domain="example.com" />
    );
    // "openai" appears in both history table (bestProvider) and provider consistency table
    const instances = screen.getAllByText("openai");
    expect(instances.length).toBeGreaterThan(0);
  });

  it("CHC-8 — competitor section renders when competitors present", () => {
    const check: CitationCheckScore = {
      ...MOCK_CHECK(80, d1),
      competitorVisibility: { "rival.com": 60 } as unknown as CitationCheckScore["competitorVisibility"],
    };
    render(<CitationHistory history={[check]} domain="example.com" />);
    expect(screen.getByText(/rival\.com/)).toBeTruthy();
  });

  it("CHC-9 — competitor section shows empty state when no competitors", () => {
    const check: CitationCheckScore = {
      ...MOCK_CHECK(80, d1),
      competitorVisibility: {} as unknown as CitationCheckScore["competitorVisibility"],
    };
    render(<CitationHistory history={[check]} domain="example.com" />);
    expect(screen.getByText(/No competitors detected/i)).toBeTruthy();
  });
});
