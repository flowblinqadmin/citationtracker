/**
 * ES-wave-1 — SitePageClient.handleRefreshScore UT (AC-5).
 *
 * Asserts that on a 202 from POST /api/sites/:id/regenerate, the audit-page
 * Refresh Score handler:
 *   1. writes the new accessToken into sessionStorage
 *   2. updates the URL ?token query param via window.history.replaceState
 *   3. calls router.refresh() so sibling server components see the rotated token
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

vi.mock("@/app/components/citation-monitor", () => ({ CitationMonitor: () => <div /> }));
vi.mock("@/app/components/citation-analytics", () => ({ CitationAnalytics: () => <div /> }));
vi.mock("@/app/components/citation-history", () => ({ CitationHistory: () => <div /> }));
vi.mock("@/app/components/dimensional-intelligence", () => ({ DimensionalIntelligence: () => <div /> }));
vi.mock("@/app/components/upgrade-modal", () => ({ UpgradeModal: () => <div /> }));
vi.mock("@/app/components/UpgradeModal", () => ({ default: () => <div /> }));
vi.mock("@/app/components/chatbot/ChatWidget", () => ({ default: () => <div /> }));
vi.mock("@/app/dashboard/BuyCreditsButton", () => ({ default: () => <button>credits</button> }));
vi.mock("@/app/dashboard/SignOutButton", () => ({ default: () => <button>signout</button> }));
vi.mock("@/lib/hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));

import SitePageClient from "@/app/sites/[id]/SitePageClient";

const SITE_ID = "site-rs1";
const STORAGE_KEY = `geo-token-${SITE_ID}`;

function makeSite(token: string) {
  return {
    id: SITE_ID,
    domain: "example.com",
    pipelineStatus: "complete",
    geoScorecard: { overallScore: 72, pillars: [], topThreeImprovements: [] },
    rankedRecommendations: [],
    crawlData: { pages: [] },
    lastCrawlAt: "2026-04-26T00:00:00Z",
    token,
    credits: 20,
    citationNarrative: null,
    perPageResults: null,
    domainVerified: true,
    verifyToken: null,
    generatedLlmsTxt: null,
    generatedLlmsFullTxt: null,
    generatedBusinessJson: null,
    generatedSchemaBlocks: null,
    tier: "paid" as const,
  } as unknown as Parameters<typeof SitePageClient>[0]["site"];
}

const baseProps = {
  siteId: SITE_ID,
  allTeamDomains: [],
  lastCitationCheck: null,
  citationHistory: [],
  credits: 20,
  userEmail: "user@test.com",
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/sites/" + SITE_ID + "?token=oldtok");
});

describe("SitePageClient.handleRefreshScore — 202 path triggers token rotation + router.refresh (AC-5)", () => {
  it("on 202 with accessToken: sessionStorage updated, URL token param updated, router.refresh called", async () => {
    render(<SitePageClient {...baseProps} site={makeSite("oldtok")} initialToken="oldtok" />);

    // Wait for token bootstrap to settle — tokenReady=true gates polling.
    await waitFor(() => {
      expect(sessionStorage.getItem(STORAGE_KEY)).toBe("oldtok");
    });

    // Reset mockRefresh — bootstrap-side useEffects may have triggered a poll
    // that ends up calling router.refresh on pipeline complete (line ~234).
    // We only care about the refresh call from inside handleRefreshScore.
    mockRefresh.mockClear();
    mockFetch.mockReset();

    // Sequence of fetch responses: first the regenerate POST (202), then any
    // poll() GET that follows inside the 202 branch.
    mockFetch
      .mockResolvedValueOnce({
        status: 202,
        ok: true,
        json: async () => ({ accessToken: "newtok" }),
      })
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          ...makeSite("newtok"),
          pipelineStatus: "complete",
        }),
      });

    const refreshBtn = await screen.findByTitle(/Refresh Score/i);
    await act(async () => {
      fireEvent.click(refreshBtn);
    });

    await waitFor(() => {
      expect(sessionStorage.getItem(STORAGE_KEY)).toBe("newtok");
    });
    expect(window.location.search).toContain("token=newtok");
    await waitFor(() => {
      expect(mockRefresh).toHaveBeenCalled();
    });
  });
});
