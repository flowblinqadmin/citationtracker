/**
 * ES-B9.1 — RowActions error tooltip + bulk routing + DomainTableRow Failed-button.
 *
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";

afterEach(() => cleanup());

const mockRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: mockRefresh }),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import RowActions from "@/app/dashboard/RowActions";

function makeProps(overrides: Partial<React.ComponentProps<typeof RowActions>> = {}) {
  return {
    siteId: "site-x",
    accessToken: "tok-abc",
    domain: "example.com",
    initialPipelineStatus: "complete",
    citationRate: null,
    onScanStart: vi.fn(),
    onCitationStart: vi.fn(),
    onCitationEnd: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AC-B9.1-2 — non-2xx surfaces a tooltip with truncated server error / 5xx fallback", () => {
  it("U-1: 400 with server error body → tooltip shows truncated error verbatim (≤80 chars)", async () => {
    mockFetch.mockResolvedValueOnce({
      status: 400,
      ok: false,
      json: async () => ({ error: "Bulk audits cannot be regenerated. Upload a new CSV on the landing page." }),
    });
    render(<RowActions {...makeProps()} />);
    await act(async () => {
      fireEvent.click(screen.getByTitle(/Rerun Audit/i));
    });
    await waitFor(() => {
      const tip = screen.getByTestId("row-action-tooltip");
      expect(tip.textContent).toMatch(/Bulk audits cannot be regenerated/);
      expect((tip.textContent ?? "").length).toBeLessThanOrEqual(80);
    });
  });

  it("U-2: 500 → tooltip shows 'Server error — try again' (generic; never a JSON parse leak)", async () => {
    mockFetch.mockResolvedValueOnce({ status: 500, ok: false, json: async () => ({ error: "internal" }) });
    render(<RowActions {...makeProps()} />);
    await act(async () => {
      fireEvent.click(screen.getByTitle(/Rerun Audit/i));
    });
    await waitFor(() => {
      expect(screen.getByText(/Server error — try again/)).toBeInTheDocument();
    });
  });
});

describe("B10.0.2 — Rerun Audit icon routes both single + bulk to /regenerate", () => {
  it("U-3: bulk row → fetch called with /regenerate (B10.0.2 reverts B9.1's split routing)", async () => {
    mockFetch.mockResolvedValueOnce({ status: 202, ok: true });
    render(<RowActions {...makeProps({ auditMode: "bulk" })} />);
    await act(async () => {
      fireEvent.click(screen.getByTitle(/Rerun Audit/i));
    });
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    const [url] = mockFetch.mock.calls[0];
    expect(String(url)).toContain("/regenerate");
    expect(String(url)).not.toContain("/retry-failed");
  });

  it("U-4: single row → fetch called with /regenerate (regression guard)", async () => {
    mockFetch.mockResolvedValueOnce({ status: 202, ok: true });
    render(<RowActions {...makeProps({ auditMode: "single" })} />);
    await act(async () => {
      fireEvent.click(screen.getByTitle(/Rerun Audit/i));
    });
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    const [url] = mockFetch.mock.calls[0];
    expect(String(url)).toContain("/regenerate");
    expect(String(url)).not.toContain("/retry-failed");
  });

  it("auditMode undefined defaults to single (regenerate)", async () => {
    mockFetch.mockResolvedValueOnce({ status: 202, ok: true });
    render(<RowActions {...makeProps()} />);
    await act(async () => {
      fireEvent.click(screen.getByTitle(/Rerun Audit/i));
    });
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(String(mockFetch.mock.calls[0][0])).toContain("/regenerate");
  });

  it("bulk + 202 fires onScanStart + router.refresh (B10.0.2 success branch)", async () => {
    mockFetch.mockResolvedValueOnce({ status: 202, ok: true });
    const onScanStart = vi.fn();
    render(<RowActions {...makeProps({ auditMode: "bulk", onScanStart })} />);
    await act(async () => {
      fireEvent.click(screen.getByTitle(/Rerun Audit/i));
    });
    await waitFor(() => {
      expect(onScanStart).toHaveBeenCalledOnce();
      expect(mockRefresh).toHaveBeenCalled();
    });
  });
});

describe("AC-B9.1-5 — tooltip CSS tolerates long error strings", () => {
  it("U-7: tooltip element has max-width + word-break + whitespace normal", async () => {
    mockFetch.mockResolvedValueOnce({
      status: 400,
      ok: false,
      json: async () => ({ error: "X" }),
    });
    render(<RowActions {...makeProps()} />);
    await act(async () => {
      fireEvent.click(screen.getByTitle(/Rerun Audit/i));
    });
    const tip = await screen.findByTestId("row-action-tooltip");
    expect(tip).toHaveAttribute("role", "tooltip");
    const style = (tip as HTMLElement).style;
    // Source-grep instead of jsdom computed style — jsdom inconsistently
    // strips/preserves whitespace inside CSS calc/min/max function args.
    const fs = await import("fs");
    const path = await import("path");
    const ra = fs.readFileSync(
      path.resolve(process.cwd(), "app/dashboard/RowActions.tsx"),
      "utf8",
    );
    expect(ra).toMatch(/maxWidth:\s*"min\(80vw,\s*480px\)"/);
    // B10.0.3: tooltip CSS replaced deprecated wordBreak: "break-word" with
    // standards-compliant pair: wordBreak: "normal" + overflowWrap: "anywhere".
    // Modern browsers treat "break-word" as break-all in narrow containers,
    // producing vertical character stacking. The new pair wraps at word
    // boundaries and only breaks mid-word for over-long tokens (URLs).
    expect(style.wordBreak).toBe("normal");
    expect(style.overflowWrap).toBe("anywhere");
    expect(style.whiteSpace).toBe("normal");
  });
});

// Source-grep on SitePageClient for the same CSS contract on bulkRetryError.
// Anchor on role="alert" (the JSX block immediately preceding the styled div)
// rather than `bulkRetryError` (which appears earlier in a useState declaration
// far from the styled JSX).
describe("AC-B9.1-5 + B10.0.3 — SitePageClient bulkRetryError CSS parity", () => {
  it("U-8: bulkRetryError div carries the standards-compliant overflow tokens", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "app/sites/[id]/SitePageClient.tsx"),
      "utf8",
    );
    expect(src).toMatch(/role="alert"[\s\S]{0,600}maxWidth:\s*"min\(80vw,\s*480px\)"/);
    expect(src).toMatch(/role="alert"[\s\S]{0,600}wordBreak:\s*"normal"/);
    expect(src).toMatch(/role="alert"[\s\S]{0,600}overflowWrap:\s*"anywhere"/);
  });
});
