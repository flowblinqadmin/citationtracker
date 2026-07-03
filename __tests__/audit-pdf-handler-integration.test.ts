/**
 * Integration test: audit-pdf-handler → pdfData → rendered HTML
 *
 * FOLLOW-UP #7: Verifies that discoveryData fields (hasLlmsTxt, hasBusinessJson)
 * flow correctly from the handler's pdfData assembly into the rendered HTML
 * produced by the real generatePdfReportHtml.
 *
 * Strategy: we call the real generatePdfReportHtml directly with the same
 * pdfData shape that renderAuditPdfBuffer would assemble from a site record.
 * This tests the contract between the handler's field mapping and the template
 * rendering without needing Puppeteer or DB mocks.
 */

import { describe, it, expect } from "vitest";
import { generatePdfReportHtml, type PdfReportData } from "@/lib/services/pdf-report-html";

// ── Shared base fixture representing what renderAuditPdfBuffer assembles ──────

const baseSitePdfData: PdfReportData = {
  domain: "integ-test.com",
  overallScore: 60,
  pillars: [],
  recommendations: [],
  executiveSummary: null,
  lastCrawlAt: null,
  pageCount: 15,
  overallVisibility: null,
  citationRate: null,
  citationQualityScore: null,
  providerResults: [],
  competitorData: [],
  pillarVisibility: {},
  geoVisibility: [],
  categoryVisibility: [],
  tierVisibility: [],
  ourSOV: null,
  reportUrl: "https://geo.flowblinq.com/sites/integ-test",
};

// ── Integration tests ────────────────────────────────────────────────────────

describe("audit-pdf-handler integration — discoveryData → rendered checklist (FOLLOW-UP #7)", () => {
  it("renders svgCheck (polyline checkmark) for llms.txt when hasLlmsTxt is true", () => {
    // Mirrors: hasLlmsTxt: discovery?.hasLlmsTxt === true
    const html = generatePdfReportHtml({ ...baseSitePdfData, hasLlmsTxt: true });
    // svgCheck contains a polyline with these specific points
    expect(html).toContain("5,8.5 7,10.5 11,6");
    expect(html).toContain("Present — AI models can discover your site structure");
  });

  it("renders svgCross for llms.txt when hasLlmsTxt is false", () => {
    const html = generatePdfReportHtml({ ...baseSitePdfData, hasLlmsTxt: false });
    expect(html).toContain("Missing — AI models can&#x27;t find");
    // svgCheck polyline should NOT appear in the llms.txt tile context
    // (it may appear elsewhere if other checks pass, but we confirm the message)
  });

  it("renders svgCheck for business.json when hasBusinessJson is true", () => {
    // Mirrors: hasBusinessJson: ownBusinessJson has 4+ keys → true
    const html = generatePdfReportHtml({ ...baseSitePdfData, hasBusinessJson: true });
    expect(html).toContain("Present — structured business data available to AI");
    expect(html).toContain("5,8.5 7,10.5 11,6"); // svgCheck polyline
  });

  it("renders svgCross for business.json when hasBusinessJson is false", () => {
    // Mirrors: hasBusinessJson: ownBusinessJson is null/undefined → false
    const html = generatePdfReportHtml({ ...baseSitePdfData, hasBusinessJson: false });
    expect(html).toContain("Missing — AI has no structured way to read your business info");
  });

  it("renders both svgCheck icons when both hasLlmsTxt and hasBusinessJson are true", () => {
    const html = generatePdfReportHtml({
      ...baseSitePdfData,
      hasLlmsTxt: true,
      hasBusinessJson: true,
    });
    // Both present messages appear
    expect(html).toContain("Present — AI models can discover your site structure");
    expect(html).toContain("Present — structured business data available to AI");
    // No missing messages
    expect(html).not.toContain("Missing — AI models can&#x27;t find");
    expect(html).not.toContain("Missing — AI has no structured way to read your business info");
  });

  it("renders svgCross for both when hasLlmsTxt and hasBusinessJson are both false", () => {
    const html = generatePdfReportHtml({
      ...baseSitePdfData,
      hasLlmsTxt: false,
      hasBusinessJson: false,
    });
    expect(html).toContain("Missing — AI models can&#x27;t find");
    expect(html).toContain("Missing — AI has no structured way to read your business info");
  });
});
