/**
 * Page-aware schema.js injection tests — /api/serve/[slug]/schema.js
 *
 * Customer-perspective tests verifying the right JSON-LD blocks get
 * injected on the right pages.
 *
 *   PA-1  Homepage gets sitewide + homepage FAQ, but NOT blog-specific blocks
 *   PA-2  Blog post gets sitewide + that post's Article + FAQPage, not other posts
 *   PA-3  Page with no specific schema gets only sitewide blocks
 *   PA-4  RobotsTxt blocks are never injected
 *   PA-5  "all pages" pageTarget blocks inject on every page
 *   PA-6  Trailing slash normalization — "/blog/foo/" matches "/blog/foo"
 *   PA-7  Invalid/missing pageTarget URLs treated as sitewide (no crash)
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Hoisted mock handles ─────────────────────────────────────────────────────

const { mockResolveSite, mockCheckRateLimit, mockIsKnownAICrawler } = vi.hoisted(() => ({
  mockResolveSite: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockIsKnownAICrawler: vi.fn(),
}));

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@/lib/serve-lookup", () => ({
  resolveSiteForServing: mockResolveSite,
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mockCheckRateLimit,
}));

vi.mock("@/lib/crawler-allowlist", () => ({
  isKnownAICrawler: mockIsKnownAICrawler,
}));

vi.mock("@/lib/log-crawl", () => ({
  logCrawl: vi.fn(),
}));

// ─── Import handler after mocks ───────────────────────────────────────────────

import { GET } from "@/app/api/serve/[slug]/schema.js/route";

// ─── Test data ────────────────────────────────────────────────────────────────

/** Sitewide Organization block — should appear on every page */
const ORG_BLOCK = {
  type: "Organization",
  pageTarget: "all pages",
  jsonLd: { "@type": "Organization", name: "Acme Corp", url: "https://acme.com" },
};

/** Sitewide BreadcrumbList — should appear on every page */
const BREADCRUMB_BLOCK = {
  type: "BreadcrumbList",
  pageTarget: "all pages",
  jsonLd: { "@type": "BreadcrumbList", itemListElement: [] },
};

/** Sitewide DefinedTerm — should appear on every page */
const DEFINED_TERM_BLOCK = {
  type: "DefinedTerm",
  jsonLd: { "@type": "DefinedTerm", name: "ACP", description: "Agent Commerce Protocol" },
};

/** Homepage-specific FAQPage */
const HOMEPAGE_FAQ_BLOCK = {
  type: "FAQPage",
  pageTarget: "https://acme.com/",
  jsonLd: { "@type": "FAQPage", mainEntity: [{ "@type": "Question", name: "What is Acme?" }] },
};

/** Blog post Article block */
const BLOG_ARTICLE_BLOCK = {
  type: "Article",
  pageTarget: "https://acme.com/blog/protocol-wars-over",
  jsonLd: { "@type": "Article", headline: "The Protocol Wars Are Over" },
};

/** Blog post FAQPage block */
const BLOG_FAQ_BLOCK = {
  type: "FAQPage",
  pageTarget: "https://acme.com/blog/protocol-wars-over",
  jsonLd: { "@type": "FAQPage", mainEntity: [{ "@type": "Question", name: "Who won?" }] },
};

/** A different blog post's Article — should NOT appear on the first post's page */
const OTHER_BLOG_ARTICLE = {
  type: "Article",
  pageTarget: "https://acme.com/blog/ai-commerce-guide",
  jsonLd: { "@type": "Article", headline: "AI Commerce Guide" },
};

/** RobotsTxt block — should NEVER be injected */
const ROBOTS_BLOCK = {
  type: "RobotsTxt",
  pageTarget: "all pages",
  jsonLd: { "User-agent": "*", Allow: "/" },
};

/** Block with "all pages" target but non-sitewide type — should inject everywhere */
const ALL_PAGES_CUSTOM_BLOCK = {
  type: "WebSite",
  pageTarget: "all pages",
  jsonLd: { "@type": "WebSite", name: "Acme Corp", url: "https://acme.com" },
};

