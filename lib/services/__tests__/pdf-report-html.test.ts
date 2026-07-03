/**
 * Tests for pdf-report-html.ts — covers Tasks 1, 3, and 4 behavior
 * at the HTML-generation layer (no Puppeteer required).
 */

import { describe, it, expect } from "vitest";
import { generatePdfReportHtml, type PdfReportData } from "@/lib/services/pdf-report-html";

const basePdfData: PdfReportData = {
  domain: "example.com",
  overallScore: 42,
  pillars: [
    {
      pillar: "structured_data",
      pillarName: "Structured Data",
      score: 20,
      findings: "No schema markup found.",
      recommendation: "Add JSON-LD markup.",
      priority: "high",
    },
    {
      pillar: "content_depth",
      pillarName: "Content Depth",
      score: 60,
      findings: "Good depth.",
      recommendation: "Content Depth",  // same as pillarName — triggers Task 3b
      priority: "medium",
    },
  ],
  recommendations: [
    {
      rank: 1,
      title: "Add JSON-LD markup.",
      pillar: "structured_data",
      estimatedBoost: "+15",
      priority: "high",
    },
    {
      rank: 2,
      title: "Content Depth",  // matches pillarName exactly
      pillar: "content_depth",
      estimatedBoost: "+5",
      priority: "medium",
    },
  ],
  executiveSummary: "Test summary.",
  lastCrawlAt: "2024-01-01T00:00:00Z",
  pageCount: 25,
  overallVisibility: 30,
  citationRate: 20,
  citationQualityScore: 55,
  providerResults: [],
  competitorData: [],
  pillarVisibility: {},
  geoVisibility: [],
  categoryVisibility: [],
  tierVisibility: [],
  ourSOV: null,
  reportUrl: "https://geo.flowblinq.com/sites/test-id",
};

// ── Task 1: hasLlmsTxt / hasBusinessJson / hasRobotsTxt ──────────────────────

describe("pdf-report-html — AI readiness checklist", () => {
  it("shows missing text when hasLlmsTxt is false (default)", () => {
    const html = generatePdfReportHtml({ ...basePdfData, hasLlmsTxt: false });
    expect(html).toContain("Missing — AI models can&#x27;t find");
  });

  it("shows present text when hasLlmsTxt is true", () => {
    const html = generatePdfReportHtml({ ...basePdfData, hasLlmsTxt: true });
    expect(html).toContain("Present — AI models can discover your site structure");
  });

  it("shows missing text when hasBusinessJson is false", () => {
    const html = generatePdfReportHtml({ ...basePdfData, hasBusinessJson: false });
    expect(html).toContain("Missing — AI has no structured way to read your business info");
  });

  it("shows present text when hasBusinessJson is true", () => {
    const html = generatePdfReportHtml({ ...basePdfData, hasBusinessJson: true });
    expect(html).toContain("Present — structured business data available to AI");
  });

  it("shows stale count when stalePageCount > 0", () => {
    const html = generatePdfReportHtml({ ...basePdfData, stalePageCount: 7 });
    expect(html).toContain("7 pages have stale or missing dates");
  });

  it("shows all-fresh text when stalePageCount is 0", () => {
    const html = generatePdfReportHtml({ ...basePdfData, stalePageCount: 0 });
    expect(html).toContain("All pages have recent dates");
  });

  it("suppresses Content Freshness tile when stalePageCount is undefined", () => {
    // When stalePageCount is undefined (data not yet available), the tile
    // must not render at all — showing "All pages have recent dates" would
    // be misleading with no real freshness data.
    const html = generatePdfReportHtml({ ...basePdfData, stalePageCount: undefined });
    expect(html).not.toContain("Content Freshness");
    expect(html).not.toContain("All pages have recent dates");
  });
});

// ── Task 3a: No tofu boxes — SVG icons instead of emoji ──────────────────────

describe("pdf-report-html — SVG icon substitution (Task 3a)", () => {
  it("does not use U+2192 raw arrow in pillar fix lines", () => {
    // The old code had `→ ${rec.title}` with a literal arrow
    const html = generatePdfReportHtml(basePdfData);
    // The raw arrow U+2192 should not appear outside a legitimate context
    // We check it's not in the .p-fix class element, approximated by looking
    // for the class then arrow within ~100 chars
    const fixMatch = html.match(/class="p-fix"[^<]*→/);
    expect(fixMatch).toBeNull();
  });

  it("does not use raw emoji ✅ characters in readiness checklist", () => {
    const html = generatePdfReportHtml({ ...basePdfData, hasLlmsTxt: true });
    expect(html).not.toContain("✅"); // ✅
  });

  it("does not use raw emoji ❌ characters in readiness checklist", () => {
    const html = generatePdfReportHtml({ ...basePdfData, hasLlmsTxt: false });
    expect(html).not.toContain("❌"); // ❌
  });

  it("does not use raw emoji ⚠️ in stale page check", () => {
    const html = generatePdfReportHtml({ ...basePdfData, stalePageCount: 3 });
    expect(html).not.toContain("⚠"); // ⚠
  });

  it("uses inline SVG for check icon", () => {
    const html = generatePdfReportHtml({ ...basePdfData, hasLlmsTxt: true });
    expect(html).toContain("<svg");
  });
});

