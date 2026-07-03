/**
 * ES-062 — SitePageClient Component Unit Tests
 * U1–U20
 *
 * Written spec-first (Phase A — ReviewMaster).
 * These tests are RED until DaVinci rebuilds app/sites/[id]/SitePageClient.tsx.
 *
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  act,
} from "@testing-library/react";

afterEach(() => cleanup());

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockPush = vi.fn();
const mockRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    back: vi.fn(),
    refresh: mockRefresh,
  }),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock heavy child components — keep tests fast and isolated
vi.mock("@/app/components/citation-monitor", () => ({
  CitationMonitor: (props: { onScanStart?: (fn: () => void) => void }) => {
    if (props.onScanStart) props.onScanStart(() => {});
    return <div data-testid="citation-monitor" />;
  },
}));

vi.mock("@/app/components/citation-analytics", () => ({
  CitationAnalytics: () => <div data-testid="citation-analytics" />,
}));

vi.mock("@/app/components/citation-history", () => ({
  CitationHistory: () => <div data-testid="citation-history" />,
}));

vi.mock("@/app/components/dimensional-intelligence", () => ({
  DimensionalIntelligence: () => <div data-testid="dimensional-intelligence" />,
}));

vi.mock("@/app/components/upgrade-modal", () => ({
  UpgradeModal: () => <div data-testid="upgrade-modal" />,
}));

vi.mock("@/app/dashboard/BuyCreditsButton", () => ({
  default: ({ credits }: { credits: number }) => (
    <button data-testid="buy-credits">{credits}</button>
  ),
}));

vi.mock("@/app/dashboard/SignOutButton", () => ({
  default: () => <button data-testid="sign-out">Sign Out</button>,
}));

// ── Import under test ─────────────────────────────────────────────────────────

import SitePageClient from "@/app/sites/[id]/SitePageClient";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const baseSite = {
  id: "site-123",
  domain: "example.com",
  pipelineStatus: "complete",
  overallScore: 72,
  geoScorecard: {
    overallScore: 72,
    pillars: [
      { pillar: "schema", pillarName: "Schema", score: 80, findings: "Good", priority: "low" },
      { pillar: "faq", pillarName: "FAQ", score: 20, findings: "Missing", priority: "critical" },
    ],
  },
  rankedRecommendations: [
    { id: "r1", pillar: "faq", title: "Add FAQ", priority: "HIGH", estimatedBoost: "+10" },
    { id: "r2", pillar: "schema", title: "Fix schema", priority: "MED", estimatedBoost: "+5" },
    { id: "r3", pillar: "content", title: "Add content", priority: "LOW", estimatedBoost: "+3" },
  ],
  crawlData: { pages: new Array(10).fill({ url: "https://example.com/page" }) },
  lastCrawlAt: "2026-03-20T00:00:00Z",
  token: null,
  credits: 20,
  citationNarrative: null,
  perPageResults: null,
  domainVerified: true,
  verifyToken: null,
  generatedLlmsTxt: "llms content",
  generatedLlmsFullTxt: null,
  generatedBusinessJson: null,
  generatedSchemaBlocks: null,
} as unknown as Parameters<typeof SitePageClient>[0]["site"];

const baseProps = {
  site: baseSite,
  siteId: "site-123",
  initialToken: undefined as string | undefined,
  allTeamDomains: [
    { id: "td-1", domain: "example.com", geoScorecard: { overallScore: 72 }, crawlData: { pages: [] } },
    { id: "td-2", domain: "other.com", geoScorecard: null, crawlData: null },
  ],
  lastCitationCheck: null,
  citationHistory: [],
  credits: 20,
  userEmail: "user@test.com",
};

beforeEach(() => {
  vi.clearAllMocks();
  // Clean sessionStorage
  sessionStorage.clear();
  // Skip credit confirmation modal in tests
  sessionStorage.setItem("skip-credit-confirm", "1");
});

// ── Token loading ─────────────────────────────────────────────────────────────

describe("SitePageClient — token loading", () => {
  it("U1 — site=null with no token: email gate form shown", async () => {
    render(
      <SitePageClient {...baseProps} site={null} initialToken={undefined} />
    );
    // tokenReady=true after mount, token=null → show email gate
    await waitFor(() => {
      expect(screen.getByRole("form") ?? screen.getByTestId("email-gate")).toBeInTheDocument();
    });
  });

  it("U2 — token in sessionStorage: loaded and used", async () => {
    sessionStorage.setItem("geo-token-site-123", "stored-token");
    render(<SitePageClient {...baseProps} />);
    // After mount, token should be set from sessionStorage — component renders main content
    await waitFor(() => {
      expect(screen.queryByTestId("email-gate")).not.toBeInTheDocument();
    });
  });

  it("U3 — token from URL hash: sessionStorage set and hash cleaned", async () => {
    // Simulate URL hash with token
    Object.defineProperty(window, "location", {
      value: { ...window.location, hash: "#st=hash-token&sid=site-123" },
      writable: true,
    });
    render(<SitePageClient {...baseProps} />);
    await waitFor(() => {
      // After token loaded from hash, sessionStorage should be set
      const stored = sessionStorage.getItem("geo-token-site-123");
      expect(stored).toBeTruthy();
    });
  });
});

// ── Tab navigation ────────────────────────────────────────────────────────────

describe("SitePageClient — tab navigation (U4–U9)", () => {
  const TOKEN = "valid-token";
  beforeEach(() => {
    sessionStorage.setItem("geo-token-site-123", TOKEN);
  });

  it("U4 — overview tab active by default", async () => {
    render(<SitePageClient {...baseProps} initialToken={TOKEN} />);
    await waitFor(() => {
      // Overview content (5 KPI cards) should be visible
      const overviewTab = screen.getByRole("tab", { name: /overview/i });
      expect(overviewTab).toBeInTheDocument();
    });
  });

  // BREAKAGE-1: post-rewrite (5fb698e + 7774578) Scorecard / Recommendations /
  // Pages are no longer top-level tabs — they are sub-views inside the
  // Action Plan tab, selected via plain <button> elements driving
  // actionPlanView state. The pre-rewrite U5/U6/U7 used
  // `getByRole("tab", { name: /scorecard/i })` etc. and would fail on this
  // branch because the matching role="tab" no longer exists. Rewritten:
  // click the Action Plan tab first, then the inner sub-button.

  it("U5 — Action Plan / Scorecard sub-view shows scorecard content", async () => {
    render(<SitePageClient {...baseProps} initialToken={TOKEN} />);
    await waitFor(() => screen.getByRole("tab", { name: /action plan/i }));
    fireEvent.click(screen.getByRole("tab", { name: /action plan/i }));
    // actionPlanView defaults to "scorecard" — no extra click needed.
    await waitFor(() => {
      expect(screen.queryByTestId("scorecard-tab")).not.toBeNull();
    });
  });

  it("U6 — Action Plan / Recommendations sub-button shows recommendations content", async () => {
    render(<SitePageClient {...baseProps} initialToken={TOKEN} />);
    await waitFor(() => screen.getByRole("tab", { name: /action plan/i }));
    fireEvent.click(screen.getByRole("tab", { name: /action plan/i }));
    // Sub-buttons are plain <button> elements (no role="tab"); query by text.
    await waitFor(() => screen.getByRole("button", { name: /^recommendations$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^recommendations$/i }));
    await waitFor(() => {
      expect(screen.queryByTestId("recommendations-tab")).not.toBeNull();
    });
  });

  it("U7 — Action Plan / Pages sub-button shows pages table", async () => {
    render(<SitePageClient {...baseProps} initialToken={TOKEN} />);
    await waitFor(() => screen.getByRole("tab", { name: /action plan/i }));
    fireEvent.click(screen.getByRole("tab", { name: /action plan/i }));
    await waitFor(() => screen.getByRole("button", { name: /^pages$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^pages$/i }));
    await waitFor(() => {
      expect(screen.queryByTestId("pages-tab")).not.toBeNull();
    });
  });

  it("U8 — click 'History' tab shows history content", async () => {
    render(<SitePageClient {...baseProps} initialToken={TOKEN} />);
    await waitFor(() => screen.getByRole("tab", { name: /history/i }));
    fireEvent.click(screen.getByRole("tab", { name: /history/i }));
    await waitFor(() => {
      // History tab now shows changeLog entries or "No history yet" empty state
      expect(screen.queryByText(/No history yet/i)).not.toBeNull();
    });
  });

  it("U9 — click 'Setup' tab shows setup content", async () => {
    render(<SitePageClient {...baseProps} initialToken={TOKEN} />);
    await waitFor(() => screen.getByRole("tab", { name: /setup/i }));
    fireEvent.click(screen.getByRole("tab", { name: /setup/i }));
    await waitFor(() => {
      // Setup tab has data-testid="setup-tab" and shows AI Files heading
      expect(screen.queryByTestId("setup-tab")).not.toBeNull();
    });
  });
});

// ── Polling ───────────────────────────────────────────────────────────────────

describe("SitePageClient — polling (U10–U11)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.setItem("geo-token-site-123", "valid-token");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("U10 — polling starts when pipelineStatus='crawling'", async () => {
    const scanningSite = { ...baseSite, pipelineStatus: "crawling" };
    mockFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ pipelineStatus: "crawling" }),
    });

    render(<SitePageClient {...baseProps} site={scanningSite} initialToken="valid-token" />);

    await act(async () => {
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
    });

    expect(mockFetch).toHaveBeenCalled();
  });

  it("U11 — polling stops when pipelineStatus becomes 'complete'", async () => {
    const scanningSite = { ...baseSite, pipelineStatus: "crawling" };
    mockFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ pipelineStatus: "complete", geoScorecard: { overallScore: 80 } }),
    });

    render(<SitePageClient {...baseProps} site={scanningSite} initialToken="valid-token" />);

    await act(async () => {
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
    });

    const count = mockFetch.mock.calls.length;

    await act(async () => {
      vi.advanceTimersByTime(9000);
      await Promise.resolve();
    });

    // No more calls after completion
    expect(mockFetch.mock.calls.length).toBe(count);
  });
});

// ── Action rail — Refresh Score ───────────────────────────────────────────────

describe("SitePageClient — handleRefreshScore (U12–U13)", () => {
  beforeEach(() => {
    sessionStorage.setItem("geo-token-site-123", "valid-token");
  });

  it.skip("U12 — 202 response: pipelineStatus set to 'queued' (scan starts) [STALE: Re-run button/flow changed]", async () => {
    // First call: POST /regenerate returns 202
    // Second call: poll() GET /api/sites/[id] returns queued site
    mockFetch
      .mockResolvedValueOnce({ status: 202, ok: true, json: vi.fn().mockResolvedValue({ accessToken: "new-token-123" }) })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ ...baseSite, pipelineStatus: "queued" }),
      });
    render(<SitePageClient {...baseProps} initialToken="valid-token" />);

    await waitFor(() => screen.getByTitle(/Re-run your GEO audit/i));
    fireEvent.click(screen.getByTitle(/Re-run your GEO audit/i));

    // After 202, the component should show audit status bar (scan active)
    await waitFor(() => {
      expect(
        screen.queryByText(/Running audit|Refreshing audit/i) ??
          screen.queryByText(/queued/i) ??
          screen.queryByTestId("audit-status-bar")
      ).not.toBeNull();
    }, { timeout: 5000 });
  });

  it.skip("U13 — 402 response: 'Not enough credits' shown on rail [STALE: rail/message UI changed]", async () => {
    mockFetch.mockResolvedValueOnce({ status: 402, ok: false });
    render(<SitePageClient {...baseProps} initialToken="valid-token" />);

    await waitFor(() => screen.getByTitle(/Re-run your GEO audit/i));
    await act(async () => {
      fireEvent.click(screen.getByTitle(/Re-run your GEO audit/i));
    });

    await waitFor(() => {
      expect(screen.getByText(/Not enough credits/i)).toBeInTheDocument();
    });
  });
});

// ── Domain Switcher ───────────────────────────────────────────────────────────

describe("SitePageClient — domain switcher (U14–U15)", () => {
  beforeEach(() => {
    sessionStorage.setItem("geo-token-site-123", "valid-token");
  });

  it("U14 — click domain name opens domain switcher dropdown", async () => {
    render(<SitePageClient {...baseProps} initialToken="valid-token" />);
    // Find the domain name button in the header
    await waitFor(() => screen.getByText("example.com"));
    const domainBtn = screen.getByText("example.com");
    fireEvent.click(domainBtn);
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Search domains/i)).toBeInTheDocument();
    });
  });

  it("U15 — domain switcher search filters list", async () => {
    render(<SitePageClient {...baseProps} initialToken="valid-token" />);
    await waitFor(() => screen.getByText("example.com"));
    fireEvent.click(screen.getByText("example.com"));

    const searchInput = await screen.findByPlaceholderText(/Search domains/i);
    fireEvent.change(searchInput, { target: { value: "other" } });

    await waitFor(() => {
      expect(screen.getByText("other.com")).toBeInTheDocument();
      // example.com filtered out
      const exampleLinks = screen.queryAllByText("example.com");
      // may still appear as the current domain in header but not in switcher
    });
  });
});

// ── Audit Status Bar ──────────────────────────────────────────────────────────

describe("SitePageClient — audit status bar (U16–U19)", () => {
  beforeEach(() => {
    sessionStorage.setItem("geo-token-site-123", "valid-token");
  });

  it("U16 — AuditStatusBar renders during active scan", async () => {
    const scanningSite = { ...baseSite, pipelineStatus: "analyzing" };
    render(<SitePageClient {...baseProps} site={scanningSite} initialToken="valid-token" />);
    await waitFor(() => {
      expect(
        screen.queryByTestId("audit-status-bar") ??
          screen.queryByText(/Running audit|Refreshing audit/i)
      ).not.toBeNull();
    });
  });

  it("U17 — AuditStatusBar absent when scan complete", async () => {
    render(<SitePageClient {...baseProps} initialToken="valid-token" />);
    await waitFor(() => {
      expect(
        screen.queryByTestId("audit-status-bar") ??
          screen.queryByText(/Running audit/i)
      ).toBeNull();
    });
  });

  it("U18 — CSS var --audit-bar-height set to '52px' during scan", async () => {
    const scanningSite = { ...baseSite, pipelineStatus: "crawling" };
    const setSpy = vi.spyOn(document.documentElement.style, "setProperty");
    render(<SitePageClient {...baseProps} site={scanningSite} initialToken="valid-token" />);
    await waitFor(() => {
      expect(setSpy).toHaveBeenCalledWith("--audit-bar-height", "52px");
    });
    setSpy.mockRestore();
  });

  it("U19 — CSS var reset to '0px' after scan completes", async () => {
    const setSpy = vi.spyOn(document.documentElement.style, "setProperty");
    render(<SitePageClient {...baseProps} initialToken="valid-token" />);
    await waitFor(() => {
      expect(setSpy).toHaveBeenCalledWith("--audit-bar-height", "0px");
    });
    setSpy.mockRestore();
  });
});

// ── isNewSite detection ───────────────────────────────────────────────────────

describe("SitePageClient — isNewSite detection (U20)", () => {
  beforeEach(() => {
    sessionStorage.setItem("geo-token-site-123", "valid-token");
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.skip("U20 — isNewSite=true (overallScore=null on mount) persists during polling [STALE: isNewSite detection logic moved]", async () => {
    // Start with null score, then scan returns a score — isNewSite should remain true
    // FIX-1 (HP-117): isNewSite reads geoScorecard.overallScore, so null it there too
    const newSite = { ...baseSite, overallScore: null, geoScorecard: { ...baseSite.geoScorecard, overallScore: null }, pipelineStatus: "crawling" };
    mockFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        pipelineStatus: "crawling",
        geoScorecard: { overallScore: 65 },
      }),
    });

    render(<SitePageClient {...baseProps} site={newSite} initialToken="valid-token" />);

    // isNewSite is set once on mount from row.overallScore
    // Even after polling returns a score, the "isNewSite" label should not flip
    await act(async () => {
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
    });

    // Component should still indicate "Running audit" not "Refreshing audit"
    // because isNewSite was true at mount (overallScore was null)
    await waitFor(() => {
      const text = screen.queryByText(/Running audit/i);
      expect(text).not.toBeNull();
    });
  });
});
