/**
 * ES-070 — Free Tier: Status Bar + Session Cookie Fixes
 * Phase A — ReviewMaster spec-driven unit tests
 *
 * T-070-1: Initial fetch fires when token set but site is null
 * T-070-2: Polling starts after initial fetch populates site with active status
 * T-070-3: No extra fetch when site already populated from server
 * T-070-4: Email gate renders when no token available
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import React from "react";

// ── Mocks ───────────────────────────────────────────────────────────────────

// next/navigation
const mockRouter = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() };
vi.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
  usePathname: () => "/sites/SITE_ID",
  useSearchParams: () => new URLSearchParams(),
}));

// Supabase client (used by verify page)
const mockSetSession = vi.fn().mockResolvedValue({ data: {}, error: null });
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { setSession: mockSetSession },
  }),
}));

// useMediaQuery hook
vi.mock("@/lib/hooks/useMediaQuery", () => ({
  useMediaQuery: () => false,
}));

// Sub-components with complex deps
vi.mock("@/app/dashboard/BuyCreditsButton", () => ({
  default: () => null,
}));

vi.mock("@/app/dashboard/SignOutButton", () => ({
  default: () => null,
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

const SITE_ID = "test-site-123";
const MOCK_TOKEN = "mock-access-token-xyz";

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
    tier: "free" as const,
    credits: 0,
    baselineScore: null,
    improvementDelta: null,
    token: MOCK_TOKEN,
    ...overrides,
  };
}

function makeActiveSiteData(overrides: Record<string, unknown> = {}) {
  return makeSiteData({ pipelineStatus: "crawling", ...overrides });
}

// Default props for SitePageClient
function defaultProps(overrides: Record<string, unknown> = {}) {
  return {
    site: null as ReturnType<typeof makeSiteData> | null,
    siteId: SITE_ID,
    initialToken: undefined as string | undefined,
    allTeamDomains: [],
    lastCitationCheck: null,
    citationHistory: [],
    credits: 0,
    ...overrides,
  };
}

// ── Import SitePageClient lazily after mocks ─────────────────────────────────
let SitePageClient: React.ComponentType<ReturnType<typeof defaultProps>>;

beforeEach(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  // Reset fetch mock
  global.fetch = vi.fn();
  // Clear sessionStorage
  sessionStorage.clear();
  // Reset hash
  Object.defineProperty(window, "location", {
    writable: true,
    value: { ...window.location, hash: "", pathname: `/sites/${SITE_ID}`, search: "", href: `http://localhost/sites/${SITE_ID}` },
  });
  window.history.replaceState = vi.fn();

  // Dynamic import to pick up mocks
  const mod = await import("@/app/sites/[id]/SitePageClient");
  SitePageClient = mod.default;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════════
// T-070-1: Initial fetch fires when token set but site is null
// ═══════════════════════════════════════════════════════════════════════════════
describe("T-070-1: Initial fetch when token from hash, site is null", () => {
  it("calls fetch with the correct URL when token is loaded from hash and site is null", async () => {
    // Simulate hash fragment from exchange redirect
    Object.defineProperty(window, "location", {
      writable: true,
      value: {
        ...window.location,
        hash: `#st=${MOCK_TOKEN}&sid=${SITE_ID}`,
        pathname: `/sites/${SITE_ID}`,
        search: "",
        href: `http://localhost/sites/${SITE_ID}#st=${MOCK_TOKEN}&sid=${SITE_ID}`,
      },
    });

    const activeSite = makeActiveSiteData();
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => activeSite,
    });

    await act(async () => {
      render(<SitePageClient {...defaultProps()} />);
    });

    // The new useEffect should fire poll() because token is set (from hash) but site is null
    await waitFor(() => {
      const fetchCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
      const pollCall = fetchCalls.find(
        (call: unknown[]) => typeof call[0] === "string" && call[0].includes(`/api/sites/${SITE_ID}?token=`)
      );
      expect(pollCall).toBeTruthy();
      expect(pollCall![0]).toContain(`token=${MOCK_TOKEN}`);
    });
  });

  it("populates site state after initial fetch resolves", async () => {
    Object.defineProperty(window, "location", {
      writable: true,
      value: {
        ...window.location,
        hash: `#st=${MOCK_TOKEN}&sid=${SITE_ID}`,
        pathname: `/sites/${SITE_ID}`,
        search: "",
        href: `http://localhost/sites/${SITE_ID}#st=${MOCK_TOKEN}&sid=${SITE_ID}`,
      },
    });

    const activeSite = makeActiveSiteData();
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => activeSite,
    });

    await act(async () => {
      render(<SitePageClient {...defaultProps()} />);
    });

    // After fetch resolves, audit-status-bar should appear (site populated with active status)
    await waitFor(() => {
      expect(screen.getByTestId("audit-status-bar")).toBeInTheDocument();
    });
  });

  it("stores token in sessionStorage and clears hash fragment", async () => {
    Object.defineProperty(window, "location", {
      writable: true,
      value: {
        ...window.location,
        hash: `#st=${MOCK_TOKEN}&sid=${SITE_ID}`,
        pathname: `/sites/${SITE_ID}`,
        search: "",
        href: `http://localhost/sites/${SITE_ID}#st=${MOCK_TOKEN}&sid=${SITE_ID}`,
      },
    });

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => makeActiveSiteData(),
    });

    await act(async () => {
      render(<SitePageClient {...defaultProps()} />);
    });

    await waitFor(() => {
      expect(sessionStorage.getItem(`geo-token-${SITE_ID}`)).toBe(MOCK_TOKEN);
    });
    expect(window.history.replaceState).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// T-070-2: Polling starts after initial fetch populates site with active status
// ═══════════════════════════════════════════════════════════════════════════════
describe("T-070-2: Polling starts after initial fetch populates site", () => {
  it("starts 3s polling interval once site has active pipelineStatus", async () => {
    Object.defineProperty(window, "location", {
      writable: true,
      value: {
        ...window.location,
        hash: `#st=${MOCK_TOKEN}&sid=${SITE_ID}`,
        pathname: `/sites/${SITE_ID}`,
        search: "",
        href: `http://localhost/sites/${SITE_ID}#st=${MOCK_TOKEN}&sid=${SITE_ID}`,
      },
    });

    // First fetch (initial poll) returns active site
    const activeSite = makeActiveSiteData();
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => activeSite,
    });

    await act(async () => {
      render(<SitePageClient {...defaultProps()} />);
    });

    // Wait for initial fetch to complete and status bar to appear
    await waitFor(() => {
      expect(screen.getByTestId("audit-status-bar")).toBeInTheDocument();
    });

    // Clear call count to isolate polling calls
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    const callCountAfterInitial = fetchMock.mock.calls.length;

    // Advance timers by 3 seconds — should trigger one polling call
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    await waitFor(() => {
      const newCalls = fetchMock.mock.calls.slice(callCountAfterInitial);
      const pollCalls = newCalls.filter(
        (call: unknown[]) => typeof call[0] === "string" && call[0].includes(`/api/sites/${SITE_ID}?token=`)
      );
      expect(pollCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("stops polling when pipelineStatus becomes complete", async () => {
    Object.defineProperty(window, "location", {
      writable: true,
      value: {
        ...window.location,
        hash: `#st=${MOCK_TOKEN}&sid=${SITE_ID}`,
        pathname: `/sites/${SITE_ID}`,
        search: "",
        href: `http://localhost/sites/${SITE_ID}#st=${MOCK_TOKEN}&sid=${SITE_ID}`,
      },
    });

    let callCount = 0;
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callCount++;
      // After 2 polls, return completed status
      const status = callCount <= 2 ? "crawling" : "complete";
      return {
        ok: true,
        json: async () => makeSiteData({ pipelineStatus: status, token: MOCK_TOKEN }),
      };
    });

    await act(async () => {
      render(<SitePageClient {...defaultProps()} />);
    });

    // Wait for initial fetch
    await waitFor(() => {
      expect(callCount).toBeGreaterThanOrEqual(1);
    });

    // Advance enough for a few polling cycles
    await act(async () => {
      vi.advanceTimersByTime(15000);
    });

    const totalCalls = callCount;

    // Advance more — should NOT produce new calls if polling stopped
    await act(async () => {
      vi.advanceTimersByTime(10000);
    });

    // Polling should have stopped once "complete" was returned
    // Allow +1 tolerance for timing
    expect(callCount).toBeLessThanOrEqual(totalCalls + 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// T-070-3: No extra fetch when site already populated from server
// ═══════════════════════════════════════════════════════════════════════════════
describe("T-070-3: No extra fetch when site already provided", () => {
  it("does not call fetch on mount when site is provided and status is complete", async () => {
    const completeSite = makeSiteData({ pipelineStatus: "complete" });

    await act(async () => {
      render(
        <SitePageClient
          {...defaultProps({
            site: completeSite,
            initialToken: MOCK_TOKEN,
          })}
        />
      );
    });

    // Give time for any effects to fire
    await act(async () => {
      vi.advanceTimersByTime(100);
    });

    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    const pollCalls = fetchMock.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes(`/api/sites/${SITE_ID}?token=`)
    );
    // No poll calls — site already available and not active
    expect(pollCalls.length).toBe(0);
  });

  it("does not start polling interval when pipelineStatus is complete", async () => {
    const completeSite = makeSiteData({ pipelineStatus: "complete" });

    await act(async () => {
      render(
        <SitePageClient
          {...defaultProps({
            site: completeSite,
            initialToken: MOCK_TOKEN,
          })}
        />
      );
    });

    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    const beforeCount = fetchMock.mock.calls.length;

    // Advance 10 seconds — no polling should occur
    await act(async () => {
      vi.advanceTimersByTime(10000);
    });

    const pollCalls = fetchMock.mock.calls.slice(beforeCount).filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes(`/api/sites/${SITE_ID}?token=`)
    );
    expect(pollCalls.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// T-070-4: Email gate renders when no token available
// ═══════════════════════════════════════════════════════════════════════════════
describe("T-070-4: Email gate when no token", () => {
  it("renders email-gate form when site is null and no token sources available", async () => {
    // No hash, no initialToken, no sessionStorage, no initialSite.token
    await act(async () => {
      render(<SitePageClient {...defaultProps()} />);
    });

    await waitFor(() => {
      expect(screen.getByTestId("email-gate")).toBeInTheDocument();
    });
  });

  it("does not call fetch for poll when no token is available", async () => {
    await act(async () => {
      render(<SitePageClient {...defaultProps()} />);
    });

    // Give effects time to fire
    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    const pollCalls = fetchMock.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes(`/api/sites/${SITE_ID}?token=`)
    );
    expect(pollCalls.length).toBe(0);
  });

  it("email gate shows correct prompt text", async () => {
    await act(async () => {
      render(<SitePageClient {...defaultProps()} />);
    });

    await waitFor(() => {
      expect(screen.getByText("Open your report")).toBeInTheDocument();
      expect(screen.getByText(/Enter the email you used/)).toBeInTheDocument();
    });
  });
});
