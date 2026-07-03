/**
 * Unit tests for lib/services/report-generator.ts — ES-005 Task 3
 *
 * 10 test cases covering:
 *   - generatePerPageHtml: structure, vulnerability rendering, healthy page message
 *   - generateAggregateHtml: score class, pillar sort, health distribution
 *   - escapeHtml: XSS prevention for all attack vectors
 */

import { describe, it, expect } from "vitest";
import {
  generatePerPageHtml,
  generateAggregateHtml,
  escapeHtml,
} from "@/lib/services/report-generator";
import type { PerPageResult } from "@/lib/services/per-page-analyzer";

// ── Test helpers ──────────────────────────────────────────────────────────────

function makePerPageResult(overrides: Partial<PerPageResult> = {}): PerPageResult {
  return {
    url: "https://acme.io/about",
    pageType: "about",
    title: "About Acme",
    vulnerabilities: [],
    overallPageHealth: "good",
    ...overrides,
  };
}

function makeSiteForReport(overrides: Partial<{
  domain: string;
  geoScorecard: { overallScore: number; pillars: Array<{ pillarName: string; score: number; priority: string }>; topThreeImprovements: string[] };
  executiveSummary: string;
}> = {}) {
  return {
    domain: "acme.io",
    geoScorecard: {
      overallScore: 72,
      pillars: [
        { pillarName: "Structured Data", score: 45, priority: "critical" },
        { pillarName: "Semantic HTML", score: 80, priority: "medium" },
      ],
      topThreeImprovements: [
        "Add JSON-LD markup",
        "Improve FAQ coverage",
        "Add author attribution",
      ],
    },
    executiveSummary: "This site needs structured data improvements.",
    ...overrides,
  };
}

// ── generatePerPageHtml ───────────────────────────────────────────────────────

describe("generatePerPageHtml()", () => {
  it("returns a valid HTML document containing the page title", () => {
    const result = makePerPageResult({ title: "About Acme", url: "https://acme.io/about" });
    const html = generatePerPageHtml(result, "acme.io");

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("About Acme");
  });

  it("renders each vulnerability with severity badge and finding text", () => {
    const result = makePerPageResult({
      vulnerabilities: [
        {
          pillar: "structured_data",
          pillarName: "Structured Data",
          severity: "high",
          finding: "No JSON-LD found.",
          recommendation: "Add schema markup.",
        },
      ],
      overallPageHealth: "needs-work",
    });
    const html = generatePerPageHtml(result, "acme.io");

    expect(html).toContain("HIGH");
    expect(html).toContain("Structured Data");
    expect(html).toContain("No JSON-LD found.");
    expect(html).toContain("Add schema markup.");
  });

  it("shows healthy message when there are no vulnerabilities", () => {
    const result = makePerPageResult({ vulnerabilities: [], overallPageHealth: "good" });
    const html = generatePerPageHtml(result, "acme.io");

    expect(html).toContain("No vulnerabilities detected");
  });

  it("includes the domain in the footer attribution", () => {
    const html = generatePerPageHtml(makePerPageResult(), "acme.io");
    expect(html).toContain("acme.io");
  });

  it("escapes XSS in page title and URL", () => {
    const result = makePerPageResult({
      title: '<script>alert("xss")</script>',
      url: "https://acme.io/test?x=<b>bold</b>",
    });
    const html = generatePerPageHtml(result, "acme.io");

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<b>bold</b>");
  });
});

// ── generateAggregateHtml ─────────────────────────────────────────────────────

describe("generateAggregateHtml()", () => {
  it("uses 'fair' score class for overall score 72 (50-79 range)", () => {
    const site = makeSiteForReport({ geoScorecard: { overallScore: 72, pillars: [], topThreeImprovements: [] } });
    const html = generateAggregateHtml(site, []);

    expect(html).toContain('class="score fair"');
    expect(html).toContain("72/100");
  });

  it("uses 'good' score class for overall score >= 80", () => {
    const site = makeSiteForReport({ geoScorecard: { overallScore: 83, pillars: [], topThreeImprovements: [] } });
    const html = generateAggregateHtml(site, []);

    expect(html).toContain('class="score good"');
  });

  it("uses 'poor' score class for overall score < 50", () => {
    const site = makeSiteForReport({ geoScorecard: { overallScore: 38, pillars: [], topThreeImprovements: [] } });
    const html = generateAggregateHtml(site, []);

    expect(html).toContain('class="score poor"');
  });

  it("shows correct page health distribution counts", () => {
    const pages: PerPageResult[] = [
      makePerPageResult({ overallPageHealth: "good" }),
      makePerPageResult({ overallPageHealth: "good" }),
      makePerPageResult({ overallPageHealth: "needs-work" }),
      makePerPageResult({ overallPageHealth: "poor" }),
    ];
    const html = generateAggregateHtml(makeSiteForReport(), pages);

    // Distribution table should contain the counts
    expect(html).toContain(">2<"); // good: 2
    expect(html).toContain(">1<"); // needs-work: 1 AND poor: 1
  });

  it("escapes XSS in domain and executive summary", () => {
    const site = makeSiteForReport({
      domain: "<script>alert(1)</script>.io",
      executiveSummary: "<img src=x onerror=alert(1)>",
    });
    const html = generateAggregateHtml(site, []);

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<img");
  });
});

// ── escapeHtml ────────────────────────────────────────────────────────────────

describe("escapeHtml()", () => {
  it("escapes all four HTML special characters", () => {
    expect(escapeHtml('&<>"')).toBe("&amp;&lt;&gt;&quot;");
  });

  it("does not alter plain text", () => {
    expect(escapeHtml("Hello World")).toBe("Hello World");
  });
});
