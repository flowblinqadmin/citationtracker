/**
 * Unit tests for lib/services/geo-crawler.ts
 *
 * All external dependencies (Firecrawl, fetch) are mocked.
 * Tests verify behavior and outcomes, not implementation details.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────
// vi.hoisted() runs before any module imports — the returned object is available
// both inside vi.mock() factories AND in the test body.

const mockFirecrawlInstance = vi.hoisted(() => ({
  mapUrl: vi.fn(),
  asyncCrawlUrl: vi.fn(),
  checkCrawlStatus: vi.fn(),
  scrapeUrl: vi.fn(),
}));

vi.mock("@mendable/firecrawl-js", () => ({
  FirecrawlAppV1: vi.fn().mockImplementation(function () {
    return mockFirecrawlInstance;
  }),
}));

// lib/db throws at import time if DATABASE_URL is not set — mock it before importing geo-crawler
vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

// ─── Imports (after mocks are declared) ───────────────────────────────────────

import {
  discoverSite,
  scoreCrawlQuality,
  classifyPageType,
  type CrawledPage,
  type CrawlData,
} from "@/lib/services/geo-crawler";

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeGoodPage(url: string, pageType: CrawledPage["pageType"] = "other"): CrawledPage {
  return {
    url,
    pageType,
    title: "Test Page",
    h1: "Test Heading",
    headings: [{ level: 1, text: "Test Heading" }],
    content: "A".repeat(500), // 500 chars — well above the 300-char "good" threshold
    existingSchema: [],
    hasStructuredData: false,
    contactInfo: [],
    faqContent: [],
    testimonials: [],
    certifications: [],
  };
}

function makeThinPage(url: string): CrawledPage {
  return { ...makeGoodPage(url), content: "A".repeat(20) }; // <50 chars: thin
}

function makeErrorPage(url: string): CrawledPage {
  return {
    ...makeGoodPage(url),
    content: "Just a moment... Checking your browser before accessing",
    title: "Cloudflare DDoS Protection",
  };
}

// ─── discoverSite() ────────────────────────────────────────────────────────────

describe("discoverSite()", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    process.env.FIRECRAWL_API_KEY = "test-fc-key";

    // Stub global fetch: all HEAD/GET requests return 404 by default
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "",
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns URLs from Firecrawl mapUrl when it returns results", async () => {
    const fcUrls = [
      "https://example.com/",
      "https://example.com/about",
      "https://example.com/pricing",
    ];
    mockFirecrawlInstance.mapUrl.mockResolvedValue({ links: fcUrls });

    const result = await discoverSite("example.com");

    for (const url of fcUrls) {
      expect(result.urls).toContain(url);
    }
    expect(result.totalPages).toBeGreaterThanOrEqual(fcUrls.length);
  });

  it("always includes the homepage in results even when Firecrawl omits it", async () => {
    // Firecrawl returns sub-pages only — no root URL
    const fcUrls = [
      "https://example.com/about",
      "https://example.com/blog",
    ];
    mockFirecrawlInstance.mapUrl.mockResolvedValue({ links: fcUrls });

    const result = await discoverSite("example.com");

    const hasHomepage = result.urls.some(
      (u) => u === "https://example.com" || u === "https://example.com/"
    );
    expect(hasHomepage).toBe(true);
  });

  it("falls back to common path seeds when Firecrawl returns 0 URLs", async () => {
    mockFirecrawlInstance.mapUrl.mockResolvedValue({ links: [] });

    const result = await discoverSite("example.com");

    // Seeds include these paths
    const expectedPaths = ["/about", "/pricing", "/services", "/contact"];
    for (const path of expectedPaths) {
      expect(result.urls.some((u) => u.includes(path))).toBe(true);
    }
    expect(result.urls.length).toBeGreaterThan(0);
  });

  it("does not throw when Firecrawl throws — uses common seeds as fallback", async () => {
    mockFirecrawlInstance.mapUrl.mockRejectedValue(new Error("Firecrawl down"));

    const result = await discoverSite("example.com");

    expect(Array.isArray(result.urls)).toBe(true);
    expect(result.urls.length).toBeGreaterThan(0);
  });

  it("slices results to a maximum of 81 URLs (80 discovered + possible homepage prepend)", async () => {
    // Firecrawl returns 200 URLs (well over the 80 cap)
    const fcUrls = Array.from({ length: 200 }, (_, i) => `https://example.com/page-${i}`);
    mockFirecrawlInstance.mapUrl.mockResolvedValue({ links: fcUrls });

    const result = await discoverSite("example.com");

    // The cap is 80 discovered URLs; homepage may be prepended = max 81
    expect(result.urls.length).toBeLessThanOrEqual(81);
  });

  it("returns a pageMap entry for every URL in the urls array", async () => {
    const fcUrls = [
      "https://example.com/",
      "https://example.com/about",
      "https://example.com/pricing",
    ];
    mockFirecrawlInstance.mapUrl.mockResolvedValue({ links: fcUrls });

    const result = await discoverSite("example.com");

    for (const url of result.urls) {
      expect(result.pageMap[url]).toBeDefined();
    }
  });

  it("classifies pageMap entries correctly for known URL patterns", async () => {
    mockFirecrawlInstance.mapUrl.mockResolvedValue({
      links: [
        "https://example.com/",
        "https://example.com/about",
        "https://example.com/pricing",
      ],
    });

    const result = await discoverSite("example.com");

    expect(result.pageMap["https://example.com/"]).toBe("homepage");
    expect(result.pageMap["https://example.com/about"]).toBe("about");
    expect(result.pageMap["https://example.com/pricing"]).toBe("pricing");
  });

  it("sets hasLlmsTxt=true when GET request for /llms.txt returns 200", async () => {
    mockFirecrawlInstance.mapUrl.mockResolvedValue({ links: ["https://example.com/"] });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
        // Issue G (commit 991a6db): checkUrlExists now uses GET with
        // Range: bytes=0-0 and a bot-friendly User-Agent rotation,
        // replacing the prior HEAD + FlowBlinqGEO/1.0 implementation.
        // Mock must match the new request shape or the stub fall-through
        // returns 404 and hasLlmsTxt resolves to false.
        if (String(url).includes("/llms.txt") && opts?.method === "GET") {
          return Promise.resolve({ ok: true, status: 200, text: async () => "" });
        }
        return Promise.resolve({ ok: false, status: 404, text: async () => "" });
      })
    );

    const result = await discoverSite("example.com");

    expect(result.hasLlmsTxt).toBe(true);
  });

  it("sets hasLlmsTxt=false when GET request for /llms.txt returns 404", async () => {
    mockFirecrawlInstance.mapUrl.mockResolvedValue({ links: ["https://example.com/"] });

    const result = await discoverSite("example.com");

    expect(result.hasLlmsTxt).toBe(false);
  });
});

// ─── scoreCrawlQuality() ──────────────────────────────────────────────────────
// Note: firecrawlScrapePass() and fireFirecrawlJobs() suites removed (ES-023):
// those functions are deleted in the fan-out refactor.

describe("scoreCrawlQuality()", () => {
  it("marks usable=true when 3 or more good pages are present", () => {
    const crawlData: CrawlData = {
      domain: "example.com",
      totalCrawled: 3,
      pages: [
        makeGoodPage("https://example.com/", "homepage"),
        makeGoodPage("https://example.com/about", "about"),
        makeGoodPage("https://example.com/services", "services"),
      ],
    };
    expect(scoreCrawlQuality(crawlData).usable).toBe(true);
  });

  it("marks usable=true when at least 1 good page is present (threshold is >= 1)", () => {
    // The implementation requires goodPages >= 1 for usable=true
    const crawlData: CrawlData = {
      domain: "example.com",
      totalCrawled: 2,
      pages: [
        makeGoodPage("https://example.com/", "homepage"),
        makeGoodPage("https://example.com/about", "about"),
      ],
    };
    expect(scoreCrawlQuality(crawlData).usable).toBe(true);
  });

  it("marks usable=false when there are zero good pages", () => {
    const crawlData: CrawlData = {
      domain: "example.com",
      totalCrawled: 1,
      pages: [],
    };
    expect(scoreCrawlQuality(crawlData).usable).toBe(false);
  });

  it("counts thin pages (100-300 chars) separately from good pages", () => {
    const crawlData: CrawlData = {
      domain: "example.com",
      totalCrawled: 4,
      pages: [
        makeGoodPage("https://example.com/", "homepage"),
        makeGoodPage("https://example.com/about", "about"),
        makeGoodPage("https://example.com/services", "services"),
        makeThinPage("https://example.com/thin"),
      ],
    };
    const q = scoreCrawlQuality(crawlData);
    expect(q.goodPages).toBe(3);
    expect(q.thinPages).toBe(1);
  });

  it("detects blockedByAntiBot=true when content contains cloudflare bot-challenge signals", () => {
    const crawlData: CrawlData = {
      domain: "example.com",
      totalCrawled: 1,
      pages: [makeErrorPage("https://example.com/")],
    };
    const q = scoreCrawlQuality(crawlData);
    expect(q.blockedByAntiBot).toBe(true);
    expect(q.errorPages).toBe(1);
  });

  it("coverageScore is always 0 (coverage check removed — not meaningful for all site types)", () => {
    const crawlData: CrawlData = {
      domain: "example.com",
      totalCrawled: 4,
      pages: [
        makeGoodPage("https://example.com/", "homepage"),
        makeGoodPage("https://example.com/about", "about"),
        { ...makeGoodPage("https://example.com/pricing"), pageType: "pricing" },
        makeGoodPage("https://example.com/services", "services"),
      ],
    };
    expect(scoreCrawlQuality(crawlData).coverageScore).toBe(0);
  });

  it("marks usable=true when some good pages exist even if most crawled pages are errors", () => {
    const crawlData: CrawlData = {
      domain: "example.com",
      totalCrawled: 7,
      pages: [
        makeGoodPage("https://example.com/", "homepage"),
        makeGoodPage("https://example.com/about", "about"),
        makeGoodPage("https://example.com/services", "services"),
        makeErrorPage("https://example.com/e1"),
        makeErrorPage("https://example.com/e2"),
        makeErrorPage("https://example.com/e3"),
        makeErrorPage("https://example.com/e4"),
      ],
    };
    // usable = goodPages >= 1; error page ratio no longer gates usability
    expect(scoreCrawlQuality(crawlData).usable).toBe(true);
  });

  it("populates the issues array when problems exist", () => {
    const crawlData: CrawlData = {
      domain: "example.com",
      totalCrawled: 1,
      pages: [makeErrorPage("https://example.com/")],
    };
    const q = scoreCrawlQuality(crawlData);
    expect(q.issues.length).toBeGreaterThan(0);
  });

  it("totalAttempted matches crawlData.totalCrawled", () => {
    const crawlData: CrawlData = {
      domain: "example.com",
      totalCrawled: 5,
      pages: Array.from({ length: 5 }, (_, i) => makeGoodPage(`https://example.com/p${i}`)),
    };
    expect(scoreCrawlQuality(crawlData).totalAttempted).toBe(5);
  });
});

// ─── classifyPageType() ────────────────────────────────────────────────────────

describe("classifyPageType()", () => {
  it.each([
    ["https://example.com/", "homepage"],
    ["https://example.com", "homepage"],
    ["https://example.com/index", "homepage"],
    ["https://example.com/home", "homepage"],
  ])("classifies '%s' as homepage", (url, expected) => {
    expect(classifyPageType(url)).toBe(expected);
  });

  it.each([
    ["https://example.com/about", "about"],
    ["https://example.com/about-us", "about"],
    ["https://example.com/who-we-are", "about"],
    ["https://example.com/our-story", "about"],
  ])("classifies '%s' as about", (url, expected) => {
    expect(classifyPageType(url)).toBe(expected);
  });

  it.each([
    ["https://example.com/pricing", "pricing"],
    ["https://example.com/plans", "pricing"],
    ["https://example.com/packages", "pricing"],
  ])("classifies '%s' as pricing", (url, expected) => {
    expect(classifyPageType(url)).toBe(expected);
  });

  it.each([
    ["https://example.com/services", "services"],
    ["https://example.com/solutions", "services"],
  ])("classifies '%s' as services", (url, expected) => {
    expect(classifyPageType(url)).toBe(expected);
  });

  it.each([
    ["https://example.com/blog", "blog"],
    ["https://example.com/news", "blog"],
    ["https://example.com/articles", "blog"],
    ["https://example.com/insights", "blog"],
  ])("classifies '%s' as blog", (url, expected) => {
    expect(classifyPageType(url)).toBe(expected);
  });

  it.each([
    ["https://example.com/faq", "faq"],
    ["https://example.com/faqs", "faq"],
    ["https://example.com/questions", "faq"],
  ])("classifies '%s' as faq", (url, expected) => {
    expect(classifyPageType(url)).toBe(expected);
  });

  it.each([
    ["https://example.com/contact", "contact"],
    ["https://example.com/get-in-touch", "contact"],
  ])("classifies '%s' as contact", (url, expected) => {
    expect(classifyPageType(url)).toBe(expected);
  });

  it.each([
    ["https://example.com/privacy", "legal"],
    ["https://example.com/terms", "legal"],
    ["https://example.com/legal", "legal"],
    ["https://example.com/cookie-policy", "legal"],
  ])("classifies '%s' as legal", (url, expected) => {
    expect(classifyPageType(url)).toBe(expected);
  });

  it.each([
    ["https://example.com/some-random-page", "other"],
    ["https://example.com/product/widget-x", "other"],
    ["https://example.com/2024/announcement", "other"],
  ])("classifies '%s' as other when no pattern matches", (url, expected) => {
    expect(classifyPageType(url)).toBe(expected);
  });

  it.each([
    ["not-a-url", "other"],
    ["", "other"],
  ])("returns 'other' without throwing for invalid input '%s'", (url, expected) => {
    expect(() => classifyPageType(url)).not.toThrow();
    expect(classifyPageType(url)).toBe(expected);
  });
});
