/**
 * ES-061 — DomainTableRow Component Unit Tests
 * U38–U50
 *
 * Written spec-first (Phase A — ReviewMaster).
 * These tests are RED until DaVinci creates app/dashboard/DomainTableRow.tsx.
 *
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";

afterEach(() => cleanup());

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    refresh: mockRefresh,
  }),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ── Import under test ─────────────────────────────────────────────────────────

import DomainTableRow from "@/app/dashboard/DomainTableRow";

// ── Fixtures ──────────────────────────────────────────────────────────────────

type Tier = "GOOD" | "FAIR" | "WEAK" | "POOR";

const baseRow = {
  id: "td-1",
  domain: "example.com",
  siteId: "site-123",
  accessToken: "tok-abc",
  pipelineStatus: "complete" as string | null,
  overallScore: 72 as number | null,
  tier: "FAIR" as Tier | null,
  criticalIssues: 2,
  delta: null as number | null,
  pageCount: 15,
  citationRate: 60 as number | null,
  lastCrawlAt: "2026-03-20T00:00:00Z" as string | null,
};

function WrappedRow(props: { row: typeof baseRow }) {
  return (
    <table>
      <tbody>
        <DomainTableRow row={props.row} />
      </tbody>
    </table>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRefresh.mockReset();
});

// ── Normal Row Rendering ──────────────────────────────────────────────────────

describe("DomainTableRow — normal row (U38–U45)", () => {
  it("U38 — renders without error, has at least 8 td cells", () => {
    const { container } = render(<WrappedRow row={baseRow} />);
    const cells = container.querySelectorAll("td");
    expect(cells.length).toBeGreaterThanOrEqual(8);
  });

  it("U39 — overallScore=72 shown; orange (#ff9500) progress bar for 50–74 range", () => {
    const { container } = render(<WrappedRow row={baseRow} />);
    expect(screen.getByText("72")).toBeInTheDocument();
    // Orange fill per spec: score 50–74
    // JSDOM normalizes hex to rgb(), so check both formats
    const fills = container.querySelectorAll<HTMLElement>("[style]");
    const orangeFill = Array.from(fills).find((el) => {
      const bg = el.style.background ?? "";
      const attr = el.getAttribute("style") ?? "";
      return bg.includes("#ff9500") || bg.includes("255, 149, 0") ||
             attr.includes("ff9500") || attr.includes("255, 149, 0");
    });
    expect(orangeFill).not.toBeUndefined();
  });

  it("U40 — tier=GOOD badge has blue background (#e3f2fd)", () => {
    render(<WrappedRow row={{ ...baseRow, tier: "GOOD", overallScore: 80 }} />);
    const badge = screen.getByText("GOOD");
    const style = badge.getAttribute("style") ?? "";
    // JSDOM normalizes #e3f2fd → rgb(227, 242, 253)
    expect(style).toMatch(/#e3f2fd|227, 242, 253/i);
  });

  it("U41 — delta=+5 shows green text '+5'", () => {
    render(<WrappedRow row={{ ...baseRow, delta: 5 }} />);
    const el = screen.getByText("+5");
    expect(el).toBeInTheDocument();
    const style = el.getAttribute("style") ?? "";
    // JSDOM normalizes #34c759 → rgb(52, 199, 89)
    expect(style).toMatch(/#34c759|52, 199, 89/i);
  });

  it("U42 — delta=-3 shows red text '-3'", () => {
    render(<WrappedRow row={{ ...baseRow, delta: -3 }} />);
    const el = screen.getByText("-3");
    expect(el).toBeInTheDocument();
    const style = el.getAttribute("style") ?? "";
    // JSDOM normalizes #ff3b30 → rgb(255, 59, 48)
    expect(style).toMatch(/#ff3b30|255, 59, 48/i);
  });

  it("U43 — delta=null shows '—'", () => {
    render(<WrappedRow row={{ ...baseRow, delta: null, overallScore: null, tier: null }} />);
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThanOrEqual(1);
  });

  it("U44 — criticalIssues=5 cell has red color (#ff3b30)", () => {
    const { container } = render(<WrappedRow row={{ ...baseRow, criticalIssues: 5 }} />);
    const critEl = screen.getByText("5");
    const parent = critEl.closest<HTMLElement>("[style]");
    const style = parent?.getAttribute("style") ?? critEl.getAttribute("style") ?? "";
    // JSDOM normalizes #ff3b30 → rgb(255, 59, 48)
    expect(style).toMatch(/#ff3b30|255, 59, 48/i);
  });

  it("U45 — criticalIssues=4 cell does NOT have red color", () => {
    render(<WrappedRow row={{ ...baseRow, criticalIssues: 4 }} />);
    const critEl = screen.getByText("4");
    const parent = critEl.closest<HTMLElement>("[style]");
    const style = parent?.getAttribute("style") ?? critEl.getAttribute("style") ?? "";
    // JSDOM normalizes #ff3b30 → rgb(255, 59, 48)
    expect(style).not.toMatch(/#ff3b30|255, 59, 48/i);
  });

  it("domain link navigates to /dashboard/domains/:siteId", () => {
    render(<WrappedRow row={baseRow} />);
    const link = screen.getByRole("link", { name: /example\.com/i });
    expect(link.getAttribute("href")).toContain("site-123");
  });

  it("domain column shows page count subtitle", () => {
    render(<WrappedRow row={baseRow} />);
    expect(screen.getByText(/15 pages/i)).toBeInTheDocument();
  });

  it("citationRate shown as '60%'", () => {
    render(<WrappedRow row={baseRow} />);
    expect(screen.getByText(/60%/)).toBeInTheDocument();
  });

  it("citationRate=null shows '—'", () => {
    render(<WrappedRow row={{ ...baseRow, citationRate: null }} />);
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Scanning Row ──────────────────────────────────────────────────────────────

describe("DomainTableRow — scanning row (U46–U48)", () => {
  const scanningRow = { ...baseRow, pipelineStatus: "crawling" };

  it("U46 — scanning + isNewSite=false (has score): score visible at reduced opacity", () => {
    const { container } = render(<WrappedRow row={scanningRow} />);
    // The score should exist in the DOM
    const scoreText = screen.queryByText("72");
    expect(scoreText).not.toBeNull();
    // It should be wrapped in an element with opacity: 0.4
    const fadedEl = container.querySelector<HTMLElement>("[style*='0.4']");
    expect(fadedEl).not.toBeNull();
  });

  it("U47 — scanning + isNewSite=true (overallScore=null): score col shows '—'", () => {
    render(
      <WrappedRow
        row={{ ...baseRow, pipelineStatus: "crawling", overallScore: null, tier: null }}
      />
    );
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThanOrEqual(1);
  });

  it("U48 — scanning row shows pipeline status widget with STEP indicator", () => {
    render(<WrappedRow row={scanningRow} />);
    // The widget shows "STEP X OF 6"
    expect(screen.getByText(/STEP/i)).toBeInTheDocument();
  });

  it("scanning row has warm tint background (COPPER_BG #fff7ed)", () => {
    const { container } = render(<WrappedRow row={scanningRow} />);
    const tr = container.querySelector("tr");
    const style = tr?.getAttribute("style") ?? "";
    // JSDOM normalizes #fff7ed → rgb(255, 247, 237)
    expect(style).toMatch(/#fff7ed|255, 247, 237/i);
  });

  it("scanning row has data-domain attribute for DashboardFilter", () => {
    const { container } = render(<WrappedRow row={scanningRow} />);
    const tr = container.querySelector("tr");
    expect(tr?.dataset.domain).toBe("example.com");
  });
});

// ── Polling ───────────────────────────────────────────────────────────────────

describe("DomainTableRow — polling (U49–U50)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("U49 — polling fires fetch after 3s when pipelineStatus is active", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        pipelineStatus: "crawling",
        geoScorecard: null,
      }),
    });

    render(<WrappedRow row={{ ...baseRow, pipelineStatus: "crawling" }} />);

    await act(async () => {
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
    });

    expect(mockFetch).toHaveBeenCalled();
    const [url] = mockFetch.mock.calls[0];
    expect(String(url)).toContain("/api/sites/site-123");
  });

  it("U50 — polling stops and router.refresh() called when status becomes 'complete'", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        pipelineStatus: "complete",
        geoScorecard: { overallScore: 78 },
      }),
    });

    render(<WrappedRow row={{ ...baseRow, pipelineStatus: "crawling" }} />);

    await act(async () => {
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
    });

    expect(mockFetch).toHaveBeenCalled();
    // router.refresh() called after scan completion
    expect(mockRefresh).toHaveBeenCalled();

    const callCountAfterComplete = mockFetch.mock.calls.length;

    // Advance timers further — polling should have stopped
    await act(async () => {
      vi.advanceTimersByTime(9000);
      await Promise.resolve();
    });

    expect(mockFetch.mock.calls.length).toBe(callCountAfterComplete);
  });

  it("inactive status (complete) does not start polling at all", async () => {
    render(<WrappedRow row={{ ...baseRow, pipelineStatus: "complete" }} />);

    await act(async () => {
      vi.advanceTimersByTime(6000);
      await Promise.resolve();
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });
});
