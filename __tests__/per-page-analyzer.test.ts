/**
 * Unit tests for lib/services/per-page-analyzer.ts — ES-005 Task 3
 *
 * 17 test cases covering:
 *   - Rule 1a: Missing H1 → semantic_html high
 *   - Rule 1b: Multiple H1s → semantic_html medium
 *   - Rule 2: No structured data → structured_data high
 *   - Rule 3: Thin content — critical (<100 chars), medium (100-299 chars)
 *   - Rule 4: No FAQ on content pages (services, pricing, faq, about)
 *   - Rule 5: No contact info on trust pages (homepage, about, contact, services)
 *   - Rule 6: No author on blog/case-studies/docs
 *   - Rule 7: Missing title tag → metadata_freshness critical
 *   - Rule 8: Scorecard impactedPages correlation
 *   - Health thresholds: poor, needs-work, good
 *   - Good page: all signals present → 0 vulnerabilities
 */

import { describe, it, expect } from "vitest";
import { extractPerPageVulnerabilities } from "@/lib/services/per-page-analyzer";
import type { CrawledPage, CrawlData } from "@/lib/services/geo-crawler";

// ── Test helpers ──────────────────────────────────────────────────────────────

function makePage(overrides: Partial<CrawledPage> = {}): CrawledPage {
  return {
    url: "https://acme.io/test",
    pageType: "homepage",
    title: "Acme Test Page",
    h1: "Welcome to Acme",
    headings: [{ level: 1, text: "Welcome to Acme" }],
    content: "A".repeat(600), // well above 300-char threshold
    existingSchema: ['{"@type":"Organization"}'],
    hasStructuredData: true,
    contactInfo: ["hello@acme.io"],
    faqContent: [],
    testimonials: [],
    certifications: [],
    ...overrides,
  };
}