// ── Task 3b: Suppress duplicate pillar-name in fix line ──────────────────────

describe("pdf-report-html — duplicate pillar name suppression (Task 3b)", () => {
  it("does not render fix line when rec title matches pillarName exactly", () => {
    // "Content Depth" rec title === "Content Depth" pillar name
    const html = generatePdfReportHtml(basePdfData);
    // The p-fix div should NOT appear for the content_depth pillar card
    // We look for pattern: Content Depth card followed by p-fix with same text
    const contentDepthCardStart = html.indexOf("Content Depth</span>");
    const nextPfix = html.indexOf('class="p-fix"', contentDepthCardStart);
    const nextCard = html.indexOf('class="card"', contentDepthCardStart + 10);

    // If there's a p-fix before the next card, check it doesn't contain "Content Depth"
    if (nextPfix !== -1 && (nextCard === -1 || nextPfix < nextCard)) {
      const fixContent = html.slice(nextPfix, nextPfix + 200);
      expect(fixContent).not.toContain("Content Depth");
    }
    // OR: no p-fix at all in that card — acceptable
  });

  it("renders fix line when rec title differs from pillarName", () => {
    const html = generatePdfReportHtml(basePdfData);
    // "Structured Data" pillar has rec title "Add JSON-LD markup." — different
    // so the fix line should appear
    expect(html).toContain("Add JSON-LD markup.");
  });

  it("suppresses fix line when rec title matches pillarName with trailing punctuation", () => {
    // "Content Depth." (with period) should match pillar "Content Depth"
    const html = generatePdfReportHtml({
      ...basePdfData,
      pillars: [
        {
          pillar: "content_depth",
          pillarName: "Content Depth",
          score: 60,
          findings: "Good depth.",
          recommendation: "Content Depth.",
          priority: "medium",
        },
      ],
      recommendations: [
        {
          rank: 1,
          title: "Content Depth.",  // trailing period — should be deduplicated
          pillar: "content_depth",
          estimatedBoost: "+5",
          priority: "medium",
        },
      ],
    });
    // The p-fix div should NOT appear for the content_depth pillar card
    const contentDepthCardStart = html.indexOf("Content Depth</span>");
    const nextPfix = html.indexOf('class="p-fix"', contentDepthCardStart);
    const nextCard = html.indexOf('class="card"', contentDepthCardStart + 10);

    if (nextPfix !== -1 && (nextCard === -1 || nextPfix < nextCard)) {
      const fixContent = html.slice(nextPfix, nextPfix + 200);
      expect(fixContent).not.toContain("Content Depth.");
    }
    // OR: no p-fix at all — acceptable
  });
});

// ── Task 3c: break-inside: avoid on .card ────────────────────────────────────

describe("pdf-report-html — card page-break styles (Task 3c)", () => {
  it("includes break-inside: avoid in .card style", () => {
    const html = generatePdfReportHtml(basePdfData);
    // Look for break-inside rule in the stylesheet section (before <body>)
    const styleEnd = html.indexOf("</style>");
    const stylesheet = html.slice(0, styleEnd);
    expect(stylesheet).toContain("break-inside: avoid");
  });

  it("includes box-sizing: border-box globally", () => {
    const html = generatePdfReportHtml(basePdfData);
    expect(html).toContain("box-sizing: border-box");
  });
});

// ── Task 4: Thank-you cover panel ────────────────────────────────────────────

