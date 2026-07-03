/**
 * ES-054: Crawl Coverage Validation
 * Pure function — no LLM, no side effects.
 */

import type { CrawlCoverageReport } from "@/lib/types/citation";

const EXPECTED_STRUCTURAL_TYPES = ["homepage", "about", "services", "pricing", "contact", "team", "faq"];
const STRUCTURAL_TYPES = new Set(["homepage", "about", "services", "pricing", "contact", "team", "faq"]);

export function validateCrawlCoverage(
  discoveryData: { totalPages: number },
  crawlData: { pages: Array<{ pageType?: string; url?: string }> },
): CrawlCoverageReport {
  const totalDiscovered = discoveryData.totalPages;
  const totalCrawled = crawlData.pages.length;
  const coveragePercent = totalDiscovered > 0
    ? Math.round((totalCrawled / totalDiscovered) * 100)
    : 0;

  // Classify crawled pages by type
  const crawledTypes = new Set(crawlData.pages.map(p => p.pageType ?? "other"));

  const missingPageTypes = EXPECTED_STRUCTURAL_TYPES.filter(t => !crawledTypes.has(t));

  // Blog vs structural percentages
  const blogPages = crawlData.pages.filter(p => p.pageType === "blog" || p.pageType === "article").length;
  const structuralPages = crawlData.pages.filter(p => STRUCTURAL_TYPES.has(p.pageType ?? "")).length;

  const blogPercent = totalCrawled > 0 ? Math.round((blogPages / totalCrawled) * 100) : 0;
  const structuralPercent = totalCrawled > 0 ? Math.round((structuralPages / totalCrawled) * 100) : 0;

  // Warnings
  const warnings: string[] = [];

  if (coveragePercent < 50 && totalDiscovered > 0) {
    warnings.push(`Only ${coveragePercent}% of discovered pages were crawled`);
  }

  if (blogPercent > 60 && missingPageTypes.length > 0) {
    warnings.push(`Blog pages are ${blogPercent}% of crawl — structural pages may be under-represented`);
  }

  if (missingPageTypes.length > 0) {
    warnings.push(`Missing page types: ${missingPageTypes.join(", ")}`);
  }

  if (totalCrawled === 0) {
    warnings.push("No pages were crawled");
  }

  return {
    totalDiscovered,
    totalCrawled,
    coveragePercent,
    missingPageTypes,
    blogPercent,
    structuralPercent,
    warnings,
  };
}
