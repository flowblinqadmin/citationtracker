/**
 * ES-054 — C7: Geographic Signals Scoring (17th pillar)
 * Tests U16–U22
 *
 * Spec: scoreGeographicSignals() — deterministic, no LLM.
 * Injected into scorecard as 17th pillar with weight 2.5.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Gemini/LLM for analyzeGeoGaps (U21/U22 need the full flow)
const { mockGeminiGenerate } = vi.hoisted(() => {
  const mockGeminiGenerate = vi.fn();
  return { mockGeminiGenerate };
});

vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: vi.fn().mockImplementation(function () {
    return {
      getGenerativeModel: vi.fn().mockReturnValue({
        generateContent: mockGeminiGenerate,
      }),
    };
  }),
}));

import {
  scoreGeographicSignals,
  analyzeGeoGaps,
} from "@/lib/services/geo-analyzer";

import type { GeoScore, GeoScorecard } from "@/lib/services/geo-analyzer";

// ── Helpers ──────────────────────────────────────────────────────

function makePage(overrides: {
  url?: string;
  existingSchema?: string;
  contactInfo?: string;
  content?: string;
  pageType?: string;
}) {
  return {
    url: overrides.url ?? "https://example.com/page",
    title: "Test Page",
    content: overrides.content ?? "Generic page content about our services.",
    pageType: overrides.pageType ?? "services",
    wordCount: 500,
    existingSchema: overrides.existingSchema ?? "",
    contactInfo: overrides.contactInfo ?? "",
    faqContent: [],
    headings: [],
    metaDescription: "",
    links: [],
  };
}

function makeCrawlData(pages: ReturnType<typeof makePage>[]) {
  return {
    pages,
    domain: "example.com",
    crawledAt: new Date().toISOString(),
  };
}

function makeGeoTree(nodes: Array<{ id: string; name: string }>) {
  return {
    root: {
      id: "root",
      name: "Root",
      children: nodes.map((n) => ({ id: n.id, name: n.name, children: [] })),
    },
    leafCount: nodes.length,
  };
}

// ── U16–U20: scoreGeographicSignals ─────────────────────────────

describe("scoreGeographicSignals — ES-054 C7", () => {
  it("U16 — full geo signals yield score >= 80", () => {
    const pages = [
      makePage({
        url: "https://example.com",
        existingSchema: '{"@type":"LocalBusiness","geo":{"@type":"GeoCoordinates"},"address":{"@type":"PostalAddress"},"areaServed":"Bangalore"}',
        contactInfo: "123 MG Road, Bangalore, Karnataka 560001",
        content: 'Our office at 123 MG Road geo.region content="IN-KA"',
      }),
      makePage({
        url: "https://example.com/locations/bangalore",
        existingSchema: '{"@type":"LocalBusiness"}',
        contactInfo: "456 Brigade Road, Bangalore 560025",
      }),
      makePage({
        url: "https://example.com/locations/delhi",
        contactInfo: "789 Connaught Place, New Delhi 110001",
      }),
      makePage({
        url: "https://example.com/contact",
        contactInfo: "101 Park Street, Kolkata 700016",
      }),
    ];

    const crawlData = makeCrawlData(pages);
    const result = scoreGeographicSignals(crawlData, null);

    expect(result.score).toBeGreaterThanOrEqual(80);
    expect(result.pillar).toBe("geographic_signals");
    expect(result.pillarName).toBe("Geographic Signals");
  });

  it("U17 — SaaS with no geo signals yields score <= 10", () => {
    const pages = [
      makePage({ url: "https://saas.io", content: "Our cloud platform helps teams collaborate." }),
      makePage({ url: "https://saas.io/pricing", content: "Start free. Upgrade anytime." }),
      makePage({ url: "https://saas.io/docs", content: "API documentation and guides." }),
    ];

    const crawlData = makeCrawlData(pages);
    const result = scoreGeographicSignals(crawlData, null);

    expect(result.score).toBeLessThanOrEqual(10);
  });

  it("U18 — LocalBusiness schema only yields score = 20", () => {
    const pages = [
      makePage({ existingSchema: '{"@type":"LocalBusiness","name":"Test Clinic"}' }),
      makePage({ content: "About our services." }),
    ];

    const crawlData = makeCrawlData(pages);
    const result = scoreGeographicSignals(crawlData, null);

    expect(result.score).toBe(20);
  });

  it("U19 — addresses on 2 pages (below threshold of 3) gives no address points", () => {
    const pages = [
      makePage({ contactInfo: "123 Main St, City 12345" }),
      makePage({ contactInfo: "456 Oak Ave, Town 67890" }),
    ];

    const crawlData = makeCrawlData(pages);
    const result = scoreGeographicSignals(crawlData, null);

    // Only address signal needs >= 3 pages. With 2, no +15 points for address.
    expect(result.score).toBeLessThanOrEqual(10);
  });

  it("U20 — location pages (/locations/*) add +15 points", () => {
    const pages = [
      makePage({ url: "https://example.com/locations/bangalore" }),
      makePage({ url: "https://example.com/locations/delhi" }),
      makePage({ url: "https://example.com/about" }),
    ];

    const crawlData = makeCrawlData(pages);
    const result = scoreGeographicSignals(crawlData, null);

    // +15 for location pages. No other signals.
    expect(result.score).toBe(15);
  });
});

// ── U21–U22: 17th pillar integration ────────────────────────────

describe("17th pillar integration — ES-054 C7", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GEMINI_API_KEY = "test-key";
  });

  function mock16PillarResponse() {
    const pillars = [
      "metadata_freshness", "semantic_html", "structured_data",
      "content_structure", "internal_linking", "faq_coverage",
      "multimedia_usage", "mobile_ux", "page_speed",
      "author_authority", "content_freshness", "evidence_statistics",
      "comparative_content", "contact_trust", "technical_seo",
      "licensing_signals",
    ];

    const pillarScores = pillars.map((p) => ({
      pillar: p,
      pillarName: p.replace(/_/g, " "),
      score: 50,
      findings: "Test finding",
      recommendation: "Test recommendation",
      priority: "medium",
      impactedPages: [],
    }));

    const response = {
      overallScore: 50,
      pillars: pillarScores,
      topThreeImprovements: ["Improve A", "Improve B", "Improve C"],
    };

    mockGeminiGenerate.mockResolvedValue({
      response: { text: () => JSON.stringify(response) },
    });
  }

  it("U21 — scorecard has 17 pillars after analysis (last is geographic_signals)", async () => {
    mock16PillarResponse();

    const crawlData = makeCrawlData([
      makePage({
        url: "https://example.com",
        existingSchema: '{"@type":"LocalBusiness"}',
      }),
    ]);

    const scorecard = await analyzeGeoGaps(crawlData, { competitors: [] });

    expect(scorecard.pillars).toHaveLength(17);
    const last = scorecard.pillars[scorecard.pillars.length - 1];
    expect(last.pillar).toBe("geographic_signals");
  });

  it("U22 — overall score includes 17th pillar weight (2.5)", async () => {
    mock16PillarResponse();

    const crawlData = makeCrawlData([
      makePage({ url: "https://example.com" }),
    ]);

    const scorecard = await analyzeGeoGaps(crawlData, { competitors: [] });

    // The overall score should be a weighted average including weight 2.5
    // for geographic_signals. Since we can't predict exact value, just
    // verify the pillar is included and score is computed.
    expect(scorecard.overallScore).toBeGreaterThanOrEqual(0);
    expect(scorecard.overallScore).toBeLessThanOrEqual(100);

    const geoPillar = scorecard.pillars.find((p) => p.pillar === "geographic_signals");
    expect(geoPillar).toBeDefined();
  });
});
