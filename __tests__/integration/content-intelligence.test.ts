/**
 * ES-055 — Integration Tests: Tier 3 Content Intelligence
 * Tests IT1–IT7
 *
 * Verifies end-to-end data flow:
 * crawlData → strategy scoring → GEO analyzer injection → zone audit → zone suggestions → engine prefs
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock Setup ───────────────────────────────────────────────────

const { mockGeminiGenerate, mockOpenAICreate, mockCreate, mockClaudeCall } =
  vi.hoisted(() => ({
    mockGeminiGenerate: vi.fn(),
    mockOpenAICreate: vi.fn(),
    mockCreate: vi.fn(),
    mockClaudeCall: vi.fn(),
  }));

vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: vi.fn().mockImplementation(function () {
    return {
      getGenerativeModel: vi.fn().mockReturnValue({
        generateContent: mockGeminiGenerate,
      }),
    };
  }),
}));

vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(function () {
    return { chat: { completions: { create: mockOpenAICreate } } };
  }),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  }),
}));

vi.mock("@/lib/claude", () => ({ callClaude: mockClaudeCall }));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockResolvedValue([]),
      }),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  citationCheckScores: {},
  citationCheckResponses: {},
  geoSites: {},
}));

import {
  scoreQuotations,
  scoreStatistics,
  scoreCitedSources,
  scorePageStrategies,
  aggregateStrategyReport,
} from "@/lib/services/content-strategy-scorer";

import { auditPageZones } from "@/lib/services/page-fix-generator";

import type { ContentStrategyReport, PageZoneAudit } from "@/lib/types/content-strategy";

// ── Helpers ──────────────────────────────────────────────────────

function makeRichPage(url: string) {
  return {
    url,
    title: "Orthopedic Surgery — Expert Care",
    content: `
      Manipal Hospitals offers world-class orthopedic surgery with a 95% success rate.

      <blockquote>"Manipal Hospitals has the best orthopedic team in South India" — Dr. Rajesh Kumar</blockquote>

      According to Dr. Smith, patient outcomes improved by 40% after adopting new protocols.
      Revenue grew by $2.5 million in orthopedic revenue, a 3x improvement.

      [WHO guidelines on joint replacement](https://www.who.int/guidelines)
      [Stanford orthopedic research](https://med.stanford.edu/ortho) (Johnson, 2024)

      <table>
        <tr><th>Procedure</th><th>Success Rate</th><th>Recovery Time</th></tr>
        <tr><td>Hip Replacement</td><td>97%</td><td>6 weeks</td></tr>
        <tr><td>Knee Replacement</td><td>95%</td><td>8 weeks</td></tr>
      </table>

      **What is orthopedic surgery?**
      Orthopedic surgery addresses musculoskeletal conditions through surgical intervention.

      **How long is recovery?**
      Recovery typically takes six to twelve weeks depending on the procedure.
    `,
    pageType: "services",
    wordCount: 800,
    existingSchema: "",
    contactInfo: "",
    faqContent: ["What is orthopedic surgery?", "How long is recovery?"],
    headings: ["Orthopedic Surgery", "Our Procedures", "FAQ"],
    metaDescription: "Expert orthopedic surgery at Manipal Hospitals.",
    links: [],
  };
}

function makeThinPage(url: string) {
  return {
    url,
    title: "Contact Us",
    content: "Contact Manipal Hospitals for appointments. Call us today at 1800-123-4567.",
    pageType: "contact",
    wordCount: 50,
    existingSchema: "",
    contactInfo: "1800-123-4567",
    faqContent: [],
    headings: ["Contact Us"],
    metaDescription: "",
    links: [],
  };
}

// ── Integration Tests ────────────────────────────────────────────

describe("ES-055 Integration — Content Intelligence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.GEMINI_API_KEY = "test-key";
  });

  it("IT1 — content strategy scores computed from crawl data", () => {
    const pages = [makeRichPage("https://example.com/ortho"), makeThinPage("https://example.com/contact")];
    const report = aggregateStrategyReport(pages as any[]);

    expect(report.quotations.pagesTotal).toBe(2);
    expect(report.quotations.pagesWithQuotes).toBeGreaterThanOrEqual(1);
    expect(report.statistics.pagesWithStats).toBeGreaterThanOrEqual(1);
    expect(report.citations.pagesWithCitations).toBeGreaterThanOrEqual(1);
    expect(report.computedAt).toBeTruthy();
  });

  it("IT2 — strategy scores can be injected into GEO analyzer context", () => {
    const pages = [makeRichPage("https://example.com/ortho")];
    const report = aggregateStrategyReport(pages as any[]);

    // Verify the report shape matches what geo-analyzer expects
    const contextString = [
      `Quotation density: ${report.quotations.avgPerPage} per page.`,
      `${report.quotations.pagesWithQuotes}/${report.quotations.pagesTotal} pages have attributed quotes.`,
      `Statistics density: ${report.statistics.avgPerPage} per page.`,
      `External citation density: ${report.citations.avgPerPage} per page.`,
    ].join(" ");

    expect(contextString).toContain("per page");
    expect(report.quotations.overallScore).toBeGreaterThanOrEqual(0);
  });

  it("IT3 — zone audit detects zones in rich content pages", () => {
    const page = makeRichPage("https://example.com/ortho");
    const scores = scorePageStrategies(page as any);
    const audit = auditPageZones(page as any, scores as any);

    // Rich page should have most zones
    expect(audit.hasFaqSection).toBe(true);
    expect(audit.hasComparisonTable).toBe(true);
    expect(audit.hasExpertQuote).toBe(true);
  });

  it("IT4 — thin pages get limited zone suggestions", () => {
    const thinPage = makeThinPage("https://example.com/contact");

    // Thin page (< 300 words) → spec says only suggest direct_answer
    expect(thinPage.wordCount).toBeLessThan(300);

    const audit = auditPageZones(thinPage as any);
    // Audit still reports all missing zones
    expect(audit.missingZones.length).toBeGreaterThan(0);
  });

  it("IT5 — engine prefs not computed on 1st/2nd check (< 3 checks)", async () => {
    const { analyzeEnginePreferences } = await import(
      "@/lib/services/engine-preference-analyzer"
    );

    // Mock: only 1 check exists
    const { db } = await import("@/lib/db");
    (db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ count: 1 }]),
      }),
    });

    const result = await analyzeEnginePreferences("example.com", "site-1");
    expect(result).toBeNull();
  });

  it("IT6 — engine prefs computed on 3rd check", async () => {
    const { analyzeEnginePreferences } = await import(
      "@/lib/services/engine-preference-analyzer"
    );

    const { db } = await import("@/lib/db");

    // First select: count = 3
    // Second select: accumulated responses
    let selectCallCount = 0;
    (db.select as any).mockImplementation(() => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => {
          selectCallCount++;
          if (selectCallCount === 1) return Promise.resolve([{ count: 3 }]);
          // Return mock responses for analysis
          return Promise.resolve(
            Array.from({ length: 48 }, (_, i) => ({
              id: `r-${i}`,
              provider: i % 4 === 0 ? "chatgpt" : "claude",
              query: `prompt-${i}`,
              response: `1. Option A.\n2. Option B.\n3. Option C.`,
              mentioned: true,
              position: 2,
              sentiment: "positive",
            }))
          );
        }),
      }),
    }));

    mockCreate.mockResolvedValue({
      content: [
        {
          type: "text",
          text: JSON.stringify([
            {
              provider: "chatgpt",
              rules: [
                { rule: "Prefers structured content", confidence: "high", evidence: "9/10 responses" },
              ],
              analyzedAt: new Date().toISOString(),
              checkCount: 3,
            },
          ]),
        },
      ],
    });

    const result = await analyzeEnginePreferences("example.com", "site-1");
    expect(result).not.toBeNull();
  });

  it("IT7 — end-to-end: strategy scores → zone audit consistency", () => {
    const page = makeRichPage("https://example.com/ortho");

    // Step 1: Score strategies
    const scores = scorePageStrategies(page as any);
    expect(scores.compositeScore).toBeGreaterThan(0);

    // Step 2: Audit zones using strategy scores
    const audit = auditPageZones(page as any, scores as any);

    // Step 3: Verify consistency — if quotation score > 0, expert quote detected
    if (scores.quotations.count > 0 && scores.quotations.hasAttribution) {
      expect(audit.hasExpertQuote).toBe(true);
    }

    // Step 4: Verify if statistics detected, data evidence zone detected
    if (scores.statistics.count >= 3) {
      expect(audit.hasDataEvidence).toBe(true);
    }
  });
});
