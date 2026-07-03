/**
 * Shared test utilities for ES-002 Sprint 1 tests.
 * Provides mock factories and assertion helpers for tier-gating tests.
 *
 * Usage:
 *   import { mockTeam, mockSite, mockScorecard, ... } from "./helpers/test-harness";
 */

import { expect, vi } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Mock Factories — Teams
// ---------------------------------------------------------------------------

export interface MockTeam {
  id: string;
  name: string;
  ownerUserId: string;
  creditBalance: number;
  stripeCustomerId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function mockTeam(overrides: Partial<MockTeam> = {}): MockTeam {
  return {
    id: "team-test-1",
    name: "Test Team",
    ownerUserId: "user-test-1",
    creditBalance: 50,
    stripeCustomerId: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock Factories — Scorecard & Recommendations
// ---------------------------------------------------------------------------

export interface MockPillar {
  pillar: string;
  pillarName: string;
  score: number;
  weight: number;
  findings: string;
  recommendation: string;
  priority: "critical" | "high" | "medium" | "low";
  impactedPages: string[];
}

export interface MockScorecard {
  overallScore: number;
  pillars: MockPillar[];
  topThreeImprovements: string[];
}

export function mockScorecard(pillarCount = 3): MockScorecard {
  const priorities = ["critical", "high", "medium", "low"] as const;
  const pillars: MockPillar[] = Array.from({ length: pillarCount }, (_, i) => ({
    pillar: `pillar_${i + 1}`,
    pillarName: `Pillar ${i + 1}`,
    score: 50 + i * 10,
    weight: 4.0 - i * 0.5,
    findings: `Findings for pillar ${i + 1}: detailed analysis of issues found.`,
    recommendation: `Recommendation for pillar ${i + 1}: specific action to take.`,
    priority: priorities[i % 4],
    impactedPages: [
      `https://example.com/page-${i + 1}`,
      `https://example.com/page-${i + 2}`,
    ],
  }));

  return {
    overallScore: 65,
    pillars,
    topThreeImprovements: pillars.slice(0, 3).map((p) => p.recommendation),
  };
}

export interface MockRecommendation {
  title: string;
  pillar: string;
  priority: "critical" | "high" | "medium" | "low";
  findings: string;
  recommendation: string;
  impactedPages: string[];
}

export function mockRecommendations(count = 5): MockRecommendation[] {
  const priorities = ["critical", "high", "medium"] as const;
  return Array.from({ length: count }, (_, i) => ({
    title: `Recommendation ${i + 1}`,
    pillar: `pillar_${(i % 3) + 1}`,
    priority: priorities[i % 3],
    findings: `Finding details for recommendation ${i + 1}`,
    recommendation: `Detailed action plan for recommendation ${i + 1}`,
    impactedPages: [`https://example.com/rec-page-${i + 1}`],
  }));
}

// ---------------------------------------------------------------------------
// Mock Factories — Sites
// ---------------------------------------------------------------------------

export interface MockSite {
  siteId: string;
  domain: string;
  slug: string;
  teamId: string | null;
  accessToken: string;
  // ES-090 §b.1 CRIT-1: tokenExpiresAt must be populated in every mock so
  // HP-197 (NULL = expired) doesn't fail-close the fixture. Default = 30d ahead.
  tokenExpiresAt: Date | null;

  // Flattened scorecard fields (geoSiteView)
  overallScore: number | null;
  previousScore: number | null;
  projectedScore: number | null;
  projectedBoost: number | null;
  baselineScore: number | null;
  pillars: MockPillar[] | null;

  // Pipeline data
  executiveSummary: string | null;
  rankedRecommendations: MockRecommendation[] | null;
  discoveryData: Record<string, unknown> | null;
  platformDetected: string | null;

  // Generated files
  generatedLlmsTxt: string | null;
  generatedLlmsFullTxt: string | null;
  generatedBusinessJson: Record<string, unknown> | null;
  generatedSchemaBlocks: Record<string, unknown> | null;

  // Pipeline state
  pipelineStatus: string;
  pipelineError: string | null;

  // Site metadata
  shareToken: string | null;
  domainVerified: boolean;
  verifyToken: string | null;
  changeLog: unknown[];
  manualRunsMonth: number;
  crawlCount: number;
  pageCount: number;
  lastCrawlAt: Date | null;
  nextCrawlAt: Date | null;
  createdAt: Date;
  baselineScorecard: Record<string, unknown> | null;
  perPageResults: unknown[] | null;
  perPageFixes: unknown[] | null;
  implementationStatus: unknown[] | null;
}

export function mockSite(overrides: Partial<MockSite> = {}): MockSite {
  const scorecard = mockScorecard(3);
  const recs = mockRecommendations(5);

  return {
    siteId: "site-test-1",
    domain: "example.com",
    slug: "example-com",
    teamId: null,
    accessToken: "test-token",
    tokenExpiresAt: new Date(Date.now() + 30 * 86_400_000), // 30 days ahead

    overallScore: scorecard.overallScore,
    previousScore: null,
    projectedScore: 85,
    projectedBoost: 15,
    baselineScore: null,
    pillars: scorecard.pillars,

    executiveSummary:
      "This is paragraph one.\n\nThis is paragraph two.\n\nThis is paragraph three.",
    rankedRecommendations: recs,
    discoveryData: { hasLlmsTxt: false },
    platformDetected: "wordpress",

    generatedLlmsTxt: "# llms.txt content",
    generatedLlmsFullTxt: "# Full llms.txt content",
    generatedBusinessJson: { name: "Test Business" },
    generatedSchemaBlocks: { "@type": "Organization" },

    pipelineStatus: "complete",
    pipelineError: null,
    shareToken: "share-abc123",
    domainVerified: false,
    verifyToken: "verify-token",
    changeLog: [],
    manualRunsMonth: 0,
    crawlCount: 1,
    pageCount: 0,
    lastCrawlAt: new Date("2026-02-20"),
    nextCrawlAt: new Date("2026-03-20"),
    createdAt: new Date("2026-02-01"),
    baselineScorecard: null,
    perPageResults: null,
    perPageFixes: null,
    implementationStatus: null,

    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Assertion Helpers
// ---------------------------------------------------------------------------

/**
 * Asserts all free-tier gating rules in one call:
 * - tier === "free", credits present
 * - Pillar findings/recommendation/impactedPages stripped
 * - Executive summary truncated (no double newlines)
 * - Max 3 recommendations with only title/pillar/priority
 * - All generated files null
 */
export function assertFreeGating(body: Record<string, unknown>): void {
  // tier and credits must be present
  expect(body.tier).toBe("free");
  expect(body).toHaveProperty("credits");

  // Scorecard: pillar stripping
  if (body.geoScorecard != null) {
    const scorecard = body.geoScorecard as {
      pillars?: Array<Record<string, unknown>>;
    };
    if (scorecard.pillars) {
      for (const pillar of scorecard.pillars) {
        expect(pillar).not.toHaveProperty("findings");
        expect(pillar).not.toHaveProperty("recommendation");
        expect(pillar).not.toHaveProperty("impactedPages");
        // Retained fields
        expect(pillar).toHaveProperty("pillar");
        expect(pillar).toHaveProperty("pillarName");
        expect(pillar).toHaveProperty("score");
      }
    }
  }

  // Executive summary: first paragraph only (no double newlines)
  if (body.executiveSummary != null && (body.executiveSummary as string).length > 0) {
    expect(body.executiveSummary as string).not.toContain("\n\n");
  }

  // Recommendations: max 3, restricted fields
  const recs = body.rankedRecommendations as
    | Array<Record<string, unknown>>
    | undefined;
  if (recs && recs.length > 0) {
    expect(recs.length).toBeLessThanOrEqual(3);
    for (const rec of recs) {
      expect(rec).toHaveProperty("title");
      expect(rec).toHaveProperty("pillar");
      expect(rec).toHaveProperty("priority");
      expect(rec).not.toHaveProperty("findings");
      expect(rec).not.toHaveProperty("recommendation");
      expect(rec).not.toHaveProperty("impactedPages");
    }
  }

  // Generated files: all null
  expect(body.generatedLlmsTxt).toBeNull();
  expect(body.generatedLlmsFullTxt).toBeNull();
  expect(body.generatedBusinessJson).toBeNull();
  expect(body.generatedSchemaBlocks).toBeNull();
}

/**
 * Asserts all paid-tier fields are present and complete:
 * - tier === "paid", credits present
 * - Full scorecard with findings
 * - Full executive summary
 * - All recommendations with full detail
 * - All generated files present
 */
export function assertPaidFull(body: Record<string, unknown>): void {
  expect(body.tier).toBe("paid");
  expect(body).toHaveProperty("credits");

  // Scorecard: full data with findings
  if (body.geoScorecard != null) {
    const scorecard = body.geoScorecard as {
      pillars?: Array<Record<string, unknown>>;
    };
    if (scorecard.pillars && scorecard.pillars.length > 0) {
      for (const pillar of scorecard.pillars) {
        expect(pillar).toHaveProperty("findings");
        expect(pillar).toHaveProperty("recommendation");
        expect(pillar).toHaveProperty("impactedPages");
      }
    }
  }

  // Generated files: present
  expect(body.generatedLlmsTxt).not.toBeNull();
  expect(body.generatedLlmsFullTxt).not.toBeNull();
  expect(body.generatedBusinessJson).not.toBeNull();
  expect(body.generatedSchemaBlocks).not.toBeNull();
}

// ---------------------------------------------------------------------------
// Request Builders
// ---------------------------------------------------------------------------

/**
 * Creates a NextRequest for GET /api/sites/[id] with Bearer token auth.
 */
export function createTestRequest(siteId: string, token: string): NextRequest {
  return new NextRequest(
    new Request(`http://localhost/api/sites/${siteId}`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
      },
    })
  );
}

/**
 * Creates the route context { params } expected by Next.js App Router handlers.
 * params is a Promise (Next.js 15+ pattern).
 */
export function createRouteContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

/**
 * Creates a NextRequest for GET /api/report/[shareToken].
 */
export function createReportRequest(shareToken: string): NextRequest {
  return new NextRequest(
    new Request(`http://localhost/api/report/${shareToken}`, {
      method: "GET",
    })
  );
}

/**
 * Creates the route context for /api/report/[shareToken].
 */
export function createReportRouteContext(shareToken: string) {
  return { params: Promise.resolve({ shareToken }) };
}

// ---------------------------------------------------------------------------
// DB Mock Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a mock select chain: db.select().from(table).where(condition)
 * Returns the given rows when .where() is resolved.
 */
export function makeSelectChain(rows: unknown[] = []) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
    limit: vi.fn().mockReturnThis(),
  };
}

/**
 * Creates a mock select chain where .where() throws (simulates DB error).
 */
export function makeSelectChainWithError(error: Error) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockRejectedValue(error),
    limit: vi.fn().mockReturnThis(),
  };
}