/** Block with invalid pageTarget (not a URL) */
const INVALID_TARGET_BLOCK = {
  type: "FAQPage",
  pageTarget: "not a valid url",
  jsonLd: { "@type": "FAQPage", mainEntity: [{ "@type": "Question", name: "Fallback?" }] },
};

/** Block with no pageTarget at all */
const NO_TARGET_BLOCK = {
  type: "SpeakableSpecification",
  jsonLd: { "@type": "SpeakableSpecification", cssSelector: [".main-content"] },
};

/** Full set of blocks simulating a real customer site */
const ALL_BLOCKS = [
  ORG_BLOCK,
  BREADCRUMB_BLOCK,
  DEFINED_TERM_BLOCK,
  HOMEPAGE_FAQ_BLOCK,
  BLOG_ARTICLE_BLOCK,
  BLOG_FAQ_BLOCK,
  OTHER_BLOG_ARTICLE,
  ROBOTS_BLOCK,
  ALL_PAGES_CUSTOM_BLOCK,
  INVALID_TARGET_BLOCK,
  NO_TARGET_BLOCK,
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(
  slug: string,
  ua = "Mozilla/5.0",
  ip = "1.2.3.4"
): [NextRequest, { params: Promise<{ slug: string }> }] {
  const req = new NextRequest(
    `https://geo.flowblinq.com/api/serve/${slug}/schema.js`,
    {
      method: "GET",
      headers: {
        "user-agent": ua,
        "x-forwarded-for": ip,
      },
    }
  );
  return [req, { params: Promise.resolve({ slug }) }];
}

/**
 * Simulates what a browser does: given the generated JS and a pathname,
 * collects all JSON-LD strings that would be injected by _fbInject().
 *
 * The JS uses `window.location.pathname` — we simulate by extracting the
 * `_fbInject(...)` calls that would execute for a given pathname.
 */
function extractInjectedJsonLd(jsBody: string, pathname: string): Record<string, unknown>[] {
  // Normalize pathname the same way the generated JS does: strip trailing slash
  const normalizedPath = pathname.replace(/\/$/, "") || "/";

  // The generated JS has this structure:
  //   var p = window.location.pathname.replace(/\/$/, '') || '/';
  //   _fbInject("...json...");           <-- sitewide, always runs
  //   if (p === "/blog/foo") {           <-- page-specific, conditional
  //     _fbInject("...json...");
  //   }
  //
  // We parse sitewide injections (outside any if block) and page-conditional ones.

  const results: Record<string, unknown>[] = [];

  // Extract all _fbInject calls with their JSON argument
  // Sitewide calls are NOT inside an if block
  // Page-specific calls are inside: if (p === "/some/path") { ... }

  const lines = jsBody.split("\n");
  let insideIfBlock = false;
  let ifPathname: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect start of an if block: if (p === "/path") {
    const ifMatch = trimmed.match(/^(?:} else )?if \(p === (".*?")\) \{$/);
    if (ifMatch) {
      insideIfBlock = true;
      ifPathname = JSON.parse(ifMatch[1]);
      continue;
    }

    // Detect end of if block
    if (trimmed === "}" || trimmed.startsWith("} else")) {
      if (trimmed === "}") {
        insideIfBlock = false;
        ifPathname = null;
      }
      continue;
    }

    // Detect _fbInject call
    const injectMatch = trimmed.match(/^_fbInject\((.*)\);$/);
    if (injectMatch) {
      const shouldInject = !insideIfBlock || ifPathname === normalizedPath;
      if (shouldInject) {
        try {
          // The argument is a JSON-stringified JSON string, e.g. "{\"@type\":\"Organization\"}"
          const jsonStr = JSON.parse(injectMatch[1]);
          results.push(JSON.parse(jsonStr));
        } catch {
          // Skip unparseable — test will fail on assertion instead
        }
      }
    }
  }

  return results;
}

/** Helper to check if a specific jsonLd object is in the injected results */
function containsJsonLd(
  injected: Record<string, unknown>[],
  expected: Record<string, unknown>
): boolean {
  const expectedStr = JSON.stringify(expected);
  return injected.some((item) => JSON.stringify(item) === expectedStr);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/serve/[slug]/schema.js — page-aware injection", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockIsKnownAICrawler.mockReturnValue(false);
    mockCheckRateLimit.mockResolvedValue({
      allowed: true,
      remaining: 9,
      resetAt: Date.now() + 60_000,
    });

    // Default: return a site with all blocks
    mockResolveSite.mockResolvedValue({
      generatedSchemaBlocks: ALL_BLOCKS,
    });
  });

  // ── PA-1: Homepage ────────────────────────────────────────────────────────

  describe("PA-1: Homepage gets sitewide + homepage FAQ, not blog blocks", () => {
    it("injects Organization, BreadcrumbList, DefinedTerm on homepage", async () => {
      const [req, ctx] = makeRequest("acme-corp");
      const res = await GET(req, ctx);
      expect(res.status).toBe(200);

      const js = await res.text();
      const injected = extractInjectedJsonLd(js, "/");

      expect(containsJsonLd(injected, ORG_BLOCK.jsonLd)).toBe(true);
      expect(containsJsonLd(injected, BREADCRUMB_BLOCK.jsonLd)).toBe(true);
      expect(containsJsonLd(injected, DEFINED_TERM_BLOCK.jsonLd)).toBe(true);
    });

    it("injects homepage FAQPage on homepage", async () => {
      const [req, ctx] = makeRequest("acme-corp");
      const res = await GET(req, ctx);
      const js = await res.text();
      const injected = extractInjectedJsonLd(js, "/");

      expect(containsJsonLd(injected, HOMEPAGE_FAQ_BLOCK.jsonLd)).toBe(true);
    });

    it("does NOT inject blog Article or blog FAQPage on homepage", async () => {
      const [req, ctx] = makeRequest("acme-corp");
      const res = await GET(req, ctx);
      const js = await res.text();
      const injected = extractInjectedJsonLd(js, "/");

      expect(containsJsonLd(injected, BLOG_ARTICLE_BLOCK.jsonLd)).toBe(false);
      expect(containsJsonLd(injected, BLOG_FAQ_BLOCK.jsonLd)).toBe(false);
      expect(containsJsonLd(injected, OTHER_BLOG_ARTICLE.jsonLd)).toBe(false);
    });
  });

  // ── PA-2: Blog post page ──────────────────────────────────────────────────

  describe("PA-2: Blog post gets sitewide + its own Article/FAQ, not other posts", () => {
    it("injects sitewide blocks on blog post page", async () => {
      const [req, ctx] = makeRequest("acme-corp");
      const res = await GET(req, ctx);
      const js = await res.text();
      const injected = extractInjectedJsonLd(js, "/blog/protocol-wars-over");

      expect(containsJsonLd(injected, ORG_BLOCK.jsonLd)).toBe(true);
      expect(containsJsonLd(injected, BREADCRUMB_BLOCK.jsonLd)).toBe(true);
    });

    it("injects the correct Article and FAQPage for /blog/protocol-wars-over", async () => {
      const [req, ctx] = makeRequest("acme-corp");
      const res = await GET(req, ctx);
      const js = await res.text();
      const injected = extractInjectedJsonLd(js, "/blog/protocol-wars-over");

      expect(containsJsonLd(injected, BLOG_ARTICLE_BLOCK.jsonLd)).toBe(true);
      expect(containsJsonLd(injected, BLOG_FAQ_BLOCK.jsonLd)).toBe(true);
    });

    it("does NOT inject other blog posts' schemas", async () => {
      const [req, ctx] = makeRequest("acme-corp");
      const res = await GET(req, ctx);
      const js = await res.text();
      const injected = extractInjectedJsonLd(js, "/blog/protocol-wars-over");

      expect(containsJsonLd(injected, OTHER_BLOG_ARTICLE.jsonLd)).toBe(false);
    });

    it("does NOT inject homepage FAQ on blog post page", async () => {
      const [req, ctx] = makeRequest("acme-corp");
      const res = await GET(req, ctx);
      const js = await res.text();
      const injected = extractInjectedJsonLd(js, "/blog/protocol-wars-over");

      expect(containsJsonLd(injected, HOMEPAGE_FAQ_BLOCK.jsonLd)).toBe(false);
    });
  });

  // ── PA-3: Page with no specific schema ────────────────────────────────────

  describe("PA-3: Page with no specific schema gets only sitewide", () => {
    it("/pricing gets sitewide blocks only", async () => {
      const [req, ctx] = makeRequest("acme-corp");
      const res = await GET(req, ctx);
      const js = await res.text();
      const injected = extractInjectedJsonLd(js, "/pricing");

      // Sitewide blocks present
      expect(containsJsonLd(injected, ORG_BLOCK.jsonLd)).toBe(true);
      expect(containsJsonLd(injected, BREADCRUMB_BLOCK.jsonLd)).toBe(true);
      expect(containsJsonLd(injected, DEFINED_TERM_BLOCK.jsonLd)).toBe(true);

      // No page-specific blocks
      expect(containsJsonLd(injected, HOMEPAGE_FAQ_BLOCK.jsonLd)).toBe(false);
      expect(containsJsonLd(injected, BLOG_ARTICLE_BLOCK.jsonLd)).toBe(false);
      expect(containsJsonLd(injected, BLOG_FAQ_BLOCK.jsonLd)).toBe(false);
      expect(containsJsonLd(injected, OTHER_BLOG_ARTICLE.jsonLd)).toBe(false);
    });
  });

  // ── PA-4: RobotsTxt never injected ────────────────────────────────────────

  describe("PA-4: RobotsTxt blocks are never injected", () => {
    it("RobotsTxt block is excluded from homepage output", async () => {
      const [req, ctx] = makeRequest("acme-corp");
      const res = await GET(req, ctx);
      const js = await res.text();

      // RobotsTxt jsonLd should not appear anywhere in the generated JS
      const robotsJsonStr = JSON.stringify(ROBOTS_BLOCK.jsonLd);
      expect(js).not.toContain(robotsJsonStr);
    });

    it("RobotsTxt block is excluded from blog post output", async () => {
      const [req, ctx] = makeRequest("acme-corp");
      const res = await GET(req, ctx);
      const js = await res.text();

      const injected = extractInjectedJsonLd(js, "/blog/protocol-wars-over");
      expect(containsJsonLd(injected, ROBOTS_BLOCK.jsonLd)).toBe(false);
    });

    it("RobotsTxt block is excluded even from pages with no specific schema", async () => {
      const [req, ctx] = makeRequest("acme-corp");
      const res = await GET(req, ctx);
      const js = await res.text();

      const injected = extractInjectedJsonLd(js, "/pricing");
      expect(containsJsonLd(injected, ROBOTS_BLOCK.jsonLd)).toBe(false);
    });
  });

  // ── PA-5: "all pages" blocks inject everywhere ────────────────────────────

  describe("PA-5: 'all pages' pageTarget blocks inject on every page", () => {
    const testPaths = ["/", "/pricing", "/blog/protocol-wars-over", "/about", "/contact"];

    for (const pathname of testPaths) {
      it(`WebSite block with "all pages" target appears on ${pathname}`, async () => {
        const [req, ctx] = makeRequest("acme-corp");
        const res = await GET(req, ctx);
        const js = await res.text();
        const injected = extractInjectedJsonLd(js, pathname);

        expect(containsJsonLd(injected, ALL_PAGES_CUSTOM_BLOCK.jsonLd)).toBe(true);
      });
    }
  });

  // ── PA-6: Trailing slash normalization ────────────────────────────────────

  describe("PA-6: Trailing slash normalization", () => {
    it("/blog/protocol-wars-over/ (with trailing slash) matches the same blocks as without", async () => {
      const [req, ctx] = makeRequest("acme-corp");
      const res = await GET(req, ctx);
      const js = await res.text();

      const withSlash = extractInjectedJsonLd(js, "/blog/protocol-wars-over/");
      const withoutSlash = extractInjectedJsonLd(js, "/blog/protocol-wars-over");

      // Both should contain the blog-specific blocks
      expect(containsJsonLd(withSlash, BLOG_ARTICLE_BLOCK.jsonLd)).toBe(true);
      expect(containsJsonLd(withSlash, BLOG_FAQ_BLOCK.jsonLd)).toBe(true);

      // And match each other exactly
      expect(withSlash).toEqual(withoutSlash);
    });

    it("root path '/' still works after trailing-slash normalization", async () => {
      const [req, ctx] = makeRequest("acme-corp");
      const res = await GET(req, ctx);
      const js = await res.text();

      // The generated JS uses: var p = window.location.pathname.replace(/\/$/, '') || '/';
      // So "/" stays "/", not ""
      const injected = extractInjectedJsonLd(js, "/");
      expect(containsJsonLd(injected, HOMEPAGE_FAQ_BLOCK.jsonLd)).toBe(true);
    });
  });

  // ── PA-7: Invalid/missing pageTarget ──────────────────────────────────────

  describe("PA-7: Invalid/missing pageTarget treated as sitewide", () => {
    it("block with invalid URL pageTarget is treated as sitewide and injected on all pages", async () => {
      const [req, ctx] = makeRequest("acme-corp");
      const res = await GET(req, ctx);
      const js = await res.text();

      // Invalid URL block should be treated as sitewide — injected on /pricing
      const injected = extractInjectedJsonLd(js, "/pricing");
      expect(containsJsonLd(injected, INVALID_TARGET_BLOCK.jsonLd)).toBe(true);

      // And also on homepage
      const homeInjected = extractInjectedJsonLd(js, "/");
      expect(containsJsonLd(homeInjected, INVALID_TARGET_BLOCK.jsonLd)).toBe(true);
    });

    it("block with no pageTarget and sitewide type is treated as sitewide", async () => {
      const [req, ctx] = makeRequest("acme-corp");
      const res = await GET(req, ctx);
      const js = await res.text();

      // SpeakableSpecification is in SITEWIDE_TYPES, and has no pageTarget
      const injected = extractInjectedJsonLd(js, "/pricing");
      expect(containsJsonLd(injected, NO_TARGET_BLOCK.jsonLd)).toBe(true);
    });

    it("handler does not crash when blocks have invalid pageTarget", async () => {
      mockResolveSite.mockResolvedValue({
        generatedSchemaBlocks: [
          { type: "FAQPage", pageTarget: ":::not-a-url:::", jsonLd: { "@type": "FAQPage" } },
          { type: "Article", pageTarget: "", jsonLd: { "@type": "Article" } },
          { type: "Organization", jsonLd: { "@type": "Organization" } },
        ],
      });

      const [req, ctx] = makeRequest("acme-corp");
      const res = await GET(req, ctx);

      expect(res.status).toBe(200);
      const js = await res.text();
      expect(js).toContain("_fbInject");
    });
  });

  // ── Edge case: resolveSiteForServing returns null ──────────────────────────

  describe("Edge cases", () => {
    it("returns 404 when resolveSiteForServing returns null", async () => {
      mockResolveSite.mockResolvedValue(null);

      const [req, ctx] = makeRequest("nonexistent-slug");
      const res = await GET(req, ctx);

      expect(res.status).toBe(404);
    });

    it("returns 404 when site has no generatedSchemaBlocks", async () => {
      mockResolveSite.mockResolvedValue({ generatedSchemaBlocks: null });

      const [req, ctx] = makeRequest("acme-corp");
      const res = await GET(req, ctx);

      expect(res.status).toBe(404);
    });
  });
});
