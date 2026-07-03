/**
 * Phase 10A — ZIP Download Styling Tests
 *
 * Tests for GEO brand styling in report-generator.ts
 */

import { describe, it, expect } from "vitest";
import { generateAggregateHtml, generatePerPageHtml } from "@/lib/services/report-generator";

const mockSite = {
  domain: "example.com",
  geoScorecard: {
    overallScore: 72,
    pillars: [{ pillarName: "Content Quality", score: 80, priority: "high" }],
    topThreeImprovements: ["Add schema markup", "Improve meta descriptions", "Add FAQ sections"],
  },
  executiveSummary: "This is a test summary.",
};

const mockResults = [
  {
    url: "https://example.com/page1",
    overallPageHealth: "good" as const,
    vulnerabilities: [],
    geoScore: 85,
    citationReadinessScore: 90,
    pillarScores: {},
    title: "Page 1",
    pageType: "home",
    extractedContent: { title: "Page 1", metaDescription: "Desc", h1: "H1", wordCount: 500, hasStructuredData: true, internalLinks: 0, externalLinks: 0, imagesWithAlt: 0, imagesWithoutAlt: 0 },
  },
];

const mockPerPageResult = mockResults[0];

describe("report-generator — GEO styling", () => {
  it("aggregate HTML uses GEO background color #0a0e1a", () => {
    const html = generateAggregateHtml(mockSite, mockResults, [], []);
    expect(html).toContain("#0a0e1a");
  });

  it("aggregate HTML imports JetBrains Mono font", () => {
    const html = generateAggregateHtml(mockSite, mockResults, [], []);
    expect(html).toContain("JetBrains+Mono");
  });

  it("aggregate HTML contains card class wrappers", () => {
    const html = generateAggregateHtml(mockSite, mockResults, [], []);
    expect(html).toContain('class="card"');
  });

  it("per-page HTML uses GEO background color", () => {
    const html = generatePerPageHtml(mockPerPageResult, "example.com");
    expect(html).toContain("#0a0e1a");
  });

  it("per-page HTML critical badge uses rgba not solid red", () => {
    const result = {
      ...mockPerPageResult,
      vulnerabilities: [{ severity: "critical" as const, pillar: "content", pillarName: "Content", finding: "Bad", recommendation: "Fix it" }],
    };
    const html = generatePerPageHtml(result, "example.com");
    expect(html).toMatch(/rgba\(239.*68.*68/);
  });

  it("HTML includes GEO brand footer text", () => {
    const html = generateAggregateHtml(mockSite, mockResults, [], []);
    expect(html.toLowerCase()).toContain("flowblinq");
  });
});
