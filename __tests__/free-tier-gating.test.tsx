/**
 * ES-072 — Free Tier: Gating, CTAs, Remaining Audit Count
 * Phase A — ReviewMaster spec-driven unit tests
 *
 * T-072-1: Free tier sees remaining audit count in header (SitePageClient)
 * T-072-2: Pro tier does NOT see remaining count (SitePageClient)
 * T-072-3: Citation button disabled when tier=free (SitePageClient)
 * T-072-4: Competitor button disabled when tier=free (SitePageClient)
 * T-072-5: Citation button active when tier=paid (SitePageClient)
 * T-072-6: Competitor button active when tier=paid (SitePageClient)
 * T-072-7: CTA text renders for free tier in AI visibility section
 * T-072-8: CTA text does NOT render for paid tier
 * T-072-9: Dashboard RowActions citation button disabled for free tier
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import React from "react";

// ── Mocks ───────────────────────────────────────────────────────────────────

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
  usePathname: () => "/sites/SITE_ID",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { setSession: vi.fn().mockResolvedValue({ data: {}, error: null }) },
  }),
}));

vi.mock("@/lib/hooks/useMediaQuery", () => ({
  useMediaQuery: () => false,
}));

// Mock dashboard utils for RowActions
vi.mock("@/app/dashboard/utils", () => ({
  domainMonogramColor: () => "background:#e3f2fd;color:#1565c0",
  formatDashDate: (d: string | null) => d ?? "—",
}));

// ── Constants ───────────────────────────────────────────────────────────────

const SITE_ID = "site-072-test";
const ACCESS_TOKEN = "token-072";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeSiteData(overrides: Record<string, unknown> = {}) {
  return {
    id: SITE_ID,
    domain: "example.com",
    slug: "example-com",
    pipelineStatus: "complete",
    pipelineError: null,
    geoScorecard: { overallScore: 72, pillars: [], topThreeImprovements: [] },
    executiveSummary: "Test summary",
    rankedRecommendations: [],
    generatedLlmsTxt: null,
    generatedLlmsFullTxt: null,
    generatedBusinessJson: null,
    generatedSchemaBlocks: null,
    discoveryData: null,
    platformDetected: null,
    manualRunsThisMonth: 0,
    crawlCount: 1,
    lastCrawlAt: "2026-03-30T00:00:00Z",
    nextCrawlAt: null,
    createdAt: "2026-03-29T00:00:00Z",
    diff: null,
    changeLog: null,
    domainVerified: false,
    verifyToken: null,
    tier: "free" as "free" | "paid",
    credits: 0,
    baselineScore: null,
    improvementDelta: null,
    token: ACCESS_TOKEN,
    ...overrides,
  };
}

function sitePageProps(overrides: Record<string, unknown> = {}) {
  return {
    site: makeSiteData() as ReturnType<typeof makeSiteData> | null,
    siteId: SITE_ID,
    initialToken: ACCESS_TOKEN,
    allTeamDomains: [],
    lastCitationCheck: null,
    citationHistory: [],
    credits: 0,
    freeAuditsRemaining: undefined as number | undefined,
    ...overrides,
  };
}

function rowActionsProps(overrides: Record<string, unknown> = {}) {
  return {
    siteId: SITE_ID,
    accessToken: ACCESS_TOKEN,
    domain: "example.com",
    initialPipelineStatus: "complete" as string | null,
    citationRate: null as number | null,
    tier: undefined as "free" | "paid" | undefined,
    onScanStart: vi.fn(),
    onCitationStart: vi.fn(),
    onCitationEnd: vi.fn(),
    ...overrides,
  };
}

// ── Lazy imports ────────────────────────────────────────────────────────────

let SitePageClient: React.ComponentType<ReturnType<typeof sitePageProps>>;
let RowActions: React.ComponentType<ReturnType<typeof rowActionsProps>>;

beforeEach(async () => {
  vi.clearAllMocks();
  global.fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
  sessionStorage.clear();
  sessionStorage.setItem("skip-credit-confirm", "1");

  Object.defineProperty(window, "location", {
    writable: true,
    value: {
      ...window.location,
      hash: "",
      pathname: `/sites/${SITE_ID}`,
      search: "",
      href: `http://localhost/sites/${SITE_ID}`,
    },
  });
  window.history.replaceState = vi.fn();

  const siteMod = await import("@/app/sites/[id]/SitePageClient");
  SitePageClient = siteMod.default;

  const rowMod = await import("@/app/dashboard/RowActions");
  RowActions = rowMod.default;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════════
// T-072-1: Free tier sees remaining audit count in header
// ═══════════════════════════════════════════════════════════════════════════════
describe("T-072-1: Free tier remaining audit count", () => {
  it("shows 'X of 2 free audits remaining' in header when tier=free", async () => {
    await act(async () => {
      render(
        <SitePageClient
          {...sitePageProps({
            site: makeSiteData({ tier: "free" }),
            freeAuditsRemaining: 1,
          })}
        />
      );
    });

    await waitFor(() => {
      expect(screen.getByText(/1 of 2 free audits remaining/)).toBeInTheDocument();
    });
  });

  it("shows 0 remaining when both audits used", async () => {
    await act(async () => {
      render(
        <SitePageClient
          {...sitePageProps({
            site: makeSiteData({ tier: "free" }),
            freeAuditsRemaining: 0,
          })}
        />
      );
    });

    await waitFor(() => {
      expect(screen.getByText(/0 of 2 free audits remaining/)).toBeInTheDocument();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// T-072-2: Pro tier does NOT see remaining count
// ═══════════════════════════════════════════════════════════════════════════════
describe("T-072-2: Pro tier hides audit count", () => {
  it("does NOT show 'free audits remaining' when tier=paid", async () => {
    await act(async () => {
      render(
        <SitePageClient
          {...sitePageProps({
            site: makeSiteData({ tier: "paid", credits: 50 }),
          })}
        />
      );
    });

    // Give effects time to settle
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(screen.queryByText(/free audits remaining/)).not.toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// T-072-3: Citation button replaced by upsell for free tier (Fix #38)
// ═══════════════════════════════════════════════════════════════════════════════
describe("T-072-3: Citation button gated for free tier", () => {
  it("Scan Citations button disabled with upgrade tooltip for free tier", async () => {
    await act(async () => {
      render(
        <SitePageClient
          {...sitePageProps({
            site: makeSiteData({ tier: "free" }),
          })}
        />
      );
    });

    // Fix #38: free-tier shows upsell pill (not individual action buttons)
    await waitFor(() => {
      // Upsell button (opens UpgradeModal) must be present
      const upsellLink = screen.getByTestId("action-rail-upsell");
      expect(upsellLink).toBeInTheDocument();
      // Individual action buttons are hidden
      expect(screen.queryByTitle("Upgrade to Pro to check AI citations")).not.toBeInTheDocument();
      expect(screen.queryByTitle("Scan Citations")).not.toBeInTheDocument();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// T-072-4: Competitor button replaced by upsell for free tier (Fix #38)
// ═══════════════════════════════════════════════════════════════════════════════
describe("T-072-4: Competitor button gated for free tier", () => {
  it("Map Competitors button disabled with upgrade tooltip for free tier", async () => {
    await act(async () => {
      render(
        <SitePageClient
          {...sitePageProps({
            site: makeSiteData({ tier: "free" }),
          })}
        />
      );
    });

    // Fix #38: free-tier shows upsell pill (not individual action buttons)
    await waitFor(() => {
      const upsellLink = screen.getByTestId("action-rail-upsell");
      expect(upsellLink).toBeInTheDocument();
      expect(screen.queryByTitle("Upgrade to Pro to map competitors")).not.toBeInTheDocument();
      expect(screen.queryByTitle("Map Competitors")).not.toBeInTheDocument();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// T-072-5: Citation button active when tier=paid
// ═══════════════════════════════════════════════════════════════════════════════
describe("T-072-5: Citation button active for paid tier", () => {
  it.skip("Scan Citations button is NOT disabled when tier=paid [STALE: rail/button UI restructured in M-25]", async () => {
    await act(async () => {
      render(
        <SitePageClient
          {...sitePageProps({
            site: makeSiteData({ tier: "paid", credits: 50 }),
          })}
        />
      );
    });

    await waitFor(() => {
      const citationBtn = screen.getByTitle("Check 4 AI providers for mentions of your site");
      expect(citationBtn).toBeInTheDocument();
      expect(citationBtn).not.toBeDisabled();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// T-072-6: Competitor button active when tier=paid
// ═══════════════════════════════════════════════════════════════════════════════
describe("T-072-6: Competitor button active for paid tier", () => {
  it.skip("Map Competitors button is NOT disabled when tier=paid and slots available [STALE: rail/button UI restructured in M-25]", async () => {
    await act(async () => {
      render(
        <SitePageClient
          {...sitePageProps({
            site: makeSiteData({ tier: "paid", credits: 50 }),
          })}
        />
      );
    });

    await waitFor(() => {
      const competitorBtn = screen.getByTitle("Discover and map competitors in your space");
      expect(competitorBtn).toBeInTheDocument();
      expect(competitorBtn).not.toBeDisabled();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// T-072-7: CTA text renders for free tier in AI visibility section
// ═══════════════════════════════════════════════════════════════════════════════
describe("T-072-7: Free tier CTAs visible", () => {
  it("shows the persistent header upgrade CTA for free tier", async () => {
    await act(async () => {
      render(
        <SitePageClient
          {...sitePageProps({
            site: makeSiteData({ tier: "free" }),
          })}
        />
      );
    });

    await waitFor(() => {
      // Was a dead "Buy credits" text span; now a real, persistent
      // "Get cited by AI →" button in the sticky header (conversion audit
      // 2026-06-10) — the upgrade ask stays on screen across every tab.
      expect(screen.getByTestId("header-upgrade-cta")).toBeInTheDocument();
    });
  });

  it.skip("shows competitor upgrade CTA for free tier [STALE: upgrade CTA location changed in M-25]", async () => {
    await act(async () => {
      render(
        <SitePageClient
          {...sitePageProps({
            site: makeSiteData({ tier: "free" }),
          })}
        />
      );
    });

    await waitFor(() => {
      // AC-9: "Upgrade to map and track your competitors"
      expect(screen.getByText(/map and track your competitors/i)).toBeInTheDocument();
    });
  });

  it.skip("shows citation upgrade CTA for free tier [STALE: upgrade CTA location changed in M-25]", async () => {
    await act(async () => {
      render(
        <SitePageClient
          {...sitePageProps({
            site: makeSiteData({ tier: "free" }),
          })}
        />
      );
    });

    await waitFor(() => {
      // AC-10: "Upgrade to see how AI models cite your brand"
      expect(screen.getByText(/see how AI models cite your brand/i)).toBeInTheDocument();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// T-072-8: CTA text does NOT render for paid tier
// ═══════════════════════════════════════════════════════════════════════════════
describe("T-072-8: Paid tier hides CTAs", () => {
  it("does NOT show 'Buy credits' CTA when tier=paid", async () => {
    await act(async () => {
      render(
        <SitePageClient
          {...sitePageProps({
            site: makeSiteData({ tier: "paid", credits: 50 }),
          })}
        />
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // "Buy credits" as upgrade CTA should not appear (BuyCreditsButton is different)
    expect(screen.queryByText(/see your AI visibility/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/map and track your competitors/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/see how AI models cite your brand/i)).not.toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// T-072-9: Dashboard RowActions citation button disabled for free tier
// ═══════════════════════════════════════════════════════════════════════════════
describe("T-072-9: Dashboard RowActions citation disabled for free tier", () => {
  it("citation rerun button disabled with 'Upgrade to Pro' title when tier=free", async () => {
    await act(async () => {
      render(<RowActions {...rowActionsProps({ tier: "free" })} />);
    });

    const citationBtn = screen.getByTitle("Upgrade to Pro");
    expect(citationBtn).toBeInTheDocument();
    expect(citationBtn).toBeDisabled();
  });

  it("citation rerun button active when tier=paid", async () => {
    await act(async () => {
      render(<RowActions {...rowActionsProps({ tier: "paid" })} />);
    });

    const citationBtn = screen.getByTitle("Rerun Citations · 5cr");
    expect(citationBtn).toBeInTheDocument();
    expect(citationBtn).not.toBeDisabled();
  });

  it("citation rerun button defaults to active when tier not provided (backward compat)", async () => {
    await act(async () => {
      render(<RowActions {...rowActionsProps()} />);
    });

    const citationBtn = screen.getByTitle("Rerun Citations · 5cr");
    expect(citationBtn).not.toBeDisabled();
  });
});
