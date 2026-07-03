/**
 * RM-MAJOR-1 regression: directSamples build must NOT mutate
 * pillarQA[__direct__].samples at render time.
 *
 * Pre-fix bug at app/sites/[id]/SitePageClient.tsx:2348 used
 *   let directSamples = (pillarQA["__direct__"]?.samples ?? []);
 * which captured the array REFERENCE from the prop. The subsequent
 * conditional legacy-fallback `directSamples.push(...)` then mutated the
 * prop array. Under React.StrictMode the double-render appended duplicates;
 * any parent that retained the reference observed grown arrays across
 * renders.
 *
 * Fix: shallow-clone with spread before legacy push.
 *
 * The test renders SitePageClient with a deliberately-frozen samples array.
 * If the render path attempts to mutate the array, Object.freeze in strict
 * mode throws — which React surfaces as a render error. After the fix, the
 * frozen array survives unchanged across two renders (StrictMode double-
 * invoke is implicit during the test render).
 *
 * @vitest-environment jsdom
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

afterEach(() => cleanup());

const mockPush = vi.fn();
const mockRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn(), back: vi.fn(), refresh: mockRefresh }),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("@/app/components/citation-monitor", () => ({
  CitationMonitor: () => <div data-testid="citation-monitor" />,
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
  default: ({ credits }: { credits: number }) => <button data-testid="buy-credits">{credits}</button>,
}));
vi.mock("@/app/dashboard/SignOutButton", () => ({
  default: () => <button data-testid="sign-out">Sign Out</button>,
}));

import SitePageClient from "@/app/sites/[id]/SitePageClient";

const TOKEN = "tok-rm-major-1";

function buildSiteWithDirectSamples(samples: ReadonlyArray<{ question: string; answer: string | null; mentioned: boolean; provider: string; sentiment: string | null }>) {
  return {
    id: "site-rm1",
    domain: "example.com",
    pipelineStatus: "complete",
    overallScore: 72,
    geoScorecard: {
      overallScore: 72,
      pillars: [{ pillar: "faq", pillarName: "FAQ", score: 60, findings: "OK", priority: "low" }],
    },
    rankedRecommendations: [],
    crawlData: { pages: [{ url: "https://example.com" }] },
    lastCrawlAt: "2026-05-03T00:00:00Z",
    token: TOKEN,
    credits: 20,
    citationNarrative: null,
    perPageResults: null,
    domainVerified: true,
    verifyToken: null,
    generatedLlmsTxt: "llms content",
    generatedLlmsFullTxt: null,
    generatedBusinessJson: null,
    generatedSchemaBlocks: null,
    lastCitationCheck: {
      checkId: "chk-rm1",
      indirectVisibility: 50,
      overallVisibility: 50,
      brandKnowledge: 75,
      citationQualityScore: 80,
      bestProvider: "openai",
      worstProvider: "google",
      avgPosition: 2,
      sentimentScore: 10,
      providerResults: [],
      competitorData: [],
      pillarVisibility: {},
      pillarQA: {
        __direct__: { samples, topCompetitor: null },
      },
    },
  } as unknown as Parameters<typeof SitePageClient>[0]["site"];
}

const baseProps = (site: ReturnType<typeof buildSiteWithDirectSamples>) => ({
  site,
  siteId: "site-rm1",
  initialToken: TOKEN,
  allTeamDomains: [{ id: "td-rm1", domain: "example.com", geoScorecard: { overallScore: 72 }, crawlData: { pages: [] } }],
  lastCitationCheck: null,
  citationHistory: [],
  credits: 20,
  userEmail: "user@test.com",
});

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  sessionStorage.setItem(`geo-token-site-rm1`, TOKEN);
});

describe("MINOR-2 — KPI cards keyboard a11y + tooltip click stopPropagation", () => {
  function buildBareSite() {
    return {
      id: "site-a11y",
      domain: "example.com",
      pipelineStatus: "complete",
      overallScore: 72,
      geoScorecard: {
        overallScore: 72,
        pillars: [{ pillar: "faq", pillarName: "FAQ", score: 60, findings: "OK", priority: "low" }],
      },
      rankedRecommendations: [],
      crawlData: { pages: [{ url: "https://example.com" }] },
      lastCrawlAt: "2026-05-03T00:00:00Z",
      token: TOKEN,
      credits: 20,
      citationNarrative: null,
      perPageResults: null,
      domainVerified: true,
      verifyToken: null,
      generatedLlmsTxt: "llms content",
      generatedLlmsFullTxt: null,
      generatedBusinessJson: null,
      generatedSchemaBlocks: null,
      lastCitationCheck: {
        checkId: "chk-a11y",
        indirectVisibility: 50,
        overallVisibility: 50,
        brandKnowledge: 75,
        citationQualityScore: 80,
        bestProvider: "openai",
        worstProvider: "google",
        avgPosition: 2,
        sentimentScore: 10,
        providerResults: [],
        competitorData: [],
        pillarVisibility: {},
        pillarQA: {},
      },
    } as unknown as Parameters<typeof SitePageClient>[0]["site"];
  }

  it("A11Y-1 — KPI cards have role=button + tabIndex=0 (keyboard reachable)", () => {
    const site = buildBareSite();
    render(<SitePageClient {...baseProps(site)} />);
    // The 4 KPI cards live inside the overview tab and carry text labels
    // 'AI Visibility' / 'GEO Score' / 'Competitive SOV' / 'Citation Quality'.
    // Each card now exposes role=button so it's reachable via Tab key.
    // Count must be >=4 (KPI) and may include the 3 At-a-Glance cards too.
    const buttons = document.querySelectorAll('div[role="button"][tabindex="0"]');
    expect(buttons.length).toBeGreaterThanOrEqual(4);
  });
});

describe("RM-MAJOR-1 — directSamples render-mutation guard", () => {
  it("RM1-1 — when pillarQA.__direct__.samples is a FROZEN array, render does not throw and array length stays the same across two renders", () => {
    const samples = Object.freeze([
      Object.freeze({ question: "what is example?", answer: "a test site", mentioned: true, provider: "openai", sentiment: null }),
    ]) as unknown as ReturnType<typeof buildSiteWithDirectSamples>["lastCitationCheck"]["pillarQA"]["__direct__"]["samples"];
    const initialLength = samples.length;
    const site = buildSiteWithDirectSamples(samples);

    // Wrap in StrictMode to double-invoke render and amplify any mutation
    // (the prior bug accumulated duplicates here).
    const { rerender } = render(
      <React.StrictMode>
        <SitePageClient {...baseProps(site)} />
      </React.StrictMode>,
    );
    // Second render — confirms input array reference survives unchanged.
    act(() => {
      rerender(
        <React.StrictMode>
          <SitePageClient {...baseProps(site)} />
        </React.StrictMode>,
      );
    });
    expect(samples.length).toBe(initialLength);
  });

  it("RM1-2 — pillarQA missing __direct__ key entirely → render does not crash (graceful empty-state)", () => {
    const site = buildSiteWithDirectSamples([] as never);
    // Wipe the __direct__ key entirely so the fallback path runs.
    const lcc = site.lastCitationCheck as unknown as { pillarQA: Record<string, unknown> };
    delete lcc.pillarQA.__direct__;
    expect(() => render(<SitePageClient {...baseProps(site)} />)).not.toThrow();
  });
});
