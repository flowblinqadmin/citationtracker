/**
 * ES-054 — Cross: Crawl Coverage Validation
 * Tests U23–U27
 *
 * Spec: validateCrawlCoverage() — pure function, no LLM.
 */

import { describe, it, expect } from "vitest";

import { validateCrawlCoverage } from "@/lib/services/crawl-coverage-validator";

import type { CrawlCoverageReport } from "@/lib/types/citation";

// ── Helpers ──────────────────────────────────────────────────────

function makePage(pageType: string, url?: string) {
  return {
    url: url ?? `https://example.com/${pageType}`,
    title: `${pageType} page`,
    content: "Page content here.",
    pageType,
    wordCount: 300,
    existingSchema: "",
    contactInfo: "",
    faqContent: [],
    headings: [],
    metaDescription: "",
    links: [],
  };
}

function makeDiscoveryData(totalPages: number) {
  return { totalPages };
}

function makeCrawlData(pages: ReturnType<typeof makePage>[]) {
  return {
    pages,
    domain: "example.com",
    crawledAt: new Date().toISOString(),
  };
}

// ── U23–U27 ─────────────────────────────────────────────────────

describe("validateCrawlCoverage — ES-054 Cross", () => {
  it("U23 — full coverage: 100%, no warnings", () => {
    const pages = [
      makePage("homepage"),
      makePage("about"),
      makePage("services"),
      makePage("pricing"),
      makePage("contact"),
      makePage("team"),
      makePage("faq"),
      ...Array.from({ length: 93 }, (_, i) => makePage("blog", `https://example.com/blog/post-${i}`)),
    ];

    const report = validateCrawlCoverage(makeDiscoveryData(100), makeCrawlData(pages));

    expect(report.totalDiscovered).toBe(100);
    expect(report.totalCrawled).toBe(100);
    expect(report.coveragePercent).toBe(100);
    expect(report.missingPageTypes).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it("U24 — low coverage: 10%, produces warning", () => {
    const pages = Array.from({ length: 50 }, (_, i) =>
      makePage("blog", `https://example.com/blog/post-${i}`)
    );

    const report = validateCrawlCoverage(makeDiscoveryData(500), makeCrawlData(pages));

    expect(report.coveragePercent).toBe(10);
    expect(report.warnings.length).toBeGreaterThanOrEqual(1);
    const coverageWarning = report.warnings.find((w) => w.includes("10%") || w.includes("crawled"));
    expect(coverageWarning).toBeDefined();
  });

  it("U25 — missing structural page types detected", () => {
    const pages = [
      makePage("homepage"),
      makePage("about"),
      makePage("blog"),
      makePage("blog", "https://example.com/blog/2"),
    ];

    const report = validateCrawlCoverage(makeDiscoveryData(4), makeCrawlData(pages));

    // Expected types: homepage, about, services, pricing, contact, faq
    // Missing: services, pricing, contact, faq
    expect(report.missingPageTypes).toContain("services");
    expect(report.missingPageTypes).toContain("pricing");
    expect(report.missingPageTypes).toContain("contact");
    expect(report.missingPageTypes).toContain("faq");
  });

  it("U26 — blog-heavy crawl (>60%) produces warning", () => {
    const pages = [
      makePage("homepage"),
      ...Array.from({ length: 9 }, (_, i) => makePage("blog", `https://example.com/blog/${i}`)),
    ];

    const report = validateCrawlCoverage(makeDiscoveryData(10), makeCrawlData(pages));

    expect(report.blogPercent).toBe(90);
    const blogWarning = report.warnings.find((w) => w.toLowerCase().includes("blog"));
    expect(blogWarning).toBeDefined();
  });

  it("U27 — empty crawl: 0% coverage, warnings present", () => {
    const report = validateCrawlCoverage(makeDiscoveryData(100), makeCrawlData([]));

    expect(report.totalCrawled).toBe(0);
    expect(report.coveragePercent).toBe(0);
    expect(report.warnings.length).toBeGreaterThanOrEqual(1);
  });
});