function makeCrawlData(pages: CrawledPage[]): CrawlData {
  return { domain: "acme.io", pages, totalCrawled: pages.length };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("extractPerPageVulnerabilities()", () => {
  // ── Rule 1a: Missing H1 ──

  it("flags semantic_html/high when H1 is empty string", () => {
    const page = makePage({ h1: "", headings: [] });
    const [result] = extractPerPageVulnerabilities(makeCrawlData([page]));

    const vuln = result.vulnerabilities.find((v) => v.pillar === "semantic_html" && v.severity === "high");
    expect(vuln).toBeDefined();
    expect(vuln!.finding).toMatch(/no H1/i);
  });

  it("flags semantic_html/high when H1 is whitespace only", () => {
    const page = makePage({ h1: "   ", headings: [] });
    const [result] = extractPerPageVulnerabilities(makeCrawlData([page]));

    const vuln = result.vulnerabilities.find((v) => v.pillar === "semantic_html" && v.severity === "high");
    expect(vuln).toBeDefined();
  });

  // ── Rule 1b: Multiple H1s ──

  it("flags semantic_html/medium when headings array has 3 H1s", () => {
    const page = makePage({
      h1: "Primary H1",
      headings: [
        { level: 1, text: "Primary H1" },
        { level: 1, text: "Duplicate H1" },
        { level: 1, text: "Another H1" },
      ],
    });
    const [result] = extractPerPageVulnerabilities(makeCrawlData([page]));

    const vuln = result.vulnerabilities.find(
      (v) => v.pillar === "semantic_html" && v.severity === "medium"
    );
    expect(vuln).toBeDefined();
    expect(vuln!.finding).toContain("3");
  });

  // ── Rule 2: No structured data ──

  it("flags structured_data/high when hasStructuredData is false and existingSchema is empty", () => {
    const page = makePage({ hasStructuredData: false, existingSchema: [] });
    const [result] = extractPerPageVulnerabilities(makeCrawlData([page]));

    const vuln = result.vulnerabilities.find((v) => v.pillar === "structured_data");
    expect(vuln).toBeDefined();
    expect(vuln!.severity).toBe("high");
    expect(vuln!.finding).toMatch(/no json-ld/i);
  });

  it("does NOT flag structured_data when hasStructuredData=true and schema is present", () => {
    const page = makePage({ hasStructuredData: true, existingSchema: ['{"@type":"Article"}'] });
    const [result] = extractPerPageVulnerabilities(makeCrawlData([page]));

    const vuln = result.vulnerabilities.find((v) => v.pillar === "structured_data");
    expect(vuln).toBeUndefined();
  });

  // ── Rule 3: Thin content ──

  it("flags content_structure/critical for content < 100 chars", () => {
    const page = makePage({ content: "Short." }); // 6 chars
    const [result] = extractPerPageVulnerabilities(makeCrawlData([page]));

    const vuln = result.vulnerabilities.find((v) => v.pillar === "content_structure");
    expect(vuln).toBeDefined();
    expect(vuln!.severity).toBe("critical");
  });

  it("flags content_structure/medium for content between 100-299 chars", () => {
    const page = makePage({ content: "B".repeat(150) }); // 150 chars
    const [result] = extractPerPageVulnerabilities(makeCrawlData([page]));

    const vuln = result.vulnerabilities.find((v) => v.pillar === "content_structure");
    expect(vuln).toBeDefined();
    expect(vuln!.severity).toBe("medium");
  });

  it("does NOT flag content_structure for content >= 300 chars", () => {
    const page = makePage({ content: "C".repeat(300) });
    const [result] = extractPerPageVulnerabilities(makeCrawlData([page]));

    expect(result.vulnerabilities.find((v) => v.pillar === "content_structure")).toBeUndefined();
  });

  // ── Rule 4: No FAQ on content pages ──

  it("flags faq_coverage/medium on 'services' page with empty faqContent", () => {
    const page = makePage({ pageType: "services", faqContent: [] });
    const [result] = extractPerPageVulnerabilities(makeCrawlData([page]));

    const vuln = result.vulnerabilities.find((v) => v.pillar === "faq_coverage");
    expect(vuln).toBeDefined();
    expect(vuln!.severity).toBe("medium");
  });

  it("does NOT flag faq_coverage on 'blog' page (not a content page type)", () => {
    const page = makePage({ pageType: "blog", faqContent: [] });
    const [result] = extractPerPageVulnerabilities(makeCrawlData([page]));

    expect(result.vulnerabilities.find((v) => v.pillar === "faq_coverage")).toBeUndefined();
  });

  // ── Rule 5: No contact info on trust pages ──

  it("flags contact_trust/critical on 'contact' page with empty contactInfo", () => {
    const page = makePage({ pageType: "contact", contactInfo: [] });
    const [result] = extractPerPageVulnerabilities(makeCrawlData([page]));

    const vuln = result.vulnerabilities.find((v) => v.pillar === "contact_trust");
    expect(vuln).toBeDefined();
    expect(vuln!.severity).toBe("critical");
  });

  it("flags contact_trust/medium on 'homepage' page with empty contactInfo", () => {
    const page = makePage({ pageType: "homepage", contactInfo: [] });
    const [result] = extractPerPageVulnerabilities(makeCrawlData([page]));

    const vuln = result.vulnerabilities.find((v) => v.pillar === "contact_trust");
    expect(vuln).toBeDefined();
    expect(vuln!.severity).toBe("medium");
  });

  // ── Rule 6: No author on author pages ──

  it("flags author_authority/medium on 'blog' page with no author signals", () => {
    const page = makePage({
      pageType: "blog",
      content: "B".repeat(600), // no "author" keyword
      existingSchema: ['{"@type":"Article"}'], // no Person/Author
    });
    const [result] = extractPerPageVulnerabilities(makeCrawlData([page]));

    const vuln = result.vulnerabilities.find((v) => v.pillar === "author_authority");
    expect(vuln).toBeDefined();
    expect(vuln!.severity).toBe("medium");
  });

  // ── Rule 7: Missing title ──

  it("flags metadata_freshness/critical when title is empty", () => {
    const page = makePage({ title: "" });
    const [result] = extractPerPageVulnerabilities(makeCrawlData([page]));

    const vuln = result.vulnerabilities.find((v) => v.pillar === "metadata_freshness");
    expect(vuln).toBeDefined();
    expect(vuln!.severity).toBe("critical");
  });

  // ── Rule 8: Scorecard impactedPages correlation ──

  it("adds low-severity vuln from scorecard impactedPages when URL matches", () => {
    const page = makePage({
      url: "https://acme.io/about",
      hasStructuredData: true,
      existingSchema: ["Article"],
      contactInfo: ["phone"],
    });
    const scorecard = {
      pillars: [
        {
          pillar: "llms_txt",
          impactedPages: ["https://acme.io/about"],
        },
      ],
    };
    const [result] = extractPerPageVulnerabilities(makeCrawlData([page]), scorecard);

    const vuln = result.vulnerabilities.find((v) => v.pillar === "llms_txt" && v.severity === "low");
    expect(vuln).toBeDefined();
  });

  // ── Health thresholds ──

  it("sets overallPageHealth='poor' when any critical vulnerability is present", () => {
    // Missing title → critical
    const page = makePage({ title: "" });
    const [result] = extractPerPageVulnerabilities(makeCrawlData([page]));
    expect(result.overallPageHealth).toBe("poor");
  });

  it("sets overallPageHealth='good' for a fully healthy page", () => {
    const page = makePage({
      h1: "Heading",
      headings: [{ level: 1, text: "Heading" }],
      title: "Good Page",
      content: "D".repeat(600),
      hasStructuredData: true,
      existingSchema: ['{"@type":"Organization"}'],
      contactInfo: ["email@example.com"],
      pageType: "other" as const, // not a trust/faq/author page type
    });
    const [result] = extractPerPageVulnerabilities(makeCrawlData([page]));
    expect(result.overallPageHealth).toBe("good");
    expect(result.vulnerabilities).toHaveLength(0);
  });

  it("preserves url, pageType, and title in the result", () => {
    const page = makePage({
      url: "https://acme.io/pricing",
      pageType: "pricing",
      title: "Pricing Plans",
    });
    const [result] = extractPerPageVulnerabilities(makeCrawlData([page]));

    expect(result.url).toBe("https://acme.io/pricing");
    expect(result.pageType).toBe("pricing");
    expect(result.title).toBe("Pricing Plans");
  });
});
