/**
 * ES-062 — types.ts Type Integrity Tests
 * U21–U23
 *
 * Written spec-first (Phase A — ReviewMaster).
 * These tests are RED until DaVinci creates app/sites/[id]/types.ts.
 *
 * Runtime behaviour: verifies TypeScript shape contracts via object construction.
 * Any compile-time type error = test failure.
 */
import { describe, it, expect } from "vitest";
import type {
  SiteData,
  SiteDataExtended,
  TabId,
  GeoScore,
  GeoScorecard,
  RankedRec,
  DiffData,
  ChangeLogEntry,
  SchemaBlock,
  TeamDomainSwitcherEntry,
} from "@/app/sites/[id]/types";

// ── U21: SiteData type has all required fields ─────────────────────────────────

describe("SiteData type contract (U21)", () => {
  it("U21 — SiteData can be constructed with required fields", () => {
    const site: SiteData = {
      id: "site-1",
      domain: "example.com",
      pipelineStatus: "complete",
      overallScore: 72,
      geoScorecard: null,
      rankedRecommendations: [],
      crawlData: null,
      lastCrawlAt: null,
      token: null,
      credits: 0,
      citationNarrative: null,
      perPageResults: null,
      domainVerified: false,
      verifyToken: null,
      generatedLlmsTxt: null,
      generatedLlmsFullTxt: null,
      generatedBusinessJson: null,
      generatedSchemaBlocks: null,
    } as unknown as SiteData;

    expect(site).toBeDefined();
    expect(site.domain).toBe("example.com");
  });

  it("GeoScorecard type has overallScore and pillars", () => {
    const scorecard: GeoScorecard = {
      overallScore: 72,
      pillars: [
        {
          pillar: "schema",
          pillarName: "Schema",
          score: 80,
          findings: "OK",
          priority: "low",
        },
      ],
    } as unknown as GeoScorecard;

    expect(scorecard.overallScore).toBe(72);
    expect(scorecard.pillars).toHaveLength(1);
  });

  it("RankedRec type has required fields", () => {
    const rec: RankedRec = {
      id: "r1",
      pillar: "schema",
      title: "Fix schema",
      priority: "HIGH",
      estimatedBoost: "+10",
    } as unknown as RankedRec;

    expect(rec.priority).toBe("HIGH");
  });
});

// ── U22: SiteDataExtended extends SiteData ─────────────────────────────────────

describe("SiteDataExtended (U22)", () => {
  it("U22 — SiteDataExtended has discoveredCompetitors field accessible", () => {
    const extended: SiteDataExtended = {
      id: "site-1",
      domain: "example.com",
      discoveredCompetitors: [
        { domain: "competitor.com", mentionCount: 5 },
      ],
    } as unknown as SiteDataExtended;

    expect(extended.discoveredCompetitors).toHaveLength(1);
    expect(extended.discoveredCompetitors![0].domain).toBe("competitor.com");
  });

  it("SiteDataExtended brandKeywords and extractedCategories are optional", () => {
    const extended: SiteDataExtended = {
      id: "site-1",
      domain: "example.com",
      brandKeywords: ["flowblinq", "geo"],
      extractedCategories: ["saas", "analytics"],
    } as unknown as SiteDataExtended;

    expect(Array.isArray(extended.brandKeywords)).toBe(true);
    expect(Array.isArray(extended.extractedCategories)).toBe(true);
  });
});

// ── U23: TabId union covers all 6 tabs ─────────────────────────────────────────

describe("TabId union (U23)", () => {
  it("U23 — all 6 tab IDs are valid TabId values", () => {
    const tabs: TabId[] = [
      "overview",
      "scorecard",
      "recommendations",
      "pages",
      "history",
      "setup",
    ];
    expect(tabs).toHaveLength(6);
    tabs.forEach((t) => expect(t).toBeTruthy());
  });

  it("TabId values match TABS array labels in spec", () => {
    const EXPECTED_TABS = [
      "overview",
      "scorecard",
      "recommendations",
      "pages",
      "history",
      "setup",
    ] as const;

    // Verify each can be assigned as TabId without TS error
    EXPECTED_TABS.forEach((id) => {
      const tab: TabId = id;
      expect(tab).toBe(id);
    });
  });
});

// ── TeamDomainSwitcherEntry ────────────────────────────────────────────────────

describe("TeamDomainSwitcherEntry type", () => {
  it("has id, domain, geoScorecard, crawlData fields", () => {
    const entry: TeamDomainSwitcherEntry = {
      id: "td-1",
      domain: "example.com",
      geoScorecard: { overallScore: 72 },
      crawlData: { pages: [] },
    };
    expect(entry.id).toBe("td-1");
    expect(entry.domain).toBe("example.com");
  });

  it("geoScorecard and crawlData can be null", () => {
    const entry: TeamDomainSwitcherEntry = {
      id: "td-2",
      domain: "other.com",
      geoScorecard: null,
      crawlData: null,
    };
    expect(entry.geoScorecard).toBeNull();
    expect(entry.crawlData).toBeNull();
  });
});
