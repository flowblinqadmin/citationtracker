/**
 * ES-wave-1 — token bootstrap UT (AC-1, AC-2, AC-3, AC-7 / HP-W1-MIN-1).
 *
 * Asserts that SitePageClient's token-bootstrap useEffect prefers the
 * freshly server-rendered `initialSite.token` over any cached sessionStorage
 * value (G3 fix), and that the read-only fall-through chain
 * (sessionStorage → initialToken → window.location.hash) is preserved when
 * `initialSite.token` is absent.
 *
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, cleanup, screen } from "@testing-library/react";

afterEach(() => cleanup());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
}));

const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
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

const SITE_ID = "site-123";
const STORAGE_KEY = `geo-token-${SITE_ID}`;

function makeSite(token: string | null = null) {
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
  // Reset hash without breaking jsdom's location proxy
  window.history.replaceState(null, "", window.location.pathname);
});

// ── AC-1 / AC-3: initialSite.token present ──────────────────────────────────

describe("SitePageClient token bootstrap — initialSite.token present (AC-1, AC-3)", () => {
  it("AC-1.a: fresh token + empty sessionStorage → writes fresh into sessionStorage", async () => {
    render(<SitePageClient {...baseProps} site={makeSite("fresh")} />);
    await waitFor(() => {
      expect(sessionStorage.getItem(STORAGE_KEY)).toBe("fresh");
    });
  });

  it("AC-1.b: fresh token + stale sessionStorage → OVERWRITES stored with fresh", async () => {
    sessionStorage.setItem(STORAGE_KEY, "stale");
    render(<SitePageClient {...baseProps} site={makeSite("fresh")} />);
    await waitFor(() => {
      expect(sessionStorage.getItem(STORAGE_KEY)).toBe("fresh");
    });
  });

  it("AC-3: fresh token + matching sessionStorage → idempotent, value unchanged", async () => {
    sessionStorage.setItem(STORAGE_KEY, "fresh");
    render(<SitePageClient {...baseProps} site={makeSite("fresh")} />);
    await waitFor(() => {
      expect(sessionStorage.getItem(STORAGE_KEY)).toBe("fresh");
    });
  });
});

// ── AC-2: initialSite.token absent → fall-through chain ─────────────────────

describe("SitePageClient token bootstrap — read-only fall-through (AC-2)", () => {
  it("AC-2.a: no initialSite.token, sessionStorage='cached' → uses cached (no overwrite)", async () => {
    sessionStorage.setItem(STORAGE_KEY, "cached");
    render(<SitePageClient {...baseProps} site={null} />);
    await waitFor(() => {
      expect(sessionStorage.getItem(STORAGE_KEY)).toBe("cached");
    });
  });

  it("AC-2.b: no initialSite.token, no storage, initialToken='prop' → writes prop into storage", async () => {
    render(<SitePageClient {...baseProps} site={null} initialToken="prop" />);
    await waitFor(() => {
      expect(sessionStorage.getItem(STORAGE_KEY)).toBe("prop");
    });
  });

  it("AC-2.c: no initialSite.token, no storage, no prop, hash='#st=hashval&sid=…' → writes hashval", async () => {
    window.history.replaceState(null, "", `${window.location.pathname}#st=hashval&sid=${SITE_ID}`);
    render(<SitePageClient {...baseProps} site={null} />);
    await waitFor(() => {
      expect(sessionStorage.getItem(STORAGE_KEY)).toBe("hashval");
    });
  });
});

// ── AC-7 / HP-W1-MIN-1: read-only with no token from any source ─────────────

describe("SitePageClient token bootstrap — fully unauthed read-only (HP-W1-MIN-1, AC-7)", () => {
  it("AC-7: initialSite.token undefined + storage empty + no prop + no hash → email gate shown (action gating disabled)", async () => {
    render(<SitePageClient {...baseProps} site={null} />);
    await waitFor(() => {
      // No token resolved → component renders the email-gate path; action
      // buttons (e.g. "Refresh Score") never render under this branch.
      expect(screen.queryByTitle(/Refresh Score/i)).toBeNull();
    });
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
