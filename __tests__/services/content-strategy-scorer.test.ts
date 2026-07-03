/**
 * ES-055 — C8: Content Strategy Scoring
 * Tests U1–U15
 *
 * Spec: scoreQuotations(), scoreStatistics(), scoreCitedSources(),
 *       scorePageStrategies(), aggregateStrategyReport()
 * All regex-based / deterministic — no LLM.
 */

import { describe, it, expect } from "vitest";

import {
  scoreQuotations,
  scoreStatistics,
  scoreCitedSources,
  scorePageStrategies,
  aggregateStrategyReport,
} from "@/lib/services/content-strategy-scorer";

import type {
  QuotationScore,
  StatisticsScore,
  CitationSourceScore,
  PageStrategyScores,
  ContentStrategyReport,
} from "@/lib/types/content-strategy";

// ── Helpers ──────────────────────────────────────────────────────

function makePage(content: string, overrides: Partial<{ url: string; wordCount: number }> = {}) {
  return {
    url: overrides.url ?? "https://example.com/page",
    title: "Test Page",
    content,
    pageType: "services",
    wordCount: overrides.wordCount ?? content.split(/\s+/).length,
    existingSchema: "",
    contactInfo: "",
    faqContent: [],
    headings: [],
    metaDescription: "",
    links: [],
  };
}

// ── U1–U4: scoreQuotations ──────────────────────────────────────

describe("scoreQuotations — ES-055 C8", () => {
  it("U1 — finds <blockquote> occurrences", () => {
    const content = `
      <p>Our approach to care is unique.</p>
      <blockquote>Healthcare should be accessible to everyone.</blockquote>
      <p>More content here.</p>
    `;
    const result = scoreQuotations(content);
    expect(result.count).toBeGreaterThanOrEqual(1);
  });

  it("U2 — finds attributed quotes with score = 100", () => {
    const content = `
      "Innovation in healthcare is not optional, it is essential for survival" — Dr. Smith

      According to Dr. Johnson, the study shows significant improvement in patient outcomes.
    `;
    const result = scoreQuotations(content);
    expect(result.hasAttribution).toBe(true);
    expect(result.score).toBe(100);
  });

  it("U3 — returns 0 for plain text without quotes", () => {
    const content = `
      Our hospital provides excellent care to all patients.
      We have been serving the community for over 20 years.
      Contact us today for more information about our services.
    `;
    const result = scoreQuotations(content);
    expect(result.count).toBe(0);
    expect(result.score).toBe(0);
  });

  it("U4 — finds 'According to' pattern", () => {
    const content = `
      According to Dr. Johnson, the treatment outcomes improved by 40%.
      The research was published in a leading medical journal.
    `;
    const result = scoreQuotations(content);
    expect(result.count).toBeGreaterThanOrEqual(1);
  });
});

// ── U5–U9: scoreStatistics ──────────────────────────────────────

describe("scoreStatistics — ES-055 C8", () => {
  it("U5 — finds percentage values", () => {
    const content = "Revenue grew by 45% in 2025, marking a significant milestone for the company.";
    const result = scoreStatistics(content);
    expect(result.count).toBeGreaterThanOrEqual(1);
  });

  it("U6 — finds monetary values", () => {
    const content = "The company raised $2.5 million in Series A funding from top-tier investors.";
    const result = scoreStatistics(content);
    expect(result.count).toBeGreaterThanOrEqual(1);
  });

  it("U7 — finds comparative phrases and multipliers", () => {
    const content = "Performance increased by 3x compared to baseline measurements in the control group.";
    const result = scoreStatistics(content);
    expect(result.count).toBeGreaterThanOrEqual(1);
  });

  it("U8 — finds table elements", () => {
    const content = `
      <table>
        <tr><td>Metric</td><td>Value</td></tr>
        <tr><td>Revenue</td><td>$10M</td></tr>
      </table>
    `;
    const result = scoreStatistics(content);
    expect(result.count).toBeGreaterThanOrEqual(1);
  });

  it("U9 — returns 0 for narrative text with no numbers", () => {
    const content = `
      Our team is dedicated to providing the best service possible.
      We believe in building long-term relationships with our clients.
      Excellence is at the core of everything we do as a company.
    `;
    const result = scoreStatistics(content);
    expect(result.count).toBe(0);
    expect(result.score).toBe(0);
  });
});

