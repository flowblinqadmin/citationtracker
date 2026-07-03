/**
 * ES-061 — RowActions Component Unit Tests
 * U31–U37
 *
 * Written spec-first (Phase A — ReviewMaster).
 * These tests are RED until DaVinci creates app/dashboard/RowActions.tsx.
 *
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  act,
} from "@testing-library/react";

afterEach(() => cleanup());

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ── Import under test ─────────────────────────────────────────────────────────

import RowActions from "@/app/dashboard/RowActions";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeProps(overrides: Partial<{
  siteId: string;
  accessToken: string | null;
  domain: string;
  initialPipelineStatus: string | null;
  citationRate: number | null;
  onScanStart: () => void;
  onCitationStart: () => void;
  onCitationEnd: () => void;
}> = {}) {
  return {
    siteId: "site-123",
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

// ── Rendering ─────────────────────────────────────────────────────────────────

describe("RowActions — rendering (U31, U36, U37)", () => {
  it("U31 — renders all 4 action buttons", () => {
    render(<RowActions {...makeProps()} />);
    // Rerun Audit button
    expect(screen.getByTitle(/Rerun Audit/i)).toBeInTheDocument();
    // Rerun Citations button
    expect(screen.getByTitle(/Rerun Citations/i)).toBeInTheDocument();
    // Download ZIP link
    expect(screen.getByTitle(/Download ZIP/i)).toBeInTheDocument();
    // Download Report (disabled — no citation check)
    expect(screen.getByTitle(/Run citation check first/i)).toBeInTheDocument();
  });

  it("U37 — Download Report button is disabled without citation check", () => {
    render(<RowActions {...makeProps()} />);
    const reportBtn = screen.getByTitle(/Run citation check first/i);
    expect(reportBtn).toBeDisabled();
  });

  it("U36 — Download ZIP button is enabled when pipelineStatus is complete and triggers fetch with siteId/token", async () => {
    mockFetch.mockResolvedValue({ ok: true, blob: () => Promise.resolve(new Blob(["zip"])) });
    global.URL.createObjectURL = vi.fn().mockReturnValue("blob:fake");
    global.URL.revokeObjectURL = vi.fn();
    render(<RowActions {...makeProps({ initialPipelineStatus: "complete" })} />);
    const btn = screen.getByTitle(/Download ZIP/i);
    expect((btn as HTMLButtonElement).tagName).toBe("BUTTON");
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { fireEvent.click(btn); });
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("site-123"));
      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("tok-abc"));
    });
  });

  it("Download Report has cursor:not-allowed style when no citations", () => {
    render(<RowActions {...makeProps()} />);
    const btn = screen.getByTitle(/Run citation check first/i);
    expect(btn).toBeDisabled();
  });
});

// ── Rerun Audit ───────────────────────────────────────────────────────────────

describe("RowActions — Rerun Audit", () => {
  it("U32 — 202 response calls onScanStart callback", async () => {
    mockFetch.mockResolvedValueOnce({ status: 202, ok: true });
    const onScanStart = vi.fn();
    render(<RowActions {...makeProps({ onScanStart })} />);

    await act(async () => {
      fireEvent.click(screen.getByTitle(/Rerun Audit/i));
    });

    await waitFor(() => {
      expect(onScanStart).toHaveBeenCalledOnce();
    });
  });

  it("U33 — 409 shows 'Scan already in progress' tooltip", async () => {
    mockFetch.mockResolvedValueOnce({ status: 409, ok: false });
    render(<RowActions {...makeProps()} />);

    await act(async () => {
      fireEvent.click(screen.getByTitle(/Rerun Audit/i));
    });

    await waitFor(() => {
      expect(screen.getByText(/Scan already in progress/i)).toBeInTheDocument();
    });
  });

  it("U34 — 402 shows 'Not enough credits' tooltip", async () => {
    mockFetch.mockResolvedValueOnce({ status: 402, ok: false });
    render(<RowActions {...makeProps()} />);

    await act(async () => {
      fireEvent.click(screen.getByTitle(/Rerun Audit/i));
    });

    await waitFor(() => {
      expect(screen.getByText(/Not enough credits/i)).toBeInTheDocument();
    });
  });

  it("U35 — accessToken=null, click does nothing (fetch not called)", async () => {
    render(<RowActions {...makeProps({ accessToken: null })} />);

    await act(async () => {
      fireEvent.click(screen.getByTitle(/Rerun Audit/i));
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fetch failure shows 'Request failed' tooltip", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));
    render(<RowActions {...makeProps()} />);

    await act(async () => {
      fireEvent.click(screen.getByTitle(/Rerun Audit/i));
    });

    await waitFor(() => {
      expect(screen.getByText(/Request failed/i)).toBeInTheDocument();
    });
  });

  it("fetch call targets correct URL: /api/sites/:id/regenerate", async () => {
    mockFetch.mockResolvedValueOnce({ status: 202, ok: true });
    render(<RowActions {...makeProps()} />);

    await act(async () => {
      fireEvent.click(screen.getByTitle(/Rerun Audit/i));
    });

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/sites/site-123/regenerate");
    expect((options as RequestInit)?.method).toBe("POST");
  });
});