describe("pdf-report-html — cover panel (Task 4)", () => {
  it("does not render cover panel when coverPanel is absent", () => {
    const html = generatePdfReportHtml(basePdfData);
    expect(html).not.toContain("Thank you for your purchase");
  });

  it("renders thank-you text when coverPanel is set", () => {
    const html = generatePdfReportHtml({
      ...basePdfData,
      coverPanel: {
        reportUrl: "https://geo.flowblinq.com/sites/abc",
        installUrl: "https://geo.flowblinq.com/sites/abc/install",
      },
    });
    expect(html).toContain("Thank you for your purchase");
  });

  it("does not render email address in cover panel (Fix #36)", () => {
    const html = generatePdfReportHtml({
      ...basePdfData,
      coverPanel: {
        reportUrl: "https://geo.flowblinq.com/sites/abc",
        installUrl: "https://geo.flowblinq.com/sites/abc/install",
      },
    });
    // The cover panel section specifically must not contain a customer email.
    // Locate the cover panel div and inspect only that slice.
    const coverStart = html.indexOf("Thank you for your purchase");
    const coverEnd = html.indexOf("<!-- ══════", coverStart + 1);
    expect(coverStart).toBeGreaterThan(-1);
    const coverSlice = coverEnd > 0 ? html.slice(coverStart, coverEnd) : html.slice(coverStart, coverStart + 500);
    // Should not contain anything that looks like user@example.com
    expect(coverSlice).not.toMatch(/\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/);
  });

  it("renders FlowBlinq fixes table when coverPanel is set", () => {
    const html = generatePdfReportHtml({
      ...basePdfData,
      coverPanel: {
        reportUrl: "https://geo.flowblinq.com/sites/abc",
        installUrl: "https://geo.flowblinq.com/sites/abc/install",
      },
    });
    expect(html).toContain("What FlowBlinq fixes for you");
    expect(html).toContain("llms.txt");
    expect(html).toContain("business.json");
  });

  it("renders projected lift panel at bottom when projectedScore > overallScore", () => {
    const html = generatePdfReportHtml({
      ...basePdfData,
      projectedScore: 70,
      overallScore: 42,
    });
    expect(html).toContain("Estimated lift");
    expect(html).toContain("42");
    expect(html).toContain("70");
  });

  it("does not render projected lift panel when projectedScore is not set", () => {
    const html = generatePdfReportHtml({ ...basePdfData, projectedScore: undefined });
    // The bottom closing lift panel should not appear
    // (the cover score projection strip may appear — that's different)
    // Count occurrences of "Estimated lift"
    const count = (html.match(/Estimated lift/g) ?? []).length;
    expect(count).toBe(0);
  });

  it("does not render projected lift panel when projectedScore <= overallScore", () => {
    const html = generatePdfReportHtml({
      ...basePdfData,
      projectedScore: 42,
      overallScore: 42,
    });
    expect(html).not.toContain("Estimated lift");
  });
});

// ── BLOCKER #1: GOLD/SAGE template-literal substitution ──────────────────────

describe("pdf-report-html — color token substitution (BLOCKER #1)", () => {
  it("does not emit literal ${GOLD} in rendered HTML", () => {
    const html = generatePdfReportHtml({
      ...basePdfData,
      // Weak-tier pillar (score 45 → Weak tier)
      pillars: [
        {
          pillar: "structured_data",
          pillarName: "Structured Data",
          score: 45,
          findings: "Some schema missing.",
          recommendation: "Add JSON-LD",
          priority: "medium",
        },
      ],
      recommendations: [
        {
          rank: 1,
          title: "Add JSON-LD",
          pillar: "structured_data",
          estimatedBoost: "+10",
          priority: "high",
        },
      ],
    });
    // These should not appear as literal strings in the output
    expect(html).not.toContain("${GOLD}");
    expect(html).not.toContain("${SAGE}");
    expect(html).not.toContain("${BRICK}");
  });

  it("renders actual GOLD hex color (#C4841D) for Weak-tier pillar badge", () => {
    const html = generatePdfReportHtml({
      ...basePdfData,
      pillars: [
        {
          pillar: "content_quality",
          pillarName: "Content Quality",
          score: 45, // Weak tier (35–54)
          findings: "Content is thin.",
          recommendation: "Expand content.",
          priority: "medium",
        },
      ],
      recommendations: [
        {
          rank: 1,
          title: "Expand content.",
          pillar: "content_quality",
          estimatedBoost: "+8",
          priority: "medium",
        },
      ],
    });
    // The GOLD hex value #C4841D must appear (pillar tier badge color)
    expect(html).toContain("#C4841D");
  });

  it("renders actual SAGE hex color (#3B7A4A) for Strong-tier pillar badge", () => {
    const html = generatePdfReportHtml({
      ...basePdfData,
      pillars: [
        {
          pillar: "technical_seo",
          pillarName: "Technical SEO",
          score: 80, // Strong tier (≥55)
          findings: "Good technical foundation.",
          recommendation: "Minor improvements only.",
          priority: "low",
        },
      ],
      recommendations: [
        {
          rank: 1,
          title: "Minor improvements only.",
          pillar: "technical_seo",
          estimatedBoost: "+2",
          priority: "low",
        },
      ],
    });
    // The SAGE hex value #3B7A4A must appear (pillar tier badge color)
    expect(html).toContain("#3B7A4A");
  });
});
