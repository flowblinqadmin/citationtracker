/**
 * Unit tests for runDiscovery() error handling — ES-031
 * ED-1 through ED-6
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CitationMonitor } from "@/app/components/citation-monitor";
import { type CitationCheckScore } from "@/lib/types/citation";

// ─── Mock sub-components ──────────────────────────────────────────────────────
// Avoids recharts jsdom measurement issues and keeps tests focused on fetch.

vi.mock("@/app/components/citation-analytics", () => ({
  CitationAnalytics: () => <div data-testid="citation-analytics" />,
}));

vi.mock("@/app/components/citation-history", () => ({
  CitationHistory: () => <div data-testid="citation-history" />,
}));

// ─── Mock helper (per ES-031 spec) ────────────────────────────────────────────

function mockFetchResponse(opts: {
  ok: boolean;
  status: number;
  text?: () => Promise<string>;
  body?: ReadableStream | null;
}) {
  vi.spyOn(global, "fetch").mockResolvedValue({
    ok: opts.ok,
    status: opts.status,
    text: opts.text ?? (() => Promise.resolve("")),
    body: opts.body ?? null,
  } as Response);
}

// ─── Default props ────────────────────────────────────────────────────────────

const DEFAULT_PROPS = {
  siteId: "site-1",
  accessToken: "token-abc",
  domain: "example.com",
  lastCheck: null,
  history: [] as CitationCheckScore[],
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("CitationMonitor — runDiscovery() error handling (ES-031)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ED-1 — 402 JSON error body → UI shows error field from JSON body", async () => {
    mockFetchResponse({
      ok: false,
      status: 402,
      text: () => Promise.resolve('{"error":"insufficient_credits"}'),
    });

    render(<CitationMonitor {...DEFAULT_PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: /Map Competitors/i }));

    await waitFor(() => {
      expect(screen.getByText(/insufficient_credits/)).toBeTruthy();
    });
  });

  it("ED-2 — 500 HTML body → UI shows 'HTTP 500', no thrown exception", async () => {
    mockFetchResponse({
      ok: false,
      status: 500,
      text: () => Promise.resolve("<html>Internal Server Error</html>"),
    });

    render(<CitationMonitor {...DEFAULT_PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: /Map Competitors/i }));

    await waitFor(() => {
      expect(screen.getByText(/HTTP 500/)).toBeTruthy();
    });
  });

  it("ED-3 — Non-2xx empty body → UI shows 'HTTP 503'", async () => {
    mockFetchResponse({
      ok: false,
      status: 503,
      text: () => Promise.resolve(""),
    });

    render(<CitationMonitor {...DEFAULT_PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: /Map Competitors/i }));

    await waitFor(() => {
      expect(screen.getByText(/HTTP 503/)).toBeTruthy();
    });
  });

  it("ED-4 — res.body is null with res.ok → UI shows 'No response body' gracefully", async () => {
    mockFetchResponse({
      ok: true,
      status: 200,
      body: null,
    });

    render(<CitationMonitor {...DEFAULT_PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: /Map Competitors/i }));

    await waitFor(() => {
      expect(screen.getByText(/No response body/)).toBeTruthy();
    });
  });

  it("ED-5 — happy path unchanged — SSE stream parsed correctly", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "start", message: "Starting…" })}\n\n`
          )
        );
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              type: "complete",
              competitors: [
                { name: "Rival Corp", rank: 1, mentions: 5, category: "direct" },
              ],
            })}\n\n`
          )
        );
        controller.close();
      },
    });

    mockFetchResponse({ ok: true, status: 200, body: stream });

    render(<CitationMonitor {...DEFAULT_PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: /Map Competitors/i }));

    await waitFor(() => {
      expect(screen.getByText(/Rival Corp/)).toBeTruthy();
    });
  });

  it("ED-6 — existing citation-monitor component renders without crash (regression guard)", () => {
    // Verifies ES-031 changes don't break the basic component lifecycle.
    // The full CMT-1–5 regression suite lives in citation-monitor-tabs.test.tsx.
    expect(() => render(<CitationMonitor {...DEFAULT_PROPS} />)).not.toThrow();
  });
});
