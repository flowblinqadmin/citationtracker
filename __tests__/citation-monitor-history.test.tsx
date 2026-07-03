/**
 * Unit tests for CitationMonitor — history tab behavior — ES-016
 * M-1 through M-4
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { CitationMonitor } from "@/app/components/citation-monitor";
import { type CitationCheckScore } from "@/lib/types/citation";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@/app/components/citation-history", () => ({
  CitationHistory: ({ history }: { history: CitationCheckScore[] }) => (
    <div data-testid="citation-history">CitationHistory:{history.length}</div>
  ),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeScore(overrides: Partial<CitationCheckScore> = {}): CitationCheckScore {
  return {
    checkId: "chk-1",
    siteId: "site-1",
    domain: "example.com",
    teamId: "team-1",
    overallVisibility: 60,
    bestProvider: "openai",
    worstProvider: null,
    avgPosition: 2,
    sentimentScore: 50,
    providerResults: [],
    competitorVisibility: {},
    creditsUsed: 5,
    promptsUsed: [],
    createdAt: new Date("2026-03-01"),
    ...overrides,
  };
}

const DEFAULT_PROPS = {
  siteId: "site-1",
  accessToken: "tok-valid",
  domain: "example.com",
  lastCheck: null,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("CitationMonitor — history tab", () => {
  beforeEach(() => vi.clearAllMocks());

  it("M-1 — history=[r1,r2] → History tab button reads 'History (2)'", () => {
    const history = [makeScore({ checkId: "c1" }), makeScore({ checkId: "c2" })];
    render(<CitationMonitor {...DEFAULT_PROPS} history={history} />);
    expect(screen.getByText("History (2)")).toBeInTheDocument();
  });

  it("M-2 — clicking History tab → CitationHistory rendered, Run Check content hidden", () => {
    const history = [makeScore()];
    render(<CitationMonitor {...DEFAULT_PROPS} history={history} />);

    // Before click: CitationHistory not visible
    expect(screen.queryByTestId("citation-history")).not.toBeInTheDocument();

    // Click History tab
    fireEvent.click(screen.getByText("History (1)"));

    // CitationHistory now rendered
    expect(screen.getByTestId("citation-history")).toBeInTheDocument();

    // Run Check content (idle message) hidden
    expect(screen.queryByText(/No scans run yet/i)).not.toBeInTheDocument();
  });

  it("M-3 — after complete SSE event, localHistory length increases by 1", async () => {
    const history = [makeScore()];

    // Mock fetch to simulate SSE complete event
    const completePayload = {
      type: "complete",
      checkId: "new-chk",
      scores: {
        overallVisibility: 75,
        bestProvider: "openai",
        worstProvider: null,
        avgPosition: 1,
        sentimentScore: 80,
        competitorVisibility: {},
      },
      providerResults: [],
      promptsUsed: ["prompt 1"],
      creditsUsed: 5,
    };

    const sseData = `data: ${JSON.stringify(completePayload)}\n\n`;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseData));
        controller.close();
      },
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: stream,
    });

    render(<CitationMonitor {...DEFAULT_PROPS} history={history} />);

    // Run a check
    await act(async () => {
      fireEvent.click(screen.getByText("Scan AI Citations (5 credits)"));
      // Let all promises resolve
      await new Promise(r => setTimeout(r, 50));
    });

    // Switch to history tab and verify count increased
    fireEvent.click(screen.getByText(/History \(2\)/));
    expect(screen.getByText("CitationHistory:2")).toBeInTheDocument();
  });

  it("M-4 — history=[] → 'History (0)' button renders without crash", () => {
    render(<CitationMonitor {...DEFAULT_PROPS} history={[]} />);
    // Button with no count badge
    expect(screen.getByText("History")).toBeInTheDocument();
    // No crash
  });
});
