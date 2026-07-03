/**
 * DomainTableRow polling — 401 handling regression test.
 *
 * Pins the May-2026 anomaly fix: when /api/sites/[id] returns 401, the
 * 3-second poll must terminate, surface a toast on TOKEN_EXPIRED, call
 * router.refresh() at most once, and not re-poll the same accessToken.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, cleanup } from "@testing-library/react";
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

const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { error: toastError, success: vi.fn() },
}));

vi.mock("@/app/dashboard/utils", () => ({
  domainMonogramColor: () => "background:#e3f2fd;color:#1565c0",
  formatDashDate: (d: string | null) => d ?? "—",
}));

// RowActions is heavy; stub it out — this test only cares about the
// polling effect, not the action buttons.
vi.mock("@/app/dashboard/RowActions", () => ({
  default: () => null,
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    domain: "example.com",
    siteId: "site-poll-test",
    accessToken: "token-A",
    pipelineStatus: "crawling" as string | null,   // active → polling enabled
    overallScore: null as number | null,
    tier: null as "GOOD" | "FAIR" | "WEAK" | "POOR" | null,
    criticalIssues: 0,
    delta: null as number | null,
    pageCount: 0,
    citationRate: null as number | null,
    lastCrawlAt: null as string | null,
    pipelineError: null as string | null,
    ...overrides,
  };
}

function renderRow(row: ReturnType<typeof makeRow>) {
  // DomainTableRow returns a <tr>; wrap in a valid table so React doesn't
  // emit hydration warnings.
  return render(
    <table>
      <tbody>
        <DomainTableRow row={row} />
      </tbody>
    </table>,
  );
}

let DomainTableRow: React.ComponentType<{ row: ReturnType<typeof makeRow> }>;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  global.fetch = vi.fn();
  const mod = await import("@/app/dashboard/DomainTableRow");
  DomainTableRow = mod.default as typeof DomainTableRow;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("DomainTableRow polling — 401 handling", () => {
  it("stops polling after a single 401 + TOKEN_EXPIRED — does not fire a 2nd tick", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: "Unauthorized", code: "TOKEN_EXPIRED" }),
    });

    renderRow(makeRow());

    // 1st tick at 3s — fires the 401.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError.mock.calls[0][0]).toMatch(/expired/i);
    expect(mockRouter.refresh).toHaveBeenCalledTimes(1);

    // Advance another 9 seconds — interval was cleared, fetch must NOT
    // be called again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mockRouter.refresh).toHaveBeenCalledTimes(1);
  });

  it("does not toast or refresh again on a 2nd render with the same expired accessToken", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: "Unauthorized", code: "TOKEN_EXPIRED" }),
    });

    const { rerender } = renderRow(makeRow({ accessToken: "token-A" }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);

    // Re-render with the SAME token — failedTokenRef guard must short-circuit
    // the effect; no new fetch even after another 3s.
    rerender(
      <table>
        <tbody>
          <DomainTableRow row={makeRow({ accessToken: "token-A" })} />
        </tbody>
      </table>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("re-enables polling when the row re-renders with a different accessToken", async () => {
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: "Unauthorized", code: "TOKEN_EXPIRED" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ pipelineStatus: "crawling" }),
      });

    const { rerender } = renderRow(makeRow({ accessToken: "token-A" }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);

    // Parent re-renders with a fresh server-issued token.
    rerender(
      <table>
        <tbody>
          <DomainTableRow row={makeRow({ accessToken: "token-B" })} />
        </tbody>
      </table>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    const lastCallUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(lastCallUrl).toContain("token=token-B");
  });

  it("does not toast on plain 401 without TOKEN_EXPIRED code, but still stops polling", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: "Unauthorized" }),
    });

    renderRow(makeRow());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
    expect(mockRouter.refresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("does NOT fetch when accessToken is null/empty — guards the 234-row burst", async () => {
    // The May-2026 dashboard runaway: 234 active-status rows whose
    // accessToken came back null/empty hit /api/sites/[id]?token= on first
    // tick and 401'd in parallel, flooding the DevTools console with React
    // stack traces. The failedTokenRef guard only kicks in AFTER the first
    // 401, so without an empty-token short-circuit the first burst still
    // fires. This test pins the short-circuit.
    renderRow(makeRow({ accessToken: null }));
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(global.fetch).not.toHaveBeenCalled();

    cleanup();

    renderRow(makeRow({ accessToken: "" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("keeps polling on transient 5xx — does not latch on auth-failure ref", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: "Internal" }),
    });

    renderRow(makeRow());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(toastError).not.toHaveBeenCalled();
    expect(mockRouter.refresh).not.toHaveBeenCalled();
  });
});
