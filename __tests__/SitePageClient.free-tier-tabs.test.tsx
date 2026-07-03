/**
 * Setup tab — free-tier as sales surface (post-upsell rebuild).
 *
 * Asserts:
 *   - Free tier: Setup tab IS visible (restored — no longer hidden).
 *   - Free tier: FreeTierSetupUpsell component renders when tab is active.
 *   - Free tier: AI files list NOT rendered inside the Setup tab.
 *   - Free tier: All 4 customer-proof cards present.
 *   - Free tier: CTA is a button that opens UpgradeModal.
 *   - Paid tiers (starter/pro): Setup tab IS visible.
 *   - Paid tiers: FreeTierSetupUpsell NOT rendered.
 *   - Paid tiers: existing AI Files heading rendered.
 *
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";

afterEach(() => cleanup());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode; [key: string]: unknown }) =>
    <a href={href} {...props}>{children}</a>,
}));

vi.mock("@/app/components/UpgradeModal", () => ({ default: () => <div /> }));
vi.mock("@/app/components/chatbot/ChatWidget", () => ({ default: () => <div /> }));
vi.mock("@/app/dashboard/BuyCreditsButton", () => ({ default: () => <button>credits</button> }));
vi.mock("@/app/dashboard/SignOutButton", () => ({ default: () => <button>signout</button> }));
vi.mock("@/lib/hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));

vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));

import SitePageClient from "@/app/sites/[id]/SitePageClient";

const SITE_ID = "site-tabs-1";

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

// ── Helper: click the Setup tab button with React act ──────────────────────
async function clickSetupTab() {
  const setupTabBtn = screen.getByTestId("tab-setup");
  await act(async () => {
    fireEvent.click(setupTabBtn);
  });
}

describe("SitePageClient — Setup tab visibility (free-tier sales surface)", () => {

  // ── Free-tier assertions ──────────────────────────────────────────────────

  it("shows Setup tab button for free tier", () => {
    render(<SitePageClient {...baseProps} site={makeSite("free")} initialToken="tok-abc" />);
    const setupTab = screen.queryByTestId("tab-setup");
    expect(setupTab).not.toBeNull();
    expect(setupTab?.textContent).toBe("Setup");
  });

  it("renders FreeTierSetupUpsell for free tier when Setup tab is active", async () => {
    render(<SitePageClient {...baseProps} site={makeSite("free")} initialToken="tok-abc" />);
    await clickSetupTab();
    expect(screen.queryByTestId("free-tier-setup-upsell")).not.toBeNull();
  });

  it("does NOT render AI files accordion for free tier", async () => {
    render(<SitePageClient {...baseProps} site={makeSite("free")} initialToken="tok-abc" />);
    await clickSetupTab();
    // The upsell renders; the interactive AI file accordion items (llms-full.txt, business.json)
    // from the paid UI must not be present.
    expect(screen.queryAllByText("llms-full.txt").length).toBe(0);
    expect(screen.queryAllByText("business.json").length).toBe(0);
  });

  it("renders all 4 anonymized customer-proof cards for free tier", async () => {
    render(<SitePageClient {...baseProps} site={makeSite("free")} initialToken="tok-abc" />);
    await clickSetupTab();
    // Anonymized case studies only — never a real customer name (NDA).
    expect(screen.queryByTestId("proof-card-hospital-network")).not.toBeNull();
    expect(screen.queryByTestId("proof-card-consumer-brand")).not.toBeNull();
    expect(screen.queryByTestId("proof-card-local-business")).not.toBeNull();
    expect(screen.queryByTestId("proof-card-flowblinq-self")).not.toBeNull();
    // Regression guard: the removed named customers must NOT reappear.
    expect(screen.queryByTestId("proof-card-dennis-kirk")).toBeNull();
    expect(screen.queryByTestId("proof-card-swiss-beauty")).toBeNull();
    expect(screen.queryByTestId("proof-card-pcg-worldwide")).toBeNull();
  });

  it("CTA is a button that opens UpgradeModal for free tier", async () => {
    render(<SitePageClient {...baseProps} site={makeSite("free")} initialToken="tok-abc" />);
    await clickSetupTab();
    const cta = screen.queryByTestId("upgrade-cta") as HTMLButtonElement | null;
    expect(cta).not.toBeNull();
    expect(cta?.tagName).toBe("BUTTON");
    expect(cta?.getAttribute("href")).toBeNull();
  });

  // ── Paid-tier assertions ──────────────────────────────────────────────────

  it("shows Setup tab button for subscriptionTier=starter", () => {
    render(<SitePageClient {...baseProps} site={makeSite("starter")} initialToken="tok-abc" />);
    const setupTab = screen.queryByTestId("tab-setup");
    expect(setupTab).not.toBeNull();
    expect(setupTab?.textContent).toBe("Setup");
  });

  it("shows Setup tab button for subscriptionTier=pro", () => {
    render(<SitePageClient {...baseProps} site={makeSite("pro")} initialToken="tok-abc" />);
    expect(screen.queryByTestId("tab-setup")).not.toBeNull();
  });

  it("does NOT render FreeTierSetupUpsell for starter tier", async () => {
    render(<SitePageClient {...baseProps} site={makeSite("starter")} initialToken="tok-abc" />);
    await clickSetupTab();
    expect(screen.queryByTestId("free-tier-setup-upsell")).toBeNull();
  });

  it("renders AI Files heading for paid tier (pro)", async () => {
    render(<SitePageClient {...baseProps} site={makeSite("pro")} initialToken="tok-abc" />);
    await clickSetupTab();
    // The paid Setup tab has an "AI Files" section heading
    expect(screen.queryByText("AI Files")).not.toBeNull();
  });

  // ── Non-setup tabs still render for free tier ─────────────────────────────

  it.skip("shows all non-setup tabs for free tier [STALE: tab-scorecard/tab-recommendations consolidated into tab-action-plan]", () => {
    render(<SitePageClient {...baseProps} site={makeSite("free")} initialToken="tok-abc" />);
    expect(screen.queryByTestId("tab-overview")).not.toBeNull();
    expect(screen.queryByTestId("tab-scorecard")).not.toBeNull();
    expect(screen.queryByTestId("tab-recommendations")).not.toBeNull();
    expect(screen.queryByTestId("tab-history")).not.toBeNull();
  });
});
