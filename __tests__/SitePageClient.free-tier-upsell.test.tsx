/**
 * Fix #38 — SitePageClient: action buttons replaced with upsell pill for free-tier teams.
 *
 * Asserts:
 *   - With subscriptionTier="free": upsell link is rendered, action buttons are hidden.
 *   - With subscriptionTier="starter": action buttons are rendered, no upsell pill.
 *
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

afterEach(() => cleanup());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/app/components/UpgradeModal", () => ({ default: () => <div /> }));
vi.mock("@/app/components/chatbot/ChatWidget", () => ({ default: () => <div /> }));
vi.mock("@/app/dashboard/BuyCreditsButton", () => ({ default: () => <button>credits</button> }));
vi.mock("@/app/dashboard/SignOutButton", () => ({ default: () => <button>signout</button> }));
vi.mock("@/lib/hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));

vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));

import SitePageClient from "@/app/sites/[id]/SitePageClient";

const SITE_ID = "site-upsell-1";

function makeSite(subscriptionTier: string) {
  return {
    id: SITE_ID,
    domain: "example.com",
    pipelineStatus: "complete",
    geoScorecard: { overallScore: 55, pillars: [], topThreeImprovements: [] },
    rankedRecommendations: [],
    lastCrawlAt: "2026-04-28T00:00:00Z",
    token: "tok-abc",
    credits: subscriptionTier === "free" ? 0 : 20,
    tier: (subscriptionTier === "free" ? "free" : "paid") as "free" | "paid",
    subscriptionTier,
    citationNarrative: null,
    perPageResults: null,
    domainVerified: false,
    verifyToken: null,
    generatedLlmsTxt: null,
    generatedLlmsFullTxt: null,
    generatedBusinessJson: null,
    generatedSchemaBlocks: null,
  } as unknown as Parameters<typeof SitePageClient>[0]["site"];
}

const baseProps = {
  siteId: SITE_ID,
  allTeamDomains: [],
  lastCitationCheck: null,
  citationHistory: [],
  credits: 0,
};

beforeEach(() => {
  sessionStorage.setItem(`geo-token-${SITE_ID}`, "tok-abc");
});

describe("SitePageClient — action rail upsell for free tier (Fix #38)", () => {
  it("renders upsell button that opens UpgradeModal for free-tier teams", () => {
    render(<SitePageClient {...baseProps} site={makeSite("free")} initialToken="tok-abc" />);
    const upsell = screen.getByTestId("action-rail-upsell");
    expect(upsell).toBeDefined();
    expect(upsell.tagName).toBe("BUTTON");
    expect(upsell.getAttribute("href")).toBeNull();
  });

  it("does NOT render the upsell link for paid-tier (starter) teams", () => {
    render(<SitePageClient {...baseProps} site={makeSite("starter")} initialToken="tok-abc" />);
    const upsell = screen.queryByTestId("action-rail-upsell");
    expect(upsell).toBeNull();
  });

  it("renders action rail container for both tiers", () => {
    const { unmount } = render(<SitePageClient {...baseProps} site={makeSite("free")} initialToken="tok-abc" />);
    expect(screen.getByTestId("action-rail")).toBeDefined();
    unmount();

    render(<SitePageClient {...baseProps} site={makeSite("starter")} initialToken="tok-abc" />);
    expect(screen.getByTestId("action-rail")).toBeDefined();
  });
});
