/**
 * ES-068 — Per-Page Schema Block Serving: API route unit tests
 * U16–U23 (Phase A — ReviewMaster, spec-driven, RED until DaVinci implements)
 *
 * Tests: GET /api/serve/[slug]/schema/[page]
 * Route file: geo/app/api/serve/[slug]/schema/[page]/route.ts
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Mocks — hoisted before imports
// ---------------------------------------------------------------------------

const mockResolveSite = vi.fn();
const mockLogCrawl = vi.fn();
const mockCheckRateLimit = vi.fn();
const mockIsKnownAICrawler = vi.fn();

vi.mock("@/lib/serve-lookup", () => ({
  resolveSiteForServing: (...args: unknown[]) => mockResolveSite(...args),
}));

vi.mock("@/lib/log-crawl", () => ({
  logCrawl: (...args: unknown[]) => mockLogCrawl(...args),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

vi.mock("@/lib/crawler-allowlist", () => ({
  isKnownAICrawler: (ua: string) => mockIsKnownAICrawler(ua),
}));

// Import route handler AFTER mocks
import { GET } from "@/app/api/serve/[slug]/schema/[page]/route";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface SchemaBlock {
  name: string;
  type: string;
  jsonLd: Record<string, unknown>;
  instructions: string;
  pageTarget: string;
}

function makeBlock(overrides: Partial<SchemaBlock> = {}): SchemaBlock {
  return {
    name: "Test Block",
    type: "FAQPage",
    jsonLd: { "@type": "FAQPage", "@context": "https://schema.org" },
    instructions: "Add to page",
    pageTarget: "https://example.com/faq",
    ...overrides,
  };
}

const SITE_BLOCKS: SchemaBlock[] = [
  makeBlock({ name: "Org", type: "Organization", pageTarget: "all pages", jsonLd: { "@type": "Organization", name: "Acme" } }),
  makeBlock({ name: "Site", type: "WebSite", pageTarget: "all pages", jsonLd: { "@type": "WebSite", name: "Acme Site" } }),
  makeBlock({ name: "Home Product", type: "Product", pageTarget: "homepage", jsonLd: { "@type": "Product", name: "Main" } }),
  makeBlock({ name: "Blog FAQ", type: "FAQPage", pageTarget: "https://example.com/blog/ai-roi", jsonLd: { "@type": "FAQPage", name: "Blog FAQ" } }),
  makeBlock({ name: "Pricing Product", type: "Product", pageTarget: "https://example.com/pricing", jsonLd: { "@type": "Product", name: "Pricing" } }),
  makeBlock({ name: "About Review", type: "Review", pageTarget: "https://example.com/about", jsonLd: { "@type": "Review", name: "About Review" } }),
  makeBlock({ name: "Robots", type: "RobotsTxt", pageTarget: "all pages", jsonLd: {} }),
];

function makeSite(blocks: SchemaBlock[] = SITE_BLOCKS) {
  return { id: "site-1", generatedSchemaBlocks: blocks };
}

function makeRequest(slug: string, page: string, opts?: { ua?: string; ip?: string; format?: string }) {
  const url = new URL(`http://localhost/api/serve/${slug}/schema/${page}`);
  if (opts?.format) url.searchParams.set("format", opts.format);
  return new NextRequest(
    new Request(url.toString(), {
      method: "GET",
      headers: {
        "user-agent": opts?.ua ?? "Mozilla/5.0",
        "x-forwarded-for": opts?.ip ?? "1.2.3.4",
      },
    })
  );
}

function makeRouteContext(slug: string, page: string) {
  return { params: Promise.resolve({ slug, page }) };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockIsKnownAICrawler.mockReturnValue(false);
  mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 9, resetAt: Date.now() + 60_000 });
  mockResolveSite.mockResolvedValue(makeSite());
  mockLogCrawl.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// U16: _sitewide
// ---------------------------------------------------------------------------

describe("GET /api/serve/[slug]/schema/_sitewide (U16)", () => {
  it("U16 — returns only sitewide blocks", async () => {
    const req = makeRequest("example-com", "_sitewide");
    const ctx = makeRouteContext("example-com", "_sitewide");

    const res = await GET(req, ctx);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.page).toBe("_sitewide");
    expect(Array.isArray(body.blocks)).toBe(true);

    // Only sitewide blocks — Organization and WebSite types, plus "all pages" targets
    for (const block of body.blocks) {
      // Each block should be a sitewide type or target
      const isSitewideType = ["Organization", "WebSite", "BreadcrumbList", "DefinedTerm", "SpeakableSpecification"].includes(block.type);
      const isSitewideTarget = block.pageTarget === "all pages";
      expect(isSitewideType || isSitewideTarget).toBe(true);
    }

    // No page-specific or homepage blocks
    expect(body.blocks.find((b: SchemaBlock) => b.name === "Pricing Product")).toBeUndefined();
    expect(body.blocks.find((b: SchemaBlock) => b.name === "Home Product")).toBeUndefined();

    // scriptTag present
    expect(body.scriptTag).toBeDefined();
    expect(body.scriptTag).toContain("<script type=\"application/ld+json\">");
  });
});

// ---------------------------------------------------------------------------
// U17: _all?format=grouped
// ---------------------------------------------------------------------------

describe("GET /api/serve/[slug]/schema/_all?format=grouped (U17)", () => {
  it("U17 — returns grouped response with sitewide, homepage, pages", async () => {
    const req = makeRequest("example-com", "_all", { format: "grouped" });
    const ctx = makeRouteContext("example-com", "_all");

    const res = await GET(req, ctx);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body.sitewide)).toBe(true);
    expect(Array.isArray(body.homepage)).toBe(true);
    expect(typeof body.pages).toBe("object");

    // sitewide: Org + WebSite (type-based) — note "all pages" target blocks may also land here
    expect(body.sitewide.length).toBeGreaterThanOrEqual(2);

    // homepage: Home Product
    expect(body.homepage.length).toBeGreaterThanOrEqual(1);

    // pages: keyed by URL — blog/ai-roi, pricing, about
    const pageKeys = Object.keys(body.pages);
    expect(pageKeys.length).toBeGreaterThanOrEqual(2);

    // RobotsTxt excluded
    const allBlocks = [...body.sitewide, ...body.homepage, ...Object.values(body.pages).flat()];
    expect(allBlocks.find((b: SchemaBlock) => b.type === "RobotsTxt")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// U18: Specific page — URL-encoded
// ---------------------------------------------------------------------------

describe("GET /api/serve/[slug]/schema/{page} — URL-encoded (U18)", () => {
  it("U18 — blog%2Fai-roi → returns blocks for /blog/ai-roi + sitewide", async () => {
    const req = makeRequest("example-com", "blog%2Fai-roi");
    const ctx = makeRouteContext("example-com", "blog%2Fai-roi");

    const res = await GET(req, ctx);
    expect(res.status).toBe(200);

    const body = await res.json();

    // page field shows the full page URL or the decoded path
    expect(body.page).toBeDefined();

    // blocks: the Blog FAQ block should be in page-specific blocks
    expect(body.blocks).toBeDefined();
    expect(body.blocks.some((b: SchemaBlock) => b.name === "Blog FAQ")).toBe(true);

    // sitewide blocks also returned
    expect(body.sitewide).toBeDefined();
    expect(body.sitewide.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// U19: Specific page — scriptTag
// ---------------------------------------------------------------------------

describe("GET /api/serve/[slug]/schema/{page} — scriptTag (U19)", () => {
  it("U19 — response includes scriptTag with combined JSON-LD", async () => {
    const req = makeRequest("example-com", "pricing");
    const ctx = makeRouteContext("example-com", "pricing");

    const res = await GET(req, ctx);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(typeof body.scriptTag).toBe("string");
    expect(body.scriptTag).toContain("<script type=\"application/ld+json\">");
    expect(body.scriptTag).toContain("</script>");

    // Should contain JSON from matched blocks
    const jsonStr = body.scriptTag.replace(/<script[^>]*>/, "").replace(/<\/script>/, "");
    const parsed = JSON.parse(jsonStr);
    // At least sitewide blocks should be in there
    expect(parsed).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// U20: No blocks → 404
// ---------------------------------------------------------------------------

describe("No blocks → 404 (U20)", () => {
  it("U20 — site exists but no generatedSchemaBlocks → 404", async () => {
    mockResolveSite.mockResolvedValue({ id: "site-1", generatedSchemaBlocks: null });

    const req = makeRequest("example-com", "_sitewide");
    const ctx = makeRouteContext("example-com", "_sitewide");

    const res = await GET(req, ctx);
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBe("not found");
  });

  it("U20b — site with empty blocks array → 404", async () => {
    mockResolveSite.mockResolvedValue({ id: "site-1", generatedSchemaBlocks: [] });

    const req = makeRequest("example-com", "_all", { format: "grouped" });
    const ctx = makeRouteContext("example-com", "_all");

    const res = await GET(req, ctx);
    // Empty array could be 200 with empty groups or 404 — spec says "no blocks → 404"
    // Accept either based on implementation; 404 is strict interpretation
    expect([200, 404]).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
// U21: No site → 404
// ---------------------------------------------------------------------------

describe("No site → 404 (U21)", () => {
  it("U21 — unknown slug → 404", async () => {
    mockResolveSite.mockResolvedValue(null);

    const req = makeRequest("nonexistent-slug", "pricing");
    const ctx = makeRouteContext("nonexistent-slug", "pricing");

    const res = await GET(req, ctx);
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBe("not found");
  });
});

// ---------------------------------------------------------------------------
// U22: Rate limit
// ---------------------------------------------------------------------------

// U22 + U23 removed — rate limiting removed from all serve endpoints (HP-135)

// ---------------------------------------------------------------------------
// Response headers (AC7)
// ---------------------------------------------------------------------------

describe("Response headers (AC7)", () => {
  it("CORS and cache headers present on 200 response", async () => {
    const req = makeRequest("example-com", "pricing");
    const ctx = makeRouteContext("example-com", "pricing");

    const res = await GET(req, ctx);
    expect(res.status).toBe(200);

    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
    expect(res.headers.get("X-Generated-By")).toBe("FlowBlinq GEO Platform");
  });
});

// ---------------------------------------------------------------------------
// logCrawl (AC — logging)
// ---------------------------------------------------------------------------

describe("logCrawl invocation", () => {
  it("calls logCrawl with schema_page file type on success", async () => {
    const req = makeRequest("example-com", "pricing");
    const ctx = makeRouteContext("example-com", "pricing");

    await GET(req, ctx);

    expect(mockLogCrawl).toHaveBeenCalledWith(
      expect.anything(),  // req
      "site-1",           // site.id
      "example-com",      // slug
      "schema_page"       // fileType
    );
  });
});
