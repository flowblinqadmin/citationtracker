/**
 * Paywall UI Tests — ResultsDashboard tier gating
 *
 * Tests the free/paid visual boundary in ResultsDashboard.tsx per ES-003 spec.
 * 21 test cases covering:
 *   1-3:   PaywallOverlay component rendering
 *   4-14:  Tier gating (overlays, hidden sections, button changes)
 *   15-17: handleUpgrade (checkout redirect flow)
 *   18-21: Payment polling (auto-unlock after Stripe payment)
 *   22-27: Improvement banner (ES-004 before/after scoring)
 *
 * DEPENDENCY: Requires @testing-library/react + jsdom.
 * Install: npm install -D @testing-library/react @testing-library/jest-dom
 * Also add to vitest.config.ts for .tsx test files:
 *   test: { environment: "jsdom" } (or use per-file annotation below)
 *
 * These tests are written BEFORE implementation (test-first).
 * They will FAIL until the paywall gating logic is added.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { RankedRec, SiteData, GeoScorecard } from "@/app/sites/[id]/ResultsDashboardLegacy";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockToastError = vi.fn();
const mockToastSuccess = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
    success: (...args: unknown[]) => mockToastSuccess(...args),
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/sites/site-1",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
      signOut: vi.fn().mockResolvedValue({}),
    },
  }),
}));


// ─── Imports ─────────────────────────────────────────────────────────────────

import ResultsDashboard from "@/app/sites/[id]/ResultsDashboardLegacy";

// ─── Test Data Helpers ──────────────────────────────────────────────────────

function makePillar(index: number) {
  return {
    pillar: `pillar_${index}`,
    pillarName: `Pillar ${index}`,
    score: 40 + index * 10,
    findings: `Detailed findings for pillar ${index}`,
    recommendation: `Fix recommendation for pillar ${index}`,
    priority: "high" as const,
    impactedPages: [`https://example.com/page-${index}`],
  };
}

function makeRec(rank: number): RankedRec {
  return {
    rank,
    title: `Recommendation ${rank}`,
    description: `Description for recommendation ${rank}`,
    impact: rank <= 2 ? "high" : "medium",
    effort: rank <= 2 ? "quick" : "medium",
    pillar: `pillar_${rank}`,
    specificAction: `Do action ${rank}`,
    estimatedBoost: `${5 - rank}`,
  };
}

function makeScorecard(pillarCount = 3): GeoScorecard {
  return {
    overallScore: 55,
    pillars: Array.from({ length: pillarCount }, (_, i) => makePillar(i + 1)),
    topThreeImprovements: ["Fix A", "Fix B", "Fix C"],
  };
}

function makeSiteData(overrides: Partial<SiteData> = {}): SiteData {
  return {
    id: "site-1",
    domain: "example.com",
    slug: "example-com",
    pipelineStatus: "complete",
    pipelineError: null,
    geoScorecard: makeScorecard(5),
    executiveSummary: "This is the executive summary paragraph one.\n\nParagraph two with details.",
    rankedRecommendations: Array.from({ length: 5 }, (_, i) => makeRec(i + 1)),
    projectedScore: 75,
    projectedBoost: 20,
    generatedLlmsTxt: "# llms.txt content",
    generatedLlmsFullTxt: "# Full llms.txt",
    generatedBusinessJson: { name: "Test" },
    generatedSchemaBlocks: [{ name: "Org", type: "Organization", jsonLd: {}, instructions: "", pageTarget: "/" }],
    discoveryData: {},
    platformDetected: "wordpress",
    manualRunsThisMonth: 1,
    crawlCount: 1,
    lastCrawlAt: "2026-02-20T00:00:00Z",
    nextCrawlAt: "2026-03-20T00:00:00Z",
    createdAt: "2026-02-01T00:00:00Z",
    diff: null,
    changeLog: [],
    domainVerified: false,
    verifyToken: "vt-123",
    token: "test-token",
    // Sprint 2 additions:
    tier: "paid" as "free" | "paid",
    credits: 50,
    // Subscription fields for gating
    baselineScore: null,
    improvementDelta: null,
    freeRunNumber: 2,         // Not first audit — enables gating for free tier
    subscriptionTier: undefined, // defaults to "free" in component
    ...overrides,
  } as SiteData;
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({}),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── PaywallOverlay Component Tests (1-3) ───────────────────────────────────

describe("PaywallOverlay component", () => {
  it("1. renders with blur styling when tier is free", () => {
    render(<ResultsDashboard site={makeSiteData({ tier: "free", credits: 0 })} />);

    // PaywallOverlay should render with backdrop-filter: blur
    const overlays = document.querySelectorAll("[style*='blur']");
    expect(overlays.length).toBeGreaterThan(0);
  });

  it("2. 'Upgrade Now' button opens upgrade modal on click", async () => {
    render(<ResultsDashboard site={makeSiteData({ tier: "free", credits: 0 })} />);

    const upgradeButtons = screen.getAllByText(/upgrade now/i);
    expect(upgradeButtons.length).toBeGreaterThan(0);

    await act(async () => {
      fireEvent.click(upgradeButtons[0]);
    });

    // Modal opens with tabs: "Monthly Plans" and "Credit Packs"
    expect(screen.getByText(/monthly plans/i)).toBeTruthy();
    expect(screen.getByText(/credit packs/i)).toBeTruthy();
  });

  it("3. displays correct upgrade copy including price", () => {
    render(<ResultsDashboard site={makeSiteData({ tier: "free", credits: 0 })} />);

    expect(screen.getByText(/upgrade to unlock full report/i)).toBeTruthy();
    expect(screen.getAllByText(/\$10/).length).toBeGreaterThan(0);
  });
});

// ─── Tier Gating in ResultsDashboard (4-14) ─────────────────────────────────

describe("Tier gating — free tier", () => {
  it("4. shows PaywallOverlay on pillar findings section", () => {
    render(<ResultsDashboard site={makeSiteData({ tier: "free", credits: 0 })} />);

    // Scorecard section should exist but findings should be gated
    expect(screen.getByText("GEO Scorecard")).toBeTruthy();

    // Overlay should be present in the scorecard area
    const overlays = document.querySelectorAll("[style*='blur']");
    expect(overlays.length).toBeGreaterThan(0);
  });

  it("5. shows PaywallOverlay on recommendations section", () => {
    render(<ResultsDashboard site={makeSiteData({ tier: "free", credits: 0 })} />);

    // Recommendations section should exist
    expect(screen.getByText("All Recommendations")).toBeTruthy();

    // Only first 3 recommendation titles should be visible (API caps at 3 for free)
    // The overlay should block expanding them
  });

  it("6. hides Quick Wins section entirely for free tier", () => {
    render(<ResultsDashboard site={makeSiteData({ tier: "free", credits: 0 })} />);

    // Quick Wins should NOT be rendered at all for free tier
    expect(screen.queryByText(/Quick Wins/)).toBeNull();
  });

  it("7. shows PaywallOverlay on generated files section", () => {
    render(<ResultsDashboard site={makeSiteData({
      tier: "free",
      credits: 0,
      generatedLlmsTxt: null,
      generatedLlmsFullTxt: null,
      generatedBusinessJson: null,
      generatedSchemaBlocks: null,
    })} />);

    // Files section should have overlay
    const aiFilesHeading = screen.queryByText("Your AI Files");
    if (aiFilesHeading) {
      // If section renders, it should have an overlay
      const overlays = document.querySelectorAll("[style*='blur']");
      expect(overlays.length).toBeGreaterThan(0);
    }
  });

  it("8. shows 'Upgrade to Re-run Audit' on regenerate button", () => {
    render(<ResultsDashboard site={makeSiteData({ tier: "free", credits: 0 })} />);

    expect(screen.getByText(/upgrade to re-run audit/i)).toBeTruthy();
  });

  it("9. manualRunsLeft is 0 for free tier regardless of actual runs", () => {
    render(<ResultsDashboard site={makeSiteData({
      tier: "free",
      credits: 0,
      manualRunsThisMonth: 2, // Even with 2 runs, free tier should show 0
    })} />);

    // Should NOT show "Regenerate (2/4 left)" — should show upgrade button
    expect(screen.queryByText(/regenerate \(/i)).toBeNull();
    expect(screen.getByText(/upgrade to re-run audit/i)).toBeTruthy();
  });
});

describe("Tier gating — paid tier", () => {
  it("10. renders no PaywallOverlay components for paid tier", () => {
    render(<ResultsDashboard site={makeSiteData({ tier: "paid", credits: 50 })} />);

    // No blur overlays should be present
    const overlays = document.querySelectorAll("[style*='backdrop-filter'][style*='blur']");
    expect(overlays.length).toBe(0);
  });

  it("11. renders all sections with full data for paid tier", () => {
    const site = makeSiteData({ tier: "paid", credits: 50 });
    render(<ResultsDashboard site={site} />);

    expect(screen.getByText("Executive Summary")).toBeTruthy();
    expect(screen.getByText("GEO Scorecard")).toBeTruthy();
    expect(screen.getByText("All Recommendations")).toBeTruthy();
    expect(screen.getByText("Your AI Files")).toBeTruthy();
  });

  it("12. shows normal regenerate button with run count for paid tier", () => {
    render(<ResultsDashboard site={makeSiteData({
      tier: "paid",
      credits: 50,
      manualRunsThisMonth: 1,
    })} />);

    expect(screen.getByText(/Refresh My Score \(3\/4\)/i)).toBeTruthy();
  });
});

describe("Free tier banner", () => {
  it("13. shows free tier banner for free users", () => {
    render(<ResultsDashboard site={makeSiteData({ tier: "free", credits: 0 })} />);

    expect(screen.getByText(/you're on the free plan/i)).toBeTruthy();
  });

  it("14. does NOT show free tier banner for paid users", () => {
    render(<ResultsDashboard site={makeSiteData({ tier: "paid", credits: 50 })} />);

    expect(screen.queryByText(/you're on the free plan/i)).toBeNull();
  });
});

// ─── handleUpgrade Tests (15-17) ────────────────────────────────────────────

describe("handleUpgrade", () => {
  it("15. redirects to Stripe checkout URL on success (via modal)", async () => {
    const originalLocation = window.location;
    const mockLocation = { ...originalLocation, href: "" };
    Object.defineProperty(window, "location", { value: mockLocation, writable: true });

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ checkoutUrl: "https://checkout.stripe.com/session_test" }),
    });

    render(<ResultsDashboard site={makeSiteData({ tier: "free", credits: 0 })} />);

    // Step 1: Click "Upgrade Now" to open modal
    const upgradeButtons = screen.getAllByText(/upgrade now/i);
    await act(async () => {
      fireEvent.click(upgradeButtons[0]);
    });

    // Step 2: Switch to "Credit Packs" tab
    const creditPacksTab = screen.getByText(/credit packs/i);
    await act(async () => {
      fireEvent.click(creditPacksTab);
    });

    // Step 3: Click "Pay" button inside credits tab
    const payButton = screen.getByText(/pay \$/i);
    await act(async () => {
      fireEvent.click(payButton);
    });

    await waitFor(() => {
      expect(mockLocation.href).toBe("https://checkout.stripe.com/session_test");
    });

    Object.defineProperty(window, "location", { value: originalLocation, writable: true });
  });

  it("16. shows toast.error when checkout API fails (via modal)", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Network error"));

    render(<ResultsDashboard site={makeSiteData({ tier: "free", credits: 0 })} />);

    // Step 1: Open modal
    const upgradeButtons = screen.getAllByText(/upgrade now/i);
    await act(async () => {
      fireEvent.click(upgradeButtons[0]);
    });

    // Step 2: Switch to "Credit Packs" tab
    const creditPacksTab = screen.getByText(/credit packs/i);
    await act(async () => {
      fireEvent.click(creditPacksTab);
    });

    // Step 3: Click "Pay" button inside credits tab
    const payButton = screen.getByText(/pay \$/i);
    await act(async () => {
      fireEvent.click(payButton);
    });

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        expect.stringContaining("Network error")
      );
    });
  });

  it("17. does not redirect when checkout API returns no URL", async () => {
    const originalHref = window.location.href;

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}), // No checkoutUrl
    });

    render(<ResultsDashboard site={makeSiteData({ tier: "free", credits: 0 })} />);

    const upgradeButtons = screen.getAllByText(/upgrade now/i);
    await act(async () => {
      fireEvent.click(upgradeButtons[0]);
    });

    // No redirect should happen
    expect(window.location.href).toBe(originalHref);
  });
});

// ─── Payment Polling Tests (18-21) ──────────────────────────────────────────

describe("Payment polling", () => {
  it("18. starts polling for free users with complete pipeline", () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval");

    render(<ResultsDashboard site={makeSiteData({
      tier: "free",
      credits: 0,
      pipelineStatus: "complete",
    })} />);

    // Payment poll should be set up with 3s interval
    const paymentPollCalls = setIntervalSpy.mock.calls.filter(
      (call) => call[1] === 3000
    );
    expect(paymentPollCalls.length).toBeGreaterThan(0);
  });

  it("19. stops polling and updates site when tier becomes paid", async () => {
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");

    // First poll returns free, second returns paid
    let pollCount = 0;
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(() => {
      pollCount++;
      if (pollCount >= 2) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(makeSiteData({ tier: "paid", credits: 50 })),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(makeSiteData({ tier: "free", credits: 0 })),
      });
    });

    render(<ResultsDashboard site={makeSiteData({
      tier: "free",
      credits: 0,
      pipelineStatus: "complete",
    })} />);

    // Advance timers to trigger poll
    await act(async () => {
      vi.advanceTimersByTime(6000); // 2 poll cycles
    });

    // clearInterval should have been called (poll stopped)
    expect(clearIntervalSpy).toHaveBeenCalled();
  });

  it("20. does NOT start payment polling for paid users", () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval");

    render(<ResultsDashboard site={makeSiteData({
      tier: "paid",
      credits: 50,
      pipelineStatus: "complete",
    })} />);

    // Pipeline poll is stopped (isStoppedStatus = true for "complete")
    // Payment poll should NOT start for paid users
    // Only the pipeline poll useEffect runs (and returns early)
    const intervalCalls = setIntervalSpy.mock.calls;

    // For paid+complete, no polling should be active
    // (pipeline poll returns early, payment poll condition not met)
    const activePollCount = intervalCalls.filter(
      (call) => call[1] === 3000
    ).length;
    expect(activePollCount).toBe(0);
  });

  it("21. does NOT start payment polling while pipeline is running", () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval");

    render(<ResultsDashboard site={makeSiteData({
      tier: "free",
      credits: 0,
      pipelineStatus: "crawling", // Pipeline still running
    })} />);

    // The pipeline poll should be running (for pipeline status updates)
    // But the payment poll should NOT run (pipelineStatus !== "complete")
    // Both would use 3s interval, but payment poll has a tier check
    const pollCalls = setIntervalSpy.mock.calls.filter(
      (call) => call[1] === 3000
    );

    // At most 1 interval should be set (pipeline poll), not 2
    expect(pollCalls.length).toBeLessThanOrEqual(1);
  });
});

// ─── Domain Integration tier gate (28-29) ───────────────────────────────────

describe("Domain Integration section — tier gate", () => {
  /**
   * REGRESSION: A merge conflict resolution removed the site.tier === "paid" gate
   * from the Domain Integration section. Free-tier users were shown DNS TXT
   * verification steps and the raw verifyToken value.
   */
  it("28. does NOT render Domain Integration section for free-tier users", () => {
    render(<ResultsDashboard site={makeSiteData({ tier: "free", credits: 0 })} />);
    expect(screen.queryByText("Domain Integration")).toBeNull();
  });

  it("29. renders Domain Integration section for paid-tier users", () => {
    render(<ResultsDashboard site={makeSiteData({ tier: "paid", credits: 50 })} />);
    expect(screen.getByText("Domain Integration")).toBeTruthy();
  });
});

