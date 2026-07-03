/**
 * Unit tests — ActionSidebar
 * AS-01 through AS-10
 *
 * @vitest-environment jsdom
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import ActionSidebar from "@/app/sites/[id]/components/ActionSidebar";
import type { SiteActions } from "@/app/sites/[id]/hooks/useSiteActions";
import type { SiteDerivedData } from "@/app/sites/[id]/hooks/useSiteData";
import type { SiteData } from "@/app/sites/[id]/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock("@/lib/config", () => ({
  PAGES_PER_CREDIT: 20,
  ACTION_CREDITS: {
    shareOfVoice: 5,
    competitorMapping: 3,
    zipDownload: 1,
    pdfDownload: 2,
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSite(overrides: Partial<SiteData> = {}): SiteData {
  return {
    id: "site-1",
    domain: "example.com",
    slug: undefined,
    pipelineStatus: "complete",
    pipelineError: null,
    geoScorecard: null,
    executiveSummary: null,
    rankedRecommendations: [],
    projectedScore: null,
    projectedBoost: null,
    generatedLlmsTxt: null,
    generatedLlmsFullTxt: null,
    generatedBusinessJson: null,
    generatedSchemaBlocks: null,
    discoveryData: null,
    platformDetected: null,
    pageCount: 40,
    manualRunsThisMonth: null,
    crawlCount: null,
    lastCrawlAt: null,
    nextCrawlAt: null,
    createdAt: null,
    tier: "paid",
    credits: 100,
    baselineScore: null,
    improvementDelta: null,
    token: "test-token",
    crawlData: { pages: new Array(40).fill({ url: "https://example.com/page" }) },
    ...overrides,
  };
}

function makeData(overrides: Partial<SiteDerivedData> = {}): SiteDerivedData {
  return {
    scorecard: null,
    pillars: [],
    liveScore: null,
    pageCount: 40,
    criticalCount: 0,
    projectedScore: null,
    tierCounts: { Poor: 0, Weak: 0, Fair: 0, Good: 0 },
    recs: [],
    allPages: [],
    sortedPages: [],
    providerResults: [],
    providerAggregates: [],
    competitorData: [],
    visibleCompetitors: [],
    hiddenCompetitorCount: 0,
    totalMentions: 0,
    totalQueryCount: 0,
    citationRate: null,
    ourSOV: null,
    topCompetitor: null,
    hasSovSamples: false,
    pillarVisibility: {},
    geoVisibility: [],
    categoryVisibility: [],
    tierVisibility: [],
    changeLog: [],
    currentStageIndex: -1,
    pillarDisplayName: (id: string) => id,
    ...overrides,
  };
}

function makeActions(overrides: Partial<SiteActions> = {}): SiteActions {
  return {
    handleEmailAuth: vi.fn(),
    email: "",
    setEmail: vi.fn(),
    authLoading: false,
    authError: null,
    emailInputRef: { current: null },

    handleRefreshScore: vi.fn(),
    retrying: false,
    refreshError: null,

    handleScanCitations: vi.fn(),
    citationScanActive: false,

    handleMapCompetitors: vi.fn(),
    competitorScanActive: false,
    handleAddCompetitor: vi.fn(),
    handleRemoveCompetitor: vi.fn(),
    addCompetitorName: "",
    setAddCompetitorName: vi.fn(),
    addCompetitorLoading: false,
    addCompetitorError: null,
    addCompetitorDomain: "",
    setAddCompetitorDomain: vi.fn(),
    showDomainInput: false,
    setShowDomainInput: vi.fn(),

    handleDownloadZip: vi.fn(),
    downloadError: null,

    handleTestConnection: vi.fn(),
    testingConnection: false,
    connectionResult: null,

    handleOtherPlatform: vi.fn(),
    otherPlatform: "",
    setOtherPlatform: vi.fn(),
    otherConfig: "",
    otherLoading: false,
    otherError: "",

    ...overrides,
  };
}

interface RenderSidebarOptions {
  site?: SiteData;
  data?: Partial<SiteDerivedData>;
  actions?: Partial<SiteActions>;
  credits?: number;
  slotsRemaining?: number;
  lastCitationCheck?: unknown;
}

function renderSidebar(opts: RenderSidebarOptions = {}) {
  const site = opts.site ?? makeSite();
  const data = makeData(opts.data ?? {});
  const actions = makeActions(opts.actions ?? {});

  return render(
    <ActionSidebar
      site={site}
      data={data}
      actions={actions}
      isMobile={false}
      credits={opts.credits ?? 100}
      slotsRemaining={opts.slotsRemaining ?? 6}
      siteId="site-1"
      token="test-token"
      poll={vi.fn().mockResolvedValue(undefined)}
      lastCitationCheck={opts.lastCitationCheck ?? null}
    />
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ActionSidebar", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
  });

  // AS-01: auditCost = Math.ceil(40/20) = 2 for 40 pages
  it("AS-01: auditCost = 2 for 40 pages (Math.ceil(40/20))", () => {
    renderSidebar({ data: { pageCount: 40 } });
    // The Refresh Score button contains the auditCost badge "{auditCost}cr".
    // Other buttons show their own static credit costs, so we scope to the
    // Refresh Score button to avoid "found multiple elements" ambiguity.
    const buttons = screen.getAllByRole("button");
    const refreshBtn = buttons.find((b) => b.textContent?.includes("Refresh Score"));
    expect(refreshBtn).toBeDefined();
    expect(refreshBtn!.textContent).toContain("2cr");
  });

  // AS-02: auditCost = 1 for 0 pages (Math.max(1, ...))
  it("AS-02: auditCost = 1 for 0 pages (Math.max floor)", () => {
    renderSidebar({ data: { pageCount: 0 } });
    // Math.max(1, Math.ceil(0/20)) = Math.max(1, 0) = 1
    const buttons = screen.getAllByRole("button");
    const refreshBtn = buttons.find((b) => b.textContent?.includes("Refresh Score"));
    expect(refreshBtn).toBeDefined();
    expect(refreshBtn!.textContent).toContain("1cr");
  });

  // AS-03: auditCost = 1 for undefined crawlData (pageCount defaults to 10 in component)
  it("AS-03: auditCost = 1 for undefined pageCount (defaults to 10 in component)", () => {
    // data.pageCount = undefined-ish; component uses `data.pageCount || 10`
    // Math.ceil(10/20) = 1, Math.max(1, 1) = 1
    renderSidebar({ data: { pageCount: undefined as unknown as number } });
    const buttons = screen.getAllByRole("button");
    const refreshBtn = buttons.find((b) => b.textContent?.includes("Refresh Score"));
    expect(refreshBtn).toBeDefined();
    expect(refreshBtn!.textContent).toContain("1cr");
  });

  // AS-04: Scan Citations disabled on free tier
  it("AS-04: Scan Citations button is disabled on free tier", () => {
    renderSidebar({ site: makeSite({ tier: "free" }) });
    // Find the button by its label text inside it
    const buttons = screen.getAllByRole("button");
    const citationsBtn = buttons.find(
      (b) => b.textContent?.includes("Scan Citations")
    );
    expect(citationsBtn).toBeDefined();
    expect(citationsBtn).toBeDisabled();
  });

  // AS-05: Map Competitors disabled on free tier
  it("AS-05: Map Competitors button is disabled on free tier", () => {
    renderSidebar({ site: makeSite({ tier: "free" }) });
    const buttons = screen.getAllByRole("button");
    const competitorBtn = buttons.find(
      (b) => b.textContent?.includes("Map Competitors")
    );
    expect(competitorBtn).toBeDefined();
    expect(competitorBtn).toBeDisabled();
  });

  // AS-06: Map Competitors disabled when slotsRemaining === 0
  it("AS-06: Map Competitors button is disabled when slotsRemaining === 0", () => {
    renderSidebar({ slotsRemaining: 0 });
    const buttons = screen.getAllByRole("button");
    const competitorBtn = buttons.find(
      (b) => b.textContent?.includes("Map Competitors")
    );
    expect(competitorBtn).toBeDefined();
    expect(competitorBtn).toBeDisabled();
  });

  // AS-07: skip flag set → clicking Refresh Score calls handleRefreshScore directly
  it("AS-07: skip flag → clicking Refresh Score calls handler directly (no modal)", () => {
    sessionStorage.setItem("skip-credit-confirm", "1");
    const handleRefreshScore = vi.fn();
    renderSidebar({ actions: { handleRefreshScore } });

    const buttons = screen.getAllByRole("button");
    const refreshBtn = buttons.find((b) => b.textContent?.includes("Refresh Score"));
    expect(refreshBtn).toBeDefined();
    fireEvent.click(refreshBtn!);

    expect(handleRefreshScore).toHaveBeenCalledOnce();
    // No modal should appear
    expect(document.body.querySelector('[style*="position: fixed"][style*="inset: 0"]')).toBeNull();
  });

  // AS-08: skip flag absent → clicking Refresh Score shows ConfirmCreditModal
  it("AS-08: no skip flag → clicking Refresh Score shows ConfirmCreditModal", () => {
    renderSidebar();

    const buttons = screen.getAllByRole("button");
    const refreshBtn = buttons.find((b) => b.textContent?.includes("Refresh Score"));
    expect(refreshBtn).toBeDefined();
    fireEvent.click(refreshBtn!);

    // ConfirmCreditModal portals into document.body — look for the Proceed button
    expect(screen.getByRole("button", { name: /proceed/i })).toBeInTheDocument();
  });

  // AS-09: confirm in modal calls the handler
  it("AS-09: confirming modal calls handleRefreshScore and dismisses modal", () => {
    const handleRefreshScore = vi.fn();
    renderSidebar({ actions: { handleRefreshScore } });

    const buttons = screen.getAllByRole("button");
    const refreshBtn = buttons.find((b) => b.textContent?.includes("Refresh Score"));
    fireEvent.click(refreshBtn!);

    // Modal is open — click Proceed
    const proceedBtn = screen.getByRole("button", { name: /proceed/i });
    fireEvent.click(proceedBtn);

    expect(handleRefreshScore).toHaveBeenCalledOnce();
    // Modal should be gone after confirmation
    expect(screen.queryByRole("button", { name: /proceed/i })).toBeNull();
  });

  // AS-10: cancel in modal dismisses without calling handler
  it("AS-10: cancelling modal dismisses without calling handleRefreshScore", () => {
    const handleRefreshScore = vi.fn();
    renderSidebar({ actions: { handleRefreshScore } });

    const buttons = screen.getAllByRole("button");
    const refreshBtn = buttons.find((b) => b.textContent?.includes("Refresh Score"));
    fireEvent.click(refreshBtn!);

    // Modal is open — click Cancel
    const cancelBtn = screen.getByRole("button", { name: /cancel/i });
    fireEvent.click(cancelBtn);

    expect(handleRefreshScore).not.toHaveBeenCalled();
    // Modal should be gone
    expect(screen.queryByRole("button", { name: /proceed/i })).toBeNull();
  });
});
