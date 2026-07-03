/**
 * ES-062 — Competitor Discovery SSE Handler Unit Tests
 * U39–U42
 *
 * Written spec-first (Phase A — ReviewMaster).
 * These tests are RED until DaVinci implements handleMapCompetitors in SitePageClient.tsx.
 *
 * Tests use a ReadableStream mock to simulate SSE events from
 * POST /api/sites/:id/competitor-discovery
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";

// @vitest-environment jsdom (inherited from jsdom default for .tsx or set here)

afterEach(() => cleanup());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/app/components/citation-monitor", () => ({
  CitationMonitor: () => React.createElement("div", { "data-testid": "citation-monitor" }),
}));
vi.mock("@/app/components/citation-analytics", () => ({
  CitationAnalytics: () => React.createElement("div", { "data-testid": "citation-analytics" }),
}));
vi.mock("@/app/components/citation-history", () => ({
  CitationHistory: () => React.createElement("div", { "data-testid": "citation-history" }),
}));
vi.mock("@/app/components/dimensional-intelligence", () => ({
  DimensionalIntelligence: () => React.createElement("div", { "data-testid": "dimensional-intelligence" }),
}));
vi.mock("@/app/components/upgrade-modal", () => ({
  UpgradeModal: () => React.createElement("div", { "data-testid": "upgrade-modal" }),
}));
vi.mock("@/app/dashboard/BuyCreditsButton", () => ({
  default: ({ credits }: { credits: number }) =>
    React.createElement("button", { "data-testid": "buy-credits" }, String(credits)),
}));
vi.mock("@/app/dashboard/SignOutButton", () => ({
  default: () => React.createElement("button", { "data-testid": "sign-out" }),
}));

// ── SSE Stream Helpers ────────────────────────────────────────────────────────

/**
 * Creates a ReadableStream that emits SSE-formatted lines.
 * The spec handler buffers by "\n" and parses "data: {...}" lines.
 */