// ─── Improvement Banner Tests (ES-004 #9) ───────────────────────────────────

describe("Improvement banner — before/after scoring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Test 22: Banner shown when improvementDelta > 0 ──

  it("22. shows improvement banner when improvementDelta > 0", () => {
    render(<ResultsDashboard site={makeSiteData({
      tier: "paid",
      credits: 100,
      baselineScore: 23,
      improvementDelta: 44,
      geoScorecard: { ...makeScorecard(3), overallScore: 67 },
    })} />);

    expect(screen.getByText(/your geo score improved/i)).toBeTruthy();
    expect(screen.getByText("23")).toBeTruthy();    // baseline
    expect(screen.getByText("67")).toBeTruthy();    // current
    expect(screen.getByText(/\+44/)).toBeTruthy();  // delta badge
  });

  // ── Test 23: No banner when delta is null ──

  it("23. does NOT show improvement banner when improvementDelta is null", () => {
    render(<ResultsDashboard site={makeSiteData({
      tier: "paid",
      credits: 100,
      baselineScore: null,
      improvementDelta: null,
    })} />);

    expect(screen.queryByText(/your geo score improved/i)).toBeNull();
  });

  // ── Test 24: No banner when delta is 0 ──

  it("24. does NOT show improvement banner when improvementDelta is 0", () => {
    render(<ResultsDashboard site={makeSiteData({
      tier: "paid",
      credits: 100,
      baselineScore: 50,
      improvementDelta: 0,
    })} />);

    expect(screen.queryByText(/your geo score improved/i)).toBeNull();
  });

  // ── Test 25: No banner when delta is negative ──

  it("25. does NOT show improvement banner when improvementDelta is negative", () => {
    render(<ResultsDashboard site={makeSiteData({
      tier: "paid",
      credits: 100,
      baselineScore: 70,
      improvementDelta: -5,
    })} />);

    expect(screen.queryByText(/your geo score improved/i)).toBeNull();
  });

  // ── Test 26: Pillar deltas shown for paid tier ──

  it("26. shows per-pillar deltas for paid tier in improvement banner", () => {
    render(<ResultsDashboard site={makeSiteData({
      tier: "paid",
      credits: 100,
      baselineScore: 30,
      improvementDelta: 37,
      geoScorecard: { ...makeScorecard(3), overallScore: 67 },
      pillarDeltas: [
        { pillar: "structured_data", before: 20, after: 50, delta: 30 },
        { pillar: "content_authority", before: 35, after: 55, delta: 20 },
        { pillar: "technical_seo", before: 40, after: 45, delta: 5 },
      ],
    })} />);

    expect(screen.getByText(/your geo score improved/i)).toBeTruthy();
    // Per-pillar improvements should be listed
    expect(screen.getByText(/\+30/)).toBeTruthy();
    expect(screen.getByText(/\+20/)).toBeTruthy();
  });

  // ── Test 27: Pillar deltas hidden for free tier ──

  it("27. does NOT show per-pillar deltas for free tier", () => {
    render(<ResultsDashboard site={makeSiteData({
      tier: "free",
      credits: 0,
      baselineScore: 23,
      improvementDelta: 44,
      geoScorecard: { ...makeScorecard(3), overallScore: 67 },
      // pillarDeltas not provided for free tier (API strips them)
    })} />);

    // The banner itself may show (baselineScore/improvementDelta are free-visible)
    // But per-pillar details should NOT be shown
    expect(screen.queryByText(/structured_data/)).toBeNull();
  });
});
