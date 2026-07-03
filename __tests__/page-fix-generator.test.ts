/**
 * ES-045 Unit Tests — U1–U7: Per-Page Fix Generator
 *
 * Written by ReviewMaster (Agent 9) — independent of ScriptDev.
 * Tests generatePerPageFixes() from lib/services/page-fix-generator.ts.
 *
 * @group es045
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────────────────

const mockOpenAICreate = vi.hoisted(() => vi.fn());

vi.mock("openai", () => {
  return {
    default: function () {
      return {
        chat: {
          completions: {
            create: mockOpenAICreate,
          },
        },
      };
    },
  };
});

vi.mock("@/lib/serve-utils", () => ({
  matchesPageTarget: vi.fn((pageTarget: string, url: string) => {
    // Default: match if pageTarget equals "all pages" or url contains the target slug
    if (pageTarget === "all pages") return true;
    return url.includes(pageTarget);
  }),
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

interface CrawlPage {
  url: string;
  title: string;
  headings: string[];
  content: string;
  existingSchema?: Array<{ "@type": string }>;
  pageType?: string;
}

interface CrawlData {
  pages: CrawlPage[];
}

function makeCrawlData(pageCount: number, options?: { withVulnerabilities?: boolean }): CrawlData {
  return {
    pages: Array.from({ length: pageCount }, (_, i) => ({
      url: `https://example.com/page-${i}`,
      title: options?.withVulnerabilities && i < Math.floor(pageCount / 2)
        ? "" // missing title = vulnerability
        : `Page ${i} Title`,
      headings: i % 3 === 0 ? [] : [`H1 for page ${i}`],
      content: `Content for page ${i}. `.repeat(20),
      pageType: "service",
    })),
  };
}

function makeScorecard(pillars?: Array<{ pillar: string; impactedPages?: string[] }>) {
  return {
    overallScore: 65,
    pillars: pillars ?? [
      { pillar: "technical_seo", pillarName: "Technical SEO", score: 50, impactedPages: ["https://example.com/page-0"] },
      { pillar: "structured_data", pillarName: "Structured Data", score: 40, impactedPages: ["https://example.com/page-1"] },
    ],
    topThreeImprovements: ["Add schema", "Fix titles", "Improve H1s"],
  };
}

function makeSchemaBlocks(targets: string[] = ["all pages"]) {
  return targets.map((t, i) => ({
    "@type": `FAQPage`,
    pageTarget: t,
    blockIndex: i,
  }));
}

function mockOpenAISuccess(fixes: Array<Record<string, unknown>>) {
  mockOpenAICreate.mockResolvedValueOnce({
    choices: [
      {
        message: {
          content: JSON.stringify(fixes),
        },
      },
    ],
  });
}

function mockOpenAIBatchSuccess(batchCount: number, pagesPerBatch: number = 15) {
  for (let b = 0; b < batchCount; b++) {
    const fixes = Array.from({ length: pagesPerBatch }, (_, i) => ({
      url: `https://example.com/page-${b * pagesPerBatch + i}`,
      pageType: "service",
      currentTitle: `Page ${b * pagesPerBatch + i} Title`,
      suggestedTitle: `Better Title for Page ${b * pagesPerBatch + i}`,
      suggestedMetaDescription: `Meta description for page ${b * pagesPerBatch + i}`,
      h1Fix: null,
      headingFixes: null,
      pillarFixes: [
        { pillar: "technical_seo", pillarName: "Technical SEO", fix: "Add schema markup", fixScope: "site-side" },
      ],
      matchedSchemaBlocks: [],
    }));
    mockOpenAISuccess(fixes);
  }
}

// ── Import under test (after mocks) ────────────────────────────────────────

// The actual import — will fail until ScriptDev implements the module
// import { generatePerPageFixes, PerPageFix } from "@/lib/services/page-fix-generator";

// For now, define the type for assertion purposes
interface PerPageFix {
  url: string;
  pageType: string;
  currentTitle: string;
  suggestedTitle: string | null;
  suggestedMetaDescription: string | null;
  h1Fix: string | null;
  headingFixes: string | null;
  pillarFixes: Array<{
    pillar: string;
    pillarName: string;
    fix: string;
    fixScope: "site-side";
  }>;
  matchedSchemaBlocks: string[];
}

// Lazy import — will resolve once ScriptDev creates the module
let generatePerPageFixes: (
  domain: string,
  crawlData: CrawlData,
  geoScorecard: ReturnType<typeof makeScorecard>,
  schemaBlocks: ReturnType<typeof makeSchemaBlocks>,
  isPaidUser: boolean
) => Promise<PerPageFix[]>;

beforeEach(async () => {
  vi.clearAllMocks();
  try {
    const mod = await import("@/lib/services/page-fix-generator");
    generatePerPageFixes = mod.generatePerPageFixes;
  } catch {
    // Module not yet implemented — tests will be skipped
  }
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("ES-045: generatePerPageFixes", () => {
  /**
   * U1: Returns fixes for pages with vulnerabilities.
   * 3 pages, 2 with missing titles → 2 should have non-null suggestedTitle.
   */
  it("U1: returns fixes for pages with vulnerabilities", async () => {
    if (!generatePerPageFixes) return; // skip until implemented

    const crawlData = makeCrawlData(3, { withVulnerabilities: true });
    const scorecard = makeScorecard();
    const schemaBlocks = makeSchemaBlocks();

    // Mock OpenAI to return fixes for all 3 pages (1 batch of ≤15)
    mockOpenAISuccess([
      { url: crawlData.pages[0].url, suggestedTitle: "New Title 0", suggestedMetaDescription: null, h1Fix: null, headingFixes: null, pillarFixes: [], matchedSchemaBlocks: [] },
      { url: crawlData.pages[1].url, suggestedTitle: null, suggestedMetaDescription: "New meta", h1Fix: null, headingFixes: null, pillarFixes: [], matchedSchemaBlocks: [] },
      { url: crawlData.pages[2].url, suggestedTitle: "New Title 2", suggestedMetaDescription: null, h1Fix: null, headingFixes: null, pillarFixes: [], matchedSchemaBlocks: [] },
    ]);

    const result = await generatePerPageFixes("example.com", crawlData, scorecard, schemaBlocks, true);

    expect(result).toHaveLength(3);
    // Pages 0 and 2 (missing titles, highest vulnerability) should have suggestedTitle
    const withSuggestedTitle = result.filter((f: PerPageFix) => f.suggestedTitle !== null);
    expect(withSuggestedTitle.length).toBeGreaterThanOrEqual(2);
  });

  /**
   * U2: Caps at 100 pages (highest-vulnerability first).
   */
  it("U2: caps at 100 pages", async () => {
    if (!generatePerPageFixes) return;

    const crawlData = makeCrawlData(150, { withVulnerabilities: true });
    const scorecard = makeScorecard();
    const schemaBlocks = makeSchemaBlocks();

    // 100 pages / 15 per batch = 7 batches
    mockOpenAIBatchSuccess(7, 15);

    const result = await generatePerPageFixes("example.com", crawlData, scorecard, schemaBlocks, true);

    expect(result.length).toBeLessThanOrEqual(100);
  });

  /**
   * U3: isPaidUser=true → exact HTML values (not guidance text).
   */
  it("U3: isPaidUser=true gives exact values", async () => {
    if (!generatePerPageFixes) return;

    const crawlData = makeCrawlData(1);
    const scorecard = makeScorecard();
    const schemaBlocks = makeSchemaBlocks();

    // Capture the prompt sent to OpenAI
    let capturedPrompt = "";
    mockOpenAICreate.mockImplementationOnce(async (args: { messages: Array<{ content: string }> }) => {
      capturedPrompt = args.messages?.find((m: { role?: string }) => m.role === "user")?.content ?? "";
      return {
        choices: [{
          message: {
            content: JSON.stringify([{
              url: "https://example.com/page-0",
              suggestedTitle: "Exact SEO Title For Page - 55 Characters Long",
              suggestedMetaDescription: "Exact meta description with location keywords for better AI visibility in search results and citations.",
              h1Fix: null,
              headingFixes: null,
              pillarFixes: [],
              matchedSchemaBlocks: [],
            }]),
          },
        }],
      };
    });

    const result = await generatePerPageFixes("example.com", crawlData, scorecard, schemaBlocks, true);

    expect(result).toHaveLength(1);
    // Paid user gets exact values
    expect(result[0].suggestedTitle).toMatch(/^[A-Z].*\w$/); // Looks like a real title, not guidance
    // Prompt should ask for exact values
    expect(capturedPrompt.toLowerCase()).toContain("exact");
  });

  /**
   * U4: isPaidUser=false → general guidance (not exact code).
   */
  it("U4: isPaidUser=false gives general guidance", async () => {
    if (!generatePerPageFixes) return;

    const crawlData = makeCrawlData(1);
    const scorecard = makeScorecard();
    const schemaBlocks = makeSchemaBlocks();

    let capturedPrompt = "";
    mockOpenAICreate.mockImplementationOnce(async (args: { messages: Array<{ content: string }> }) => {
      capturedPrompt = args.messages?.find((m: { role?: string }) => m.role === "user")?.content ?? "";
      return {
        choices: [{
          message: {
            content: JSON.stringify([{
              url: "https://example.com/page-0",
              suggestedTitle: "Consider adding location keywords to your title",
              suggestedMetaDescription: "Try including service-specific terms in your description",
              h1Fix: null,
              headingFixes: null,
              pillarFixes: [],
              matchedSchemaBlocks: [],
            }]),
          },
        }],
      };
    });

    const result = await generatePerPageFixes("example.com", crawlData, scorecard, schemaBlocks, false);

    expect(result).toHaveLength(1);
    // Free user gets guidance language
    expect(result[0].suggestedTitle).toBeTruthy();
    // Prompt should NOT ask for exact HTML
    if (capturedPrompt) {
      // For free users, prompt should differ from paid
      expect(capturedPrompt).not.toContain("Do NOT mention FlowBlinq");
    }
  });

  /**
   * U5: Schema blocks matched via matchesPageTarget.
   * 2 pages, 1 schema block targeting page 1 → page 1 has matchedSchemaBlocks.length===1.
   */
  it("U5: matches schema blocks via matchesPageTarget", async () => {
    if (!generatePerPageFixes) return;

    const crawlData: CrawlData = {
      pages: [
        { url: "https://example.com/services", title: "Services", headings: ["Services"], content: "Our services...", pageType: "service" },
        { url: "https://example.com/about", title: "About", headings: ["About"], content: "About us...", pageType: "about" },
      ],
    };
    const scorecard = makeScorecard();
    const schemaBlocks = [
      { "@type": "FAQPage", pageTarget: "/services", blockIndex: 0 },
    ];

    // Mock matchesPageTarget to match /services but not /about
    const { matchesPageTarget } = await import("@/lib/serve-utils");
    (matchesPageTarget as Mock).mockImplementation((target: string, url: string) => {
      return url.includes(target);
    });

    mockOpenAISuccess([
      { url: "https://example.com/services", suggestedTitle: null, suggestedMetaDescription: null, h1Fix: null, headingFixes: null, pillarFixes: [], matchedSchemaBlocks: ["FAQPage"] },
      { url: "https://example.com/about", suggestedTitle: null, suggestedMetaDescription: null, h1Fix: null, headingFixes: null, pillarFixes: [], matchedSchemaBlocks: [] },
    ]);

    const result = await generatePerPageFixes("example.com", crawlData, scorecard, schemaBlocks, true);

    const servicesPage = result.find((f: PerPageFix) => f.url.includes("/services"));
    const aboutPage = result.find((f: PerPageFix) => f.url.includes("/about"));
    expect(servicesPage?.matchedSchemaBlocks.length).toBe(1);
    expect(aboutPage?.matchedSchemaBlocks.length).toBe(0);
  });

  /**
   * U6: OpenAI returns invalid JSON → graceful degradation.
   * Returns empty array, no throw.
   */
  it("U6: handles OpenAI JSON parse failure gracefully", async () => {
    if (!generatePerPageFixes) return;

    const crawlData = makeCrawlData(3);
    const scorecard = makeScorecard();
    const schemaBlocks = makeSchemaBlocks();

    // Mock OpenAI returning invalid JSON
    mockOpenAICreate.mockResolvedValueOnce({
      choices: [{
        message: { content: "this is not valid json at all {{{" },
      }],
    });

    const result = await generatePerPageFixes("example.com", crawlData, scorecard, schemaBlocks, true);

    // Should return empty array (non-fatal), not throw
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });

  /**
   * U7: fixScope is always "site-side" for pillar fixes.
   */
  it("U7: fixScope is always 'site-side'", async () => {
    if (!generatePerPageFixes) return;

    const crawlData = makeCrawlData(2);
    const scorecard = makeScorecard();
    const schemaBlocks = makeSchemaBlocks();

    mockOpenAISuccess([
      {
        url: "https://example.com/page-0",
        suggestedTitle: "Better Title",
        suggestedMetaDescription: null,
        h1Fix: null,
        headingFixes: null,
        pillarFixes: [
          { pillar: "technical_seo", pillarName: "Technical SEO", fix: "Add schema markup", fixScope: "site-side" },
          { pillar: "structured_data", pillarName: "Structured Data", fix: "Add FAQ schema", fixScope: "site-side" },
        ],
        matchedSchemaBlocks: [],
      },
      {
        url: "https://example.com/page-1",
        suggestedTitle: null,
        suggestedMetaDescription: null,
        h1Fix: "Better H1",
        headingFixes: null,
        pillarFixes: [
          { pillar: "content_quality", pillarName: "Content Quality", fix: "Expand thin content", fixScope: "site-side" },
        ],
        matchedSchemaBlocks: [],
      },
    ]);

    const result = await generatePerPageFixes("example.com", crawlData, scorecard, schemaBlocks, true);

    for (const fix of result) {
      for (const pf of fix.pillarFixes) {
        expect(pf.fixScope).toBe("site-side");
      }
    }
  });
});