// ── U10–U12: scoreCitedSources ──────────────────────────────────

describe("scoreCitedSources — ES-055 C8", () => {
  it("U10 — finds external links with >2 word anchor text", () => {
    const content = `
      [Research paper on outcomes](https://example.edu/paper)
      [Another research study](https://pubmed.ncbi.nlm.nih.gov/12345)
    `;
    const result = scoreCitedSources(content);
    expect(result.externalLinkCount).toBeGreaterThanOrEqual(1);
  });

  it("U11 — identifies authoritative domains (.gov, .edu)", () => {
    const content = `
      [CDC guidelines on prevention](https://www.cdc.gov/guidelines)
      [University study results](https://research.stanford.edu/study)
      [Regular blog post](https://randomsite.com/blog)
    `;
    const result = scoreCitedSources(content);
    expect(result.authoritativeLinkCount).toBeGreaterThanOrEqual(2);
  });

  it("U12 — finds inline citation patterns", () => {
    const content = `
      Studies have shown significant improvement (Smith, 2024).
      The methodology follows established protocols [1].
      According to [Johnson et al.], the results are conclusive.
    `;
    const result = scoreCitedSources(content);
    expect(result.inlineCitationCount).toBeGreaterThanOrEqual(1);
  });
});

// ── U13–U15: Composite + Aggregate ──────────────────────────────

describe("scorePageStrategies + aggregateStrategyReport — ES-055 C8", () => {
  it("U13 — composite score with all 100s equals 100", () => {
    // Page with all strategy signals present and attributed
    const content = `
      <blockquote>"Healthcare innovation drives better outcomes for everyone" — Dr. Smith</blockquote>

      According to Dr. Johnson, patient satisfaction increased by 45% after implementation.
      Revenue grew by $2.5 million in the first year, a 3x improvement over baseline.

      [CDC research paper](https://www.cdc.gov/research) confirms these findings (Smith, 2024).
      [Stanford study on outcomes](https://stanford.edu/study) provides additional evidence [1].

      <table>
        <tr><td>Metric</td><td>Before</td><td>After</td></tr>
        <tr><td>Satisfaction</td><td>60%</td><td>95%</td></tr>
      </table>
    `;

    const page = makePage(content);
    const result = scorePageStrategies(page as any);

    // All three should be 100 (quotes with attribution, stats with source, authoritative citations)
    expect(result.quotations.score).toBe(100);
    expect(result.statistics.score).toBe(100);
    expect(result.citations.score).toBe(100);
    // Composite: 100*0.41 + 100*0.33 + 100*0.26 = 100
    expect(result.compositeScore).toBe(100);
  });

  it("U14 — aggregateStrategyReport averages correctly across pages", () => {
    const pages = [
      makePage(`<blockquote>"Quote one" — Dr. A</blockquote> Revenue grew by 50%. [Study](https://example.edu/1) (Jones, 2023).`),
      makePage(`<blockquote>"Quote two" — Dr. B</blockquote> Performance up 30%. [Paper](https://example.gov/2) [1].`),
      makePage("Plain text without any strategies or quotes or data at all here."),
      makePage("More plain text that contains no evidence or quotations whatsoever."),
      makePage("Yet another simple page without any data points or references."),
      makePage("Sixth page with no strategy signals detected by the scorer."),
      makePage("Seventh page that is also plain text without markers."),
      makePage("Eighth page no quotes no stats no citations at all."),
      makePage("Ninth page pure narrative content without any markers."),
      makePage("Tenth page also without any quotes statistics or links."),
    ];

    const report = aggregateStrategyReport(pages as any[]);

    // 2 of 10 pages have quotes → pagesWithQuotes = 2
    expect(report.quotations.pagesWithQuotes).toBe(2);
    expect(report.quotations.pagesTotal).toBe(10);
    // Overall scores should be averaged
    expect(report.quotations.overallScore).toBeGreaterThan(0);
    expect(report.quotations.overallScore).toBeLessThan(100);
  });

  it("U15 — aggregateStrategyReport handles 0 pages", () => {
    const report = aggregateStrategyReport([]);

    expect(report.quotations.pagesTotal).toBe(0);
    expect(report.quotations.avgPerPage).toBe(0);
    expect(report.quotations.overallScore).toBe(0);
    expect(report.statistics.pagesTotal).toBe(0);
    expect(report.citations.pagesTotal).toBe(0);
  });
});