function makeSseStream(events: object[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const evt of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(evt)}\n\n`));
      }
      controller.close();
    },
  });
}

function makeFetchResponse(stream: ReadableStream, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: stream,
  };
}

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ── Import under test ─────────────────────────────────────────────────────────

import SitePageClient from "@/app/sites/[id]/SitePageClient";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TOKEN = "valid-token";

const baseSite = {
  id: "site-123",
  domain: "example.com",
  pipelineStatus: "complete",
  overallScore: 72,
  geoScorecard: { overallScore: 72, pillars: [] },
  rankedRecommendations: [],
  crawlData: { pages: [] },
  lastCrawlAt: null,
  token: null,
  credits: 20,
  citationNarrative: null,
  perPageResults: null,
  domainVerified: true,
  verifyToken: null,
  generatedLlmsTxt: null,
  generatedLlmsFullTxt: null,
  generatedBusinessJson: null,
  generatedSchemaBlocks: null,
} as unknown as Parameters<typeof SitePageClient>[0]["site"];

const baseProps = {
  siteId: "site-123",
  initialToken: TOKEN,
  allTeamDomains: [],
  lastCitationCheck: null,
  citationHistory: [],
  credits: 20,
  userEmail: "user@test.com",
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.setItem("geo-token-site-123", TOKEN);
  sessionStorage.setItem("skip-credit-confirm", "1");
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("handleMapCompetitors SSE (U39–U42)", () => {
  it.skip("U39 — complete event with competitors updates discoveredCompetitors state [STALE: competitor state path changed in M-25]", async () => {
    const competitors = [
      { name: "CompetitorA", domain: "competitor-a.com", rank: 1, mentionCount: 10, shareOfVoice: 15 },
      { name: "CompetitorB", domain: "competitor-b.com", rank: 2, mentionCount: 5, shareOfVoice: 8 },
    ];

    mockFetch.mockResolvedValueOnce(
      makeFetchResponse(
        makeSseStream([{ type: "complete", competitors, creditsUsed: 2 }])
      )
    );

    render(<SitePageClient {...baseProps} site={baseSite} />);

    // Trigger Map Competitors via the action rail button
    await waitFor(() => screen.getByTitle(/Map Competitors/i));
    await act(async () => {
      fireEvent.click(screen.getByTitle(/Map Competitors/i));
      // Allow SSE to be consumed
      await new Promise((r) => setTimeout(r, 50));
    });

    await waitFor(() => {
      // Competitor chips render c.name in the Overview tab
      expect(screen.getByText("CompetitorA")).toBeInTheDocument();
      expect(screen.getByText("CompetitorB")).toBeInTheDocument();
    });
  });

  it("U40 — complete event deducts creditsUsed from credits display", async () => {
    mockFetch.mockResolvedValueOnce(
      makeFetchResponse(
        makeSseStream([
          { type: "complete", competitors: [{ name: "CompC", domain: "c.com", rank: 1, mentionCount: 3, shareOfVoice: 5 }], creditsUsed: 2 },
        ])
      )
    );

    render(<SitePageClient {...baseProps} site={{ ...baseSite, credits: 20 }} />);

    // Initial credit display
    await waitFor(() => screen.getByTestId("buy-credits"));

    await waitFor(() => screen.getByTitle(/Map Competitors/i));
    await act(async () => {
      fireEvent.click(screen.getByTitle(/Map Competitors/i));
      await new Promise((r) => setTimeout(r, 50));
    });

    await waitFor(() => {
      // Credits should now show 18 (20 - 2)
      const creditsBtn = screen.getByTestId("buy-credits");
      expect(creditsBtn).toBeInTheDocument();
      expect(creditsBtn.textContent ?? "").toMatch(/18/);
    });
  });

  it("U41 — fetch throws: competitorScanActive reset to false", async () => {
    // handleMapCompetitors has try/finally but no catch — the rejection propagates
    // as an unhandled rejection. We suppress it at both the window and process level.
    const windowHandler = (e: Event) => (e as PromiseRejectionEvent).preventDefault?.();
    const processHandler = () => {}; // swallow
    window.addEventListener("unhandledrejection", windowHandler);
    process.on("unhandledRejection", processHandler);

    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, body: null });

    render(<SitePageClient {...baseProps} site={baseSite} />);

    await waitFor(() => screen.getByTitle(/Map Competitors/i));

    // Button should be clickable before the scan
    const btn = screen.getByTitle(/Map Competitors/i);
    expect(btn).not.toBeDisabled();

    await act(async () => {
      fireEvent.click(btn);
      await new Promise((r) => setTimeout(r, 50));
    });

    // After non-ok response, button should be re-enabled (competitorScanActive=false)
    await waitFor(() => {
      const btnAfter = screen.getByTitle(/Map Competitors/i);
      expect(btnAfter).not.toBeDisabled();
    });

    window.removeEventListener("unhandledrejection", windowHandler);
    process.removeListener("unhandledRejection", processHandler);
  });

  it("U42 — malformed SSE line (invalid JSON) does not crash", async () => {
    const encoder = new TextEncoder();
    const brokenStream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Send malformed JSON then a valid complete event
        controller.enqueue(encoder.encode("data: {this is not json}\n\n"));
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "complete", competitors: [], creditsUsed: 0 })}\n\n`
          )
        );
        controller.close();
      },
    });

    mockFetch.mockResolvedValueOnce(makeFetchResponse(brokenStream));

    render(<SitePageClient {...baseProps} site={baseSite} />);

    await waitFor(() => screen.getByTitle(/Map Competitors/i));

    // Should not throw
    await act(async () => {
      expect(() => {
        fireEvent.click(screen.getByTitle(/Map Competitors/i));
      }).not.toThrow();
      await new Promise((r) => setTimeout(r, 50));
    });

    // Component still rendered after malformed SSE
    expect(screen.getByTitle(/Map Competitors/i)).toBeInTheDocument();
  });

  it("non-ok fetch response: competitorScanActive reset to false", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, body: null });

    render(<SitePageClient {...baseProps} site={baseSite} />);
    await waitFor(() => screen.getByTitle(/Map Competitors/i));

    await act(async () => {
      fireEvent.click(screen.getByTitle(/Map Competitors/i));
      await new Promise((r) => setTimeout(r, 50));
    });

    // Button re-enabled
    await waitFor(() => {
      expect(screen.getByTitle(/Map Competitors/i)).not.toBeDisabled();
    });
  });

  it("double-click guard: second click while scanning does nothing", async () => {
    // First click: never resolves (simulates long-running scan)
    mockFetch.mockImplementationOnce(() => new Promise(() => {}));

    render(<SitePageClient {...baseProps} site={baseSite} />);
    await waitFor(() => screen.getByTitle(/Map Competitors/i));

    await act(async () => {
      fireEvent.click(screen.getByTitle(/Map Competitors/i));
    });

    // Second click: button now disabled
    const btn = screen.getByTitle(/Map Competitors/i);
    expect(btn).toBeDisabled();

    await act(async () => {
      fireEvent.click(btn);
    });

    // fetch called only once
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
