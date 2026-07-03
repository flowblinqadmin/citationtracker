/**
 * ES-wave-1 — RowActions.handleRerunAudit UT (AC-4).
 *
 * Asserts that on a 202 from POST /api/sites/:id/regenerate, RowActions calls
 * router.refresh() (in addition to the pre-existing onScanStart callback)
 * so the dashboard's next server-render pass picks up the rotated
 * geo_sites.access_token. Negative case: 409 / 402 must NOT trigger refresh.
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
    siteId: "site-abc",
    accessToken: "tok-123",
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

describe("RowActions.handleRerunAudit — router.refresh after 202 (AC-4)", () => {
  it("202 response calls router.refresh exactly once after onScanStart", async () => {
    mockFetch.mockResolvedValueOnce({ status: 202, ok: true });
    const onScanStart = vi.fn();
    render(<RowActions {...makeProps({ onScanStart })} />);

    await act(async () => {
      fireEvent.click(screen.getByTitle(/Rerun Audit/i));
    });

    await waitFor(() => {
      expect(onScanStart).toHaveBeenCalledOnce();
      expect(mockRefresh).toHaveBeenCalledOnce();
    });
    // onScanStart fires first, then router.refresh (sequential within the 202 branch).
    expect(onScanStart.mock.invocationCallOrder[0])
      .toBeLessThan(mockRefresh.mock.invocationCallOrder[0]);
  });

  it("non-202 response (409 / 402) does NOT call router.refresh", async () => {
    mockFetch.mockResolvedValueOnce({ status: 409, ok: false });
    render(<RowActions {...makeProps()} />);

    await act(async () => {
      fireEvent.click(screen.getByTitle(/Rerun Audit/i));
    });

    await waitFor(() => {
      expect(screen.getByText(/Scan already in progress/i)).toBeInTheDocument();
    });
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
