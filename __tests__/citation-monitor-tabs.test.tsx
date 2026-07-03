/**
 * Unit tests for tab toggle in app/components/citation-monitor.tsx — ES-016
 * CMT-1 through CMT-5
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CitationMonitor } from "@/app/components/citation-monitor";
import { type CitationCheckScore } from "@/lib/db/schema";

// ─── Mock fetch (prevents real SSE calls) ─────────────────────────────────────

vi.stubGlobal(
  "fetch",
  vi.fn().mockResolvedValue({
    ok: false,
    status: 403,
    json: vi.fn().mockResolvedValue({ error: "mocked" }),
    body: null,
  })
);

// ─── Mock Data ────────────────────────────────────────────────────────────────

const MOCK_SCORE = (overallVisibility: number, createdAt: Date): CitationCheckScore => ({
  checkId: `check-${overallVisibility}`,
  siteId: "site-1",
  teamId: "team-1",
  domain: "example.com",
  overallVisibility,
  bestProvider: "openai",
  worstProvider: null,
  avgPosition: 2,
  sentimentScore: 1,
  providerResults: [] as unknown as CitationCheckScore["providerResults"],
  competitorVisibility: {} as unknown as CitationCheckScore["competitorVisibility"],
  creditsUsed: 5,
  promptsUsed: [] as unknown as CitationCheckScore["promptsUsed"],
  createdAt,
});

const DEFAULT_PROPS = {
  siteId: "site-1",
  accessToken: "token-abc",
  domain: "example.com",
  lastCheck: null,
  history: [] as CitationCheckScore[],
};

const d1 = new Date("2025-01-01");
const d2 = new Date("2025-02-01");
const d3 = new Date("2025-03-01");

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("CitationMonitor — tab toggle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("CMT-1 — 'Latest Scan' tab is active by default", () => {
    render(<CitationMonitor {...DEFAULT_PROPS} />);
    // The idle run-tab content is shown when no lastCheck
    expect(screen.getByText(/No scans run yet/i)).toBeTruthy();
  });

  it("CMT-2 — clicking 'History' tab switches to history view", () => {
    render(<CitationMonitor {...DEFAULT_PROPS} />);
    const historyTab = screen.getByRole("button", { name: /History/i });
    fireEvent.click(historyTab);
    // CitationHistory with empty history shows empty state text
    expect(screen.getByText(/No citation checks yet/i)).toBeTruthy();
  });

  it("CMT-3 — History tab badge shows count when history has items", () => {
    const history = [
      MOCK_SCORE(80, d3),
      MOCK_SCORE(60, d2),
      MOCK_SCORE(40, d1),
    ];
    render(<CitationMonitor {...DEFAULT_PROPS} history={history} />);
    // Tab button label: "History (3)"
    expect(screen.getByRole("button", { name: /History \(3\)/i })).toBeTruthy();
  });

  it("CMT-4 — History tab shows empty state when history is empty", () => {
    render(<CitationMonitor {...DEFAULT_PROPS} history={[]} />);
    const historyTab = screen.getByRole("button", { name: /History/i });
    fireEvent.click(historyTab);
    expect(screen.getByText(/No citation checks yet/i)).toBeTruthy();
  });

  it("CMT-5 — clicking 'Latest Scan' tab restores run view after switching to History", () => {
    render(<CitationMonitor {...DEFAULT_PROPS} />);

    // Switch to History tab
    const historyTab = screen.getByRole("button", { name: /History/i });
    fireEvent.click(historyTab);
    expect(screen.getByText(/No citation checks yet/i)).toBeTruthy();

    // Switch back to Latest Scan tab
    const runTab = screen.getByRole("button", { name: /Latest Scan/i });
    fireEvent.click(runTab);
    // Run tab content visible again
    expect(screen.getByText(/No scans run yet/i)).toBeTruthy();
  });
});
