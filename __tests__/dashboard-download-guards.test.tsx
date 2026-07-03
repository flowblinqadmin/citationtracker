/**
 * ES-071 — Dashboard: Download Guards, Failure Fallback, Pipeline Error Visibility
 * Unit tests — T-071-1 through T-071-12
 *
 * T-071-1:  ZIP button disabled when pipelineStatus is active (crawling)
 * T-071-2:  ZIP button enabled when pipelineStatus is "complete"
 * T-071-3:  ZIP button enabled when pipelineStatus is "failed"
 * T-071-4:  ZIP button click with failed API → tooltip error, no download
 * T-071-5:  PDF button disabled when citationRate is null
 * T-071-6:  PDF button disabled when pipelineStatus is active even with citationRate
 * T-071-7:  PDF button enabled when complete + citationRate
 * T-071-8:  PDF button enabled when failed + citationRate
 * T-071-9:  Successful ZIP fetch creates blob URL and triggers download
 * T-071-10: Failed fetch shows tooltip error, no file download
 * T-071-11: Failed pipeline row shows error indicator
 * T-071-12: Failed pipeline row with score shows stale badge
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import React from "react";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockRouter = {
  replace: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  prefetch: vi.fn(),
};

vi.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(),
}));

// Mock dashboard utils (domainMonogramColor, formatDashDate)
vi.mock("@/app/dashboard/utils", () => ({
  domainMonogramColor: () => "background:#e3f2fd;color:#1565c0",
  formatDashDate: (d: string | null) => d ?? "—",
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

const SITE_ID = "site-071-test";
const ACCESS_TOKEN = "token-071";

function makeRowActionsProps(overrides: Record<string, unknown> = {}) {
  return {
    siteId: SITE_ID,
    accessToken: ACCESS_TOKEN,
    domain: "example.com",
    initialPipelineStatus: "complete" as string | null,
    citationRate: null as number | null,
    onScanStart: vi.fn(),
    onCitationStart: vi.fn(),
    onCitationEnd: vi.fn(),
    ...overrides,
  };
}

function makeDomainRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    domain: "example.com",
    siteId: SITE_ID,
    accessToken: ACCESS_TOKEN,
    pipelineStatus: "complete" as string | null,
    overallScore: 72 as number | null,
    tier: "GOOD" as "GOOD" | "FAIR" | "WEAK" | "POOR" | null,
    criticalIssues: 0,
    delta: null as number | null,
    pageCount: 10,
    citationRate: null as number | null,
    lastCrawlAt: "2026-03-30T00:00:00Z" as string | null,
    pipelineError: null as string | null,
    ...overrides,
  };
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = vi.fn();

  // Mock URL.createObjectURL / revokeObjectURL
  global.URL.createObjectURL = vi.fn().mockReturnValue("blob:http://localhost/fake-blob");
  global.URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── RowActions Tests ─────────────────────────────────────────────────────────

describe("RowActions — ZIP button guards", () => {
  let RowActions: React.ComponentType<ReturnType<typeof makeRowActionsProps>>;

  beforeEach(async () => {
    const mod = await import("@/app/dashboard/RowActions");
    RowActions = mod.default;
  });

  it("T-071-1: ZIP button disabled when pipelineStatus is active (crawling)", () => {
    render(<RowActions {...makeRowActionsProps({ initialPipelineStatus: "crawling" })} />);
    const btn = screen.getByTitle("Audit in progress");
    expect(btn.tagName).toBe("BUTTON");
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect((btn as HTMLButtonElement).style.cursor).toBe("not-allowed");
  });

  it("T-071-2: ZIP button enabled when pipelineStatus is complete", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(["fake-zip"], { type: "application/zip" })),
    });

    render(<RowActions {...makeRowActionsProps({ initialPipelineStatus: "complete" })} />);
    const btn = screen.getByTitle("Download ZIP · 5cr");
    expect((btn as HTMLButtonElement).disabled).toBe(false);

    await act(async () => { fireEvent.click(btn); });
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/api/sites/${SITE_ID}/download-report`)
    ));
  });

  it("T-071-3: ZIP button enabled when pipelineStatus is failed", () => {
    render(<RowActions {...makeRowActionsProps({ initialPipelineStatus: "failed" })} />);
    const btn = screen.getByTitle("Download ZIP · 5cr");
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  it("T-071-4: ZIP click with failed API response shows tooltip, no download", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: "No per-page results available." }),
    });

    render(<RowActions {...makeRowActionsProps({ initialPipelineStatus: "failed" })} />);
    const btn = screen.getByTitle("Download ZIP · 5cr");
    await act(async () => { fireEvent.click(btn); });

    await waitFor(() => expect(screen.getByText("No per-page results available.")).toBeTruthy());
    expect(global.URL.createObjectURL).not.toHaveBeenCalled();
  });
});

describe("RowActions — PDF button guards", () => {
  let RowActions: React.ComponentType<ReturnType<typeof makeRowActionsProps>>;

  beforeEach(async () => {
    const mod = await import("@/app/dashboard/RowActions");
    RowActions = mod.default;
  });

  it("T-071-5: PDF button disabled when citationRate is null", () => {
    render(<RowActions {...makeRowActionsProps({ citationRate: null, initialPipelineStatus: "complete" })} />);
    const btn = screen.getByTitle("Run citation check first");
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("T-071-6: PDF button disabled when pipelineStatus is active even with citationRate", () => {
    render(<RowActions {...makeRowActionsProps({ citationRate: 45, initialPipelineStatus: "analyzing" })} />);
    // Both ZIP and PDF buttons carry "Audit in progress" title — verify PDF (last one) is disabled
    const btns = screen.getAllByTitle("Audit in progress");
    expect(btns.length).toBeGreaterThanOrEqual(1);
    btns.forEach(btn => expect((btn as HTMLButtonElement).disabled).toBe(true));
  });

  it("T-071-7: PDF button enabled when complete + citationRate", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(["fake-pdf"], { type: "application/pdf" })),
    });

    render(<RowActions {...makeRowActionsProps({ citationRate: 45, initialPipelineStatus: "complete" })} />);
    const btn = screen.getByTitle("Download PDF Report · 5cr");
    expect((btn as HTMLButtonElement).disabled).toBe(false);

    await act(async () => { fireEvent.click(btn); });
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/api/sites/${SITE_ID}/pdf-report`)
    ));
  });

  it("T-071-8: PDF button enabled when failed + citationRate", () => {
    render(<RowActions {...makeRowActionsProps({ citationRate: 45, initialPipelineStatus: "failed" })} />);
    const btn = screen.getByTitle("Download PDF Report · 5cr");
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("RowActions — download fetch behavior", () => {
  let RowActions: React.ComponentType<ReturnType<typeof makeRowActionsProps>>;

  beforeEach(async () => {
    const mod = await import("@/app/dashboard/RowActions");
    RowActions = mod.default;
  });

  it("T-071-9: Successful ZIP fetch creates blob URL and triggers download", async () => {
    const fakeBlob = new Blob(["zip-content"], { type: "application/zip" });
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(fakeBlob),
    });

    // Render first — then spy so RTL mount is not affected
    render(<RowActions {...makeRowActionsProps({ initialPipelineStatus: "complete" })} />);
    const btn = screen.getByTitle("Download ZIP · 5cr");

    const mockClick = vi.fn();
    const mockAnchor = {
      href: "",
      download: "",
      click: mockClick,
      remove: vi.fn(),
      style: {},
    } as unknown as HTMLAnchorElement;
    const originalCreateElement = document.createElement.bind(document);
    const createElementSpy = vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag === "a") return mockAnchor;
      return originalCreateElement(tag as "div");
    });
    vi.spyOn(document.body, "appendChild").mockReturnValue(mockAnchor);

    await act(async () => { fireEvent.click(btn); });

    await waitFor(() => {
      expect(global.URL.createObjectURL).toHaveBeenCalledWith(fakeBlob);
      expect(mockClick).toHaveBeenCalled();
      expect(mockAnchor.download).toBe(`${SITE_ID}-report.zip`);
      expect(global.URL.revokeObjectURL).toHaveBeenCalledWith("blob:http://localhost/fake-blob");
    });

    createElementSpy.mockRestore();
  });

  it("T-071-10: Failed fetch shows tooltip error, no file download", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: "Scorecard not yet available." }),
    });

    render(<RowActions {...makeRowActionsProps({ initialPipelineStatus: "complete" })} />);
    const btn = screen.getByTitle("Download ZIP · 5cr");
    await act(async () => { fireEvent.click(btn); });

    await waitFor(() => expect(screen.getByText("Scorecard not yet available.")).toBeTruthy());
    expect(global.URL.createObjectURL).not.toHaveBeenCalled();
  });
});

describe("RowActions — edge cases", () => {
  let RowActions: React.ComponentType<ReturnType<typeof makeRowActionsProps>>;

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const mod = await import("@/app/dashboard/RowActions");
    RowActions = mod.default;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("AC-8: clicking disabled ZIP button does not trigger fetch", async () => {
    render(<RowActions {...makeRowActionsProps({ initialPipelineStatus: "crawling" })} />);
    const btn = screen.getByTitle("Audit in progress");
    await act(async () => { fireEvent.click(btn); });
    // fetch should not be called for download (may be called for other reasons)
    const downloadCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("download-report")
    );
    expect(downloadCalls.length).toBe(0);
  });

  it("AC-9: download tooltip auto-dismisses after 3 seconds", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: "Server error" }),
    });

    render(<RowActions {...makeRowActionsProps({ initialPipelineStatus: "complete" })} />);
    await act(async () => { fireEvent.click(screen.getByTitle("Download ZIP · 5cr")); });

    await waitFor(() => expect(screen.getByText("Server error")).toBeTruthy());

    await act(async () => { vi.advanceTimersByTime(3000); });

    await waitFor(() => expect(screen.queryByText("Server error")).toBeNull());
  });

  it("fetch network error shows generic 'Download failed' tooltip", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network"));

    render(<RowActions {...makeRowActionsProps({ initialPipelineStatus: "complete" })} />);
    await act(async () => { fireEvent.click(screen.getByTitle("Download ZIP · 5cr")); });

    await waitFor(() => expect(screen.getByText("Download failed")).toBeTruthy());
    expect(global.URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("JSON parse failure in error response falls back to 'Download failed'", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error("not JSON")),
    });

    render(<RowActions {...makeRowActionsProps({ initialPipelineStatus: "complete" })} />);
    await act(async () => { fireEvent.click(screen.getByTitle("Download ZIP · 5cr")); });

    await waitFor(() => expect(screen.getByText("Download failed")).toBeTruthy());
  });
});

// ── DomainTableRow Tests ──────────────────────────────────────────────────────

describe("DomainTableRow — failure visibility", () => {
  let DomainTableRow: React.ComponentType<{ row: ReturnType<typeof makeDomainRow> }>;

  beforeEach(async () => {
    const mod = await import("@/app/dashboard/DomainTableRow");
    DomainTableRow = mod.default;
  });

  it("T-071-11: Failed pipeline row shows blinking red dot + retry CTA with error in tooltip", () => {
    const { container } = render(
      <table><tbody>
        <DomainTableRow row={makeDomainRow({
          pipelineStatus: "failed",
          pipelineError: "Firecrawl timeout after 300s",
        })} />
      </tbody></table>
    );
    expect(container.textContent).toContain("Failed — click to retry");
    // Error text is in the title attribute (tooltip), not visible text
    const btn = container.querySelector("button[title*='Firecrawl timeout']");
    expect(btn).toBeTruthy();
    expect(btn?.getAttribute("title")).toContain("Credits have been refunded");
  });

  it("T-071-12: Failed pipeline row with score shows 'last run' badge", () => {
    const { container } = render(
      <table><tbody>
        <DomainTableRow row={makeDomainRow({
          pipelineStatus: "failed",
          overallScore: 72,
          pipelineError: null,
        })} />
      </tbody></table>
    );
    expect(container.textContent).toContain("last run");
    expect(container.textContent).toContain("72");
  });

  it("AC-13: error message in tooltip, not in visible text", () => {
    const longError = "A".repeat(80);
    const { container } = render(
      <table><tbody>
        <DomainTableRow row={makeDomainRow({
          pipelineStatus: "failed",
          pipelineError: longError,
        })} />
      </tbody></table>
    );
    // Visible text is just "Failed — click to retry"
    expect(container.textContent).toContain("Failed — click to retry");
    // Full error is in the title tooltip
    const btn = container.querySelector("button[title*='AAAA']");
    expect(btn).toBeTruthy();
  });

  it("no 'last run' badge when pipeline is complete", () => {
    const { container } = render(
      <table><tbody>
        <DomainTableRow row={makeDomainRow({
          pipelineStatus: "complete",
          overallScore: 85,
        })} />
      </tbody></table>
    );
    expect(container.textContent).toContain("85");
    expect(container.textContent).not.toContain("last run");
  });

  it("no 'last run' badge when failed but no score", () => {
    const { container } = render(
      <table><tbody>
        <DomainTableRow row={makeDomainRow({
          pipelineStatus: "failed",
          overallScore: null,
        })} />
      </tbody></table>
    );
    expect(container.textContent).not.toContain("last run");
  });

  it("failed row with null pipelineError shows generic tooltip", () => {
    const { container } = render(
      <table><tbody>
        <DomainTableRow row={makeDomainRow({
          pipelineStatus: "failed",
          pipelineError: null,
        })} />
      </tbody></table>
    );
    expect(container.textContent).toContain("Failed — click to retry");
    const btn = container.querySelector("button[title*='Audit failed']");
    expect(btn).toBeTruthy();
  });
});
