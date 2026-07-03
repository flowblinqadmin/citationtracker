/**
 * ES-070 — Free Tier: Status Bar + Session Cookie Fixes
 * Phase A — ReviewMaster integration tests
 *
 * IT-070-1: Hash token → initial fetch → status bar → polling cycle
 * IT-070-2: Exchange redirect path sets session cookies (window.location.href)
 * IT-070-3: Fallback to token-based redirect when no exchangeCode
 * IT-070-4: setSession fallback fires when authOtp present alongside exchangeCode
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import React from "react";

// ── Shared mocks ────────────────────────────────────────────────────────────

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

const mockSetSession = vi.fn().mockResolvedValue({ data: {}, error: null });
const mockSignOut = vi.fn().mockResolvedValue({ error: null });
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { setSession: mockSetSession, signOut: mockSignOut },
  }),
}));

vi.mock("@/lib/hooks/useMediaQuery", () => ({
  useMediaQuery: () => false,
}));

vi.mock("@/app/dashboard/BuyCreditsButton", () => ({
  default: () => null,
}));

vi.mock("@/app/dashboard/SignOutButton", () => ({
  default: () => null,
}));

// ── Constants ───────────────────────────────────────────────────────────────

const SITE_ID = "integ-site-070";
const MOCK_TOKEN = "integ-access-token-070";
const EXCHANGE_CODE = "exchange-code-abc123";

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
    tier: "free" as const,
    credits: 0,
    baselineScore: null,
    improvementDelta: null,
    token: MOCK_TOKEN,
    ...overrides,
  };
}

function defaultSiteProps(overrides: Record<string, unknown> = {}) {
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

// ── Lazy imports ────────────────────────────────────────────────────────────

let SitePageClient: React.ComponentType<ReturnType<typeof defaultSiteProps>>;
let VerifyPage: React.ComponentType<{ params: Promise<{ id: string }> }>;

beforeEach(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  global.fetch = vi.fn();
  sessionStorage.clear();
  mockRouter.replace.mockClear();
  mockSetSession.mockClear();

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

  const sitePageMod = await import("@/app/sites/[id]/SitePageClient");
  SitePageClient = sitePageMod.default;

  const verifyMod = await import("@/app/verify/[id]/page");
  VerifyPage = verifyMod.default;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════════
// IT-070-1: Hash-based token → initial fetch → status bar → polling → completion
// ═══════════════════════════════════════════════════════════════════════════════
describe("IT-070-1: Full lifecycle — hash token to polling completion", () => {
  it("progresses from hash token through initial fetch, polling, to completion", async () => {
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

    // Progression: crawling → analyzing → complete
    let fetchCount = 0;
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes(`/api/sites/${SITE_ID}?token=`)) {
        fetchCount++;
        let status: string;
        if (fetchCount <= 1) status = "crawling";
        else if (fetchCount <= 3) status = "analyzing";
        else status = "complete";
        return {
          ok: true,
          json: async () => makeSiteData({ pipelineStatus: status }),
        };
      }
      return { ok: false, json: async () => ({}) };
    });

    await act(async () => {
      render(<SitePageClient {...defaultSiteProps()} />);
    });

    // Phase 1: Initial fetch triggers, status bar appears
    await waitFor(() => {
      expect(fetchCount).toBeGreaterThanOrEqual(1);
      expect(screen.getByTestId("audit-status-bar")).toBeInTheDocument();
    });

    // Phase 2: Polling ticks continue
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    await waitFor(() => {
      expect(fetchCount).toBeGreaterThanOrEqual(2);
    });

    // Phase 3: Advance until complete
    await act(async () => {
      vi.advanceTimersByTime(12000);
    });

    await waitFor(() => {
      expect(fetchCount).toBeGreaterThanOrEqual(4);
    });

    // Phase 4: Status bar should disappear after completion
    // (pipelineStatus = "complete" → isActiveStatus returns false)
    await waitFor(() => {
      expect(screen.queryByTestId("audit-status-bar")).not.toBeInTheDocument();
    });

    // Phase 5: router.refresh called when pipeline completes
    expect(mockRouter.refresh).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// IT-070-2: Exchange redirect uses window.location.href (not router.replace)
// ═══════════════════════════════════════════════════════════════════════════════
describe("IT-070-2: Exchange redirect sets session cookies via full navigation", () => {
  it("uses window.location.href for exchange code redirect instead of router.replace", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;

    // Mock the /info endpoint (fetched on mount)
    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/info")) {
        return { ok: true, json: async () => ({ maskedEmail: "a***@example.com" }) };
      }
      // Mock the /verify endpoint
      if (typeof url === "string" && url.includes("/verify")) {
        return {
          ok: true,
          json: async () => ({
            siteId: SITE_ID,
            accessToken: MOCK_TOKEN,
            exchangeCode: EXCHANGE_CODE,
          }),
        };
      }
      return { ok: false, json: async () => ({}) };
    });

    // Track window.location.href assignment
    let capturedHref = "";
    Object.defineProperty(window, "location", {
      writable: true,
      value: {
        ...window.location,
        get href() { return capturedHref || `http://localhost/verify/${SITE_ID}`; },
        set href(val: string) { capturedHref = val; },
        pathname: `/verify/${SITE_ID}`,
      },
    });

    await act(async () => {
      render(<VerifyPage params={Promise.resolve({ id: SITE_ID })} />);
    });

    // Wait for component to mount
    await waitFor(() => {
      expect(screen.getByText("Verify & Start Audit")).toBeInTheDocument();
    });

    // Fill in OTP digits
    const inputs = screen.getAllByRole("textbox");
    const otpDigits = ["8", "4", "7", "2", "9", "1"];
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        fireEvent.change(inputs[i], { target: { value: otpDigits[i] } });
      });
    }

    // Accept TOS checkbox (required to enable submit)
    const checkbox = screen.getByRole("checkbox");
    await act(async () => {
      fireEvent.click(checkbox);
    });

    // Submit the form
    const submitButton = screen.getByText("Verify & Start Audit");
    await act(async () => {
      fireEvent.click(submitButton);
    });

    // Verify: window.location.href was set (NOT router.replace)
    await waitFor(() => {
      expect(capturedHref).toContain("/auth/exchange?code=");
      expect(capturedHref).toContain(encodeURIComponent(EXCHANGE_CODE));
    });

    // router.replace should NOT have been called for the exchange redirect
    const exchangeReplaceCalls = mockRouter.replace.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("/auth/exchange")
    );
    expect(exchangeReplaceCalls.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// IT-070-3: Fallback to token-based redirect when no exchangeCode
// ═══════════════════════════════════════════════════════════════════════════════
describe("IT-070-3: Token-based redirect fallback", () => {
  it("uses router.replace with token param when API returns no exchangeCode", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;

    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/info")) {
        return { ok: true, json: async () => ({ maskedEmail: "a***@example.com" }) };
      }
      if (typeof url === "string" && url.includes("/verify")) {
        return {
          ok: true,
          json: async () => ({
            siteId: SITE_ID,
            accessToken: MOCK_TOKEN,
            // No exchangeCode — triggers fallback path
          }),
        };
      }
      return { ok: false, json: async () => ({}) };
    });

    await act(async () => {
      render(<VerifyPage params={Promise.resolve({ id: SITE_ID })} />);
    });

    await waitFor(() => {
      expect(screen.getByText("Verify & Start Audit")).toBeInTheDocument();
    });

    // Fill OTP
    const inputs = screen.getAllByRole("textbox");
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        fireEvent.change(inputs[i], { target: { value: String(i + 1) } });
      });
    }

    // Accept TOS checkbox (required to enable submit)
    const checkbox = screen.getByRole("checkbox");
    await act(async () => {
      fireEvent.click(checkbox);
    });

    // Submit
    await act(async () => {
      fireEvent.click(screen.getByText("Verify & Start Audit"));
    });

    // Fallback: router.replace with token
    await waitFor(() => {
      expect(mockRouter.replace).toHaveBeenCalledWith(
        `/sites/${SITE_ID}?token=${MOCK_TOKEN}`
      );
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// IT-070-4: setSession fallback fires when authOtp present
// ═══════════════════════════════════════════════════════════════════════════════
describe("IT-070-4: setSession fallback with authOtp + exchangeCode", () => {
  it("calls supabase.auth.setSession before navigating via window.location.href", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;

    const authTokens = {
      access_token: "sb-access-token-xyz",
      refresh_token: "sb-refresh-token-xyz",
    };

    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/info")) {
        return { ok: true, json: async () => ({ maskedEmail: "a***@example.com" }) };
      }
      if (typeof url === "string" && url.includes("/verify")) {
        return {
          ok: true,
          json: async () => ({
            siteId: SITE_ID,
            accessToken: MOCK_TOKEN,
            exchangeCode: EXCHANGE_CODE,
            authOtp: JSON.stringify(authTokens),
          }),
        };
      }
      return { ok: false, json: async () => ({}) };
    });

    let capturedHref = "";
    Object.defineProperty(window, "location", {
      writable: true,
      value: {
        ...window.location,
        get href() { return capturedHref || `http://localhost/verify/${SITE_ID}`; },
        set href(val: string) { capturedHref = val; },
        pathname: `/verify/${SITE_ID}`,
      },
    });

    await act(async () => {
      render(<VerifyPage params={Promise.resolve({ id: SITE_ID })} />);
    });

    await waitFor(() => {
      expect(screen.getByText("Verify & Start Audit")).toBeInTheDocument();
    });

    // Fill OTP
    const inputs = screen.getAllByRole("textbox");
    const otpDigits = ["8", "4", "7", "2", "9", "1"];
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        fireEvent.change(inputs[i], { target: { value: otpDigits[i] } });
      });
    }

    // Accept TOS checkbox (required to enable submit)
    const checkbox = screen.getByRole("checkbox");
    await act(async () => {
      fireEvent.click(checkbox);
    });

    // Submit
    await act(async () => {
      fireEvent.click(screen.getByText("Verify & Start Audit"));
    });

    // setSession called with the tokens from authOtp
    await waitFor(() => {
      expect(mockSetSession).toHaveBeenCalledWith({
        access_token: authTokens.access_token,
        refresh_token: authTokens.refresh_token,
      });
    });

    // Navigation still uses window.location.href (not router.replace)
    await waitFor(() => {
      expect(capturedHref).toContain("/auth/exchange?code=");
    });
  });

  it("still navigates even if setSession throws", async () => {
    mockSetSession.mockRejectedValueOnce(new Error("session error"));

    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/info")) {
        return { ok: true, json: async () => ({}) };
      }
      if (typeof url === "string" && url.includes("/verify")) {
        return {
          ok: true,
          json: async () => ({
            siteId: SITE_ID,
            accessToken: MOCK_TOKEN,
            exchangeCode: EXCHANGE_CODE,
            authOtp: JSON.stringify({ access_token: "a", refresh_token: "r" }),
          }),
        };
      }
      return { ok: false, json: async () => ({}) };
    });

    let capturedHref = "";
    Object.defineProperty(window, "location", {
      writable: true,
      value: {
        ...window.location,
        get href() { return capturedHref || `http://localhost/verify/${SITE_ID}`; },
        set href(val: string) { capturedHref = val; },
        pathname: `/verify/${SITE_ID}`,
      },
    });

    await act(async () => {
      render(<VerifyPage params={Promise.resolve({ id: SITE_ID })} />);
    });

    await waitFor(() => {
      expect(screen.getByText("Verify & Start Audit")).toBeInTheDocument();
    });

    const inputs = screen.getAllByRole("textbox");
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        fireEvent.change(inputs[i], { target: { value: String(i + 1) } });
      });
    }

    // Accept TOS checkbox (required to enable submit)
    const checkbox = screen.getByRole("checkbox");
    await act(async () => {
      fireEvent.click(checkbox);
    });

    await act(async () => {
      fireEvent.click(screen.getByText("Verify & Start Audit"));
    });

    // Even though setSession throws, navigation should still proceed
    await waitFor(() => {
      expect(capturedHref).toContain("/auth/exchange?code=");
    });
  });
});
