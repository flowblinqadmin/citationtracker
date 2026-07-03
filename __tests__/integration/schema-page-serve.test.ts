/**
 * ES-068 — Per-Page Schema Block Serving: Integration tests
 * IT1–IT10 (Phase A — ReviewMaster, spec-driven, RED until DaVinci implements)
 *
 * These tests exercise the full API route with mocked DB/dependencies,
 * verifying grouping, filtering, backward compat, headers, and performance.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Mocks — hoisted before all imports
// ---------------------------------------------------------------------------

const mockResolveSite = vi.fn();
const mockLogCrawl = vi.fn().mockResolvedValue(undefined);
const mockCheckRateLimit = vi.fn().mockResolvedValue({ allowed: true, remaining: 9, resetAt: Date.now() + 60_000 });
const mockIsKnownAICrawler = vi.fn().mockReturnValue(false);

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

function makeBlock(name: string, type: string, pageTarget: string, jsonLd?: Record<string, unknown>): SchemaBlock {
  return {
    name,
    type,
    jsonLd: jsonLd ?? { "@type": type, name },
    instructions: `Implement ${name}`,
    pageTarget,
  };
}

// Comprehensive block set covering all pageTarget formats
const FULL_BLOCK_SET: SchemaBlock[] = [
  // Sitewide — by type
  makeBlock("Org", "Organization", "all pages", { "@type": "Organization", name: "Acme Corp" }),
  makeBlock("WebSite", "WebSite", "all pages", { "@type": "WebSite", name: "Acme" }),
  makeBlock("Breadcrumb", "BreadcrumbList", "/some/path", { "@type": "BreadcrumbList" }),
  // Sitewide — by target "all pages"
  makeBlock("Global FAQ", "FAQPage", "all pages", { "@type": "FAQPage", mainEntity: [] }),
  // Homepage
  makeBlock("Home Product", "Product", "homepage", { "@type": "Product", name: "Featured" }),
  // Page-specific — full URL format
  makeBlock("Pricing Product", "Product", "https://example.com/pricing", { "@type": "Product", name: "Pro Plan" }),
  makeBlock("About Review", "Review", "https://example.com/about", { "@type": "Review", name: "About Us" }),
  makeBlock("Blog FAQ", "FAQPage", "https://example.com/blog/ai-roi", { "@type": "FAQPage", mainEntity: [{ name: "Q1" }] }),
  // RobotsTxt — should be skipped everywhere
  makeBlock("Robots", "RobotsTxt", "all pages", {}),
];

function makeSite(blocks: SchemaBlock[] = FULL_BLOCK_SET) {
  return { id: "site-int-1", generatedSchemaBlocks: blocks };
}

function makeRequest(slug: string, page: string, opts?: { format?: string; ua?: string }) {
  const url = new URL(`http://localhost/api/serve/${slug}/schema/${page}`);
  if (opts?.format) url.searchParams.set("format", opts.format);
  return new NextRequest(new Request(url.toString(), {
    method: "GET",
    headers: {
      "user-agent": opts?.ua ?? "Mozilla/5.0",
      "x-forwarded-for": "10.0.0.1",
    },
  }));
}

function makeCtx(slug: string, page: string) {
  return { params: Promise.resolve({ slug, page }) };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let GET: (req: NextRequest, ctx: { params: Promise<{ slug: string; page: string }> }) => Promise<Response>;

beforeAll(async () => {
  const mod = await import("@/app/api/serve/[slug]/schema/[page]/route");
  GET = mod.GET;
});

beforeEach(() => {
  vi.clearAllMocks();
  mockIsKnownAICrawler.mockReturnValue(false);
  mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 9, resetAt: Date.now() + 60_000 });
  mockResolveSite.mockResolvedValue(makeSite());
  mockLogCrawl.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// IT1: End-to-end grouped
// ---------------------------------------------------------------------------

describe("IT1 — _all?format=grouped returns correct grouping", () => {
  it("groups sitewide, homepage, and per-page blocks correctly", async () => {
    const res = await GET(
      makeRequest("example-com", "_all", { format: "grouped" }),
      makeCtx("example-com", "_all")
    );
    expect(res.status).toBe(200);

    const body = await res.json();

    // Sitewide: Org, WebSite, Breadcrumb (type-based), Global FAQ (target "all pages")
    expect(body.sitewide.length).toBeGreaterThanOrEqual(3);
    const sitewideTypes = body.sitewide.map((b: SchemaBlock) => b.type);
    expect(sitewideTypes).toContain("Organization");
    expect(sitewideTypes).toContain("WebSite");

    // Homepage: Home Product
    expect(body.homepage.length).toBeGreaterThanOrEqual(1);
    expect(body.homepage.some((b: SchemaBlock) => b.name === "Home Product")).toBe(true);

    // Pages: pricing, about, blog/ai-roi
    const pageKeys = Object.keys(body.pages);
    expect(pageKeys.length).toBeGreaterThanOrEqual(2);

    // RobotsTxt absent from all groups
    const all = [...body.sitewide, ...body.homepage, ...Object.values(body.pages).flat()] as SchemaBlock[];
    expect(all.find(b => b.type === "RobotsTxt")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// IT2: Page filter returns page + sitewide
// ---------------------------------------------------------------------------

describe("IT2 — page filter returns page + sitewide", () => {
  it("/pricing → Pricing Product block + sitewide blocks; no About/Blog blocks", async () => {
    const res = await GET(
      makeRequest("example-com", "pricing"),
      makeCtx("example-com", "pricing")
    );
    expect(res.status).toBe(200);

    const body = await res.json();

    // Page-specific blocks for /pricing
    expect(body.blocks.some((b: SchemaBlock) => b.name === "Pricing Product")).toBe(true);
    // Sitewide blocks included
    expect(body.sitewide.length).toBeGreaterThanOrEqual(1);

    // Non-matching page blocks absent
    const allNames = [...body.blocks, ...body.sitewide].map((b: SchemaBlock) => b.name);
    expect(allNames).not.toContain("About Review");
    expect(allNames).not.toContain("Blog FAQ");
  });
});

// ---------------------------------------------------------------------------
// IT3: _sitewide returns only sitewide
// ---------------------------------------------------------------------------

describe("IT3 — _sitewide returns only sitewide", () => {
  it("no page-specific or homepage blocks in response", async () => {
    const res = await GET(
      makeRequest("example-com", "_sitewide"),
      makeCtx("example-com", "_sitewide")
    );
    expect(res.status).toBe(200);

    const body = await res.json();

    // Only sitewide blocks
    for (const block of body.blocks) {
      const isSitewideType = ["Organization", "WebSite", "BreadcrumbList", "DefinedTerm", "SpeakableSpecification"].includes(block.type);
      const isSitewideTarget = block.pageTarget?.toLowerCase?.() === "all pages";
      expect(isSitewideType || isSitewideTarget).toBe(true);
    }

    // No homepage or page-specific
    expect(body.blocks.find((b: SchemaBlock) => b.name === "Home Product")).toBeUndefined();
    expect(body.blocks.find((b: SchemaBlock) => b.name === "Pricing Product")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// IT4: Backward compat — schema.json flat array
// ---------------------------------------------------------------------------

describe("IT4 — schema.json backward compatibility", () => {
  it("existing schema.json endpoint still returns flat array", async () => {
    // Import the existing schema.json route handler
    const { GET: getSchemaJson } = await import("@/app/api/serve/[slug]/schema.json/route");

    const req = new NextRequest(new Request("http://localhost/api/serve/example-com/schema.json", {
      method: "GET",
      headers: { "user-agent": "Mozilla/5.0", "x-forwarded-for": "10.0.0.1" },
    }));
    const ctx = { params: Promise.resolve({ slug: "example-com" }) };

    const res = await getSchemaJson(req, ctx);
    expect(res.status).toBe(200);

    const body = await res.json();
    // schema.json returns flat array of jsonLd objects
    expect(Array.isArray(body)).toBe(true);
    // Each element should be a jsonLd object (not wrapped in SchemaBlock)
    // Filter out RobotsTxt blocks which have empty jsonLd (no @type)
    const typedItems = body.filter((item: Record<string, unknown>) => Object.keys(item).length > 0);
    expect(typedItems.length).toBeGreaterThan(0);
    for (const item of typedItems) {
      expect(item).toHaveProperty("@type");
    }
  });
});

// ---------------------------------------------------------------------------
// IT5: Backward compat — schema.js page-aware JS
// ---------------------------------------------------------------------------

describe("IT5 — schema.js backward compatibility", () => {
  it("buildSchemaInjectionJs still produces page-aware JS", async () => {
    const { buildSchemaInjectionJs } = await import("@/lib/schema-js-builder");

    const blocks = FULL_BLOCK_SET.filter(b => b.type !== "RobotsTxt").map(b => ({
      type: b.type,
      pageTarget: b.pageTarget,
      jsonLd: b.jsonLd,
    }));

    const js = buildSchemaInjectionJs(blocks);
    expect(js).toContain("FlowBlinq GEO Schema");
    expect(js).toContain("window.location.pathname");
    expect(js).toContain("application/ld+json");
    // Page-specific blocks should have path guards
    expect(js).toContain("if (p ===");
  });
});

// ---------------------------------------------------------------------------
// IT6: Homepage filter matches "homepage" pageTarget
// ---------------------------------------------------------------------------

describe("IT6 — homepage filter", () => {
  it("GET /schema/ at root includes homepage-targeted blocks", async () => {
    // Request for root path (empty or "/" as page param)
    // When page="" is decoded, requestPath = "/"
    const res = await GET(
      makeRequest("example-com", ""),
      makeCtx("example-com", "")
    );

    // If empty page param is handled as root request
    if (res.status === 200) {
      const body = await res.json();
      // Homepage block should appear in page blocks (matchesPageTarget("homepage", "/") = true)
      const allBlocks = [...(body.blocks ?? []), ...(body.sitewide ?? [])];
      const hasHomepage = allBlocks.some((b: SchemaBlock) => b.name === "Home Product");
      expect(hasHomepage).toBe(true);
    }
    // If empty page is treated as 404, that's also acceptable behavior
    expect([200, 404]).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
// IT7: pageTarget as full URL matches correctly
// ---------------------------------------------------------------------------

describe("IT7 — full URL pageTarget matching", () => {
  it("block with pageTarget 'https://example.com/about' matched by GET /schema/about", async () => {
    const res = await GET(
      makeRequest("example-com", "about"),
      makeCtx("example-com", "about")
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.blocks.some((b: SchemaBlock) => b.name === "About Review")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// IT8: Mixed pageTarget formats all grouped correctly
// ---------------------------------------------------------------------------

describe("IT8 — mixed pageTarget formats", () => {
  it("full URLs, 'all pages', 'homepage' all grouped correctly in _all?format=grouped", async () => {
    const res = await GET(
      makeRequest("example-com", "_all", { format: "grouped" }),
      makeCtx("example-com", "_all")
    );
    expect(res.status).toBe(200);

    const body = await res.json();

    // "all pages" target → sitewide
    expect(body.sitewide.some((b: SchemaBlock) => b.name === "Global FAQ")).toBe(true);

    // "homepage" target → homepage group
    expect(body.homepage.some((b: SchemaBlock) => b.name === "Home Product")).toBe(true);

    // Full URL targets → pages group
    const allPageBlocks = Object.values(body.pages).flat() as SchemaBlock[];
    expect(allPageBlocks.some(b => b.name === "Pricing Product")).toBe(true);
    expect(allPageBlocks.some(b => b.name === "About Review")).toBe(true);
    expect(allPageBlocks.some(b => b.name === "Blog FAQ")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// IT9: Large site — 200+ blocks performance
// ---------------------------------------------------------------------------

describe("IT9 — large site performance (200+ blocks)", () => {
  it("grouped response with 200 blocks returns within 500ms", async () => {
    // Generate 200+ blocks across 40 pages
    const largeBlockSet: SchemaBlock[] = [];
    // 5 sitewide
    for (let i = 0; i < 5; i++) {
      largeBlockSet.push(makeBlock(`Org-${i}`, "Organization", "all pages", { "@type": "Organization", name: `Org ${i}` }));
    }
    // 3 homepage
    for (let i = 0; i < 3; i++) {
      largeBlockSet.push(makeBlock(`Home-${i}`, "Product", "homepage", { "@type": "Product", name: `Home ${i}` }));
    }
    // 192 page-specific across 40 pages
    for (let p = 0; p < 40; p++) {
      for (let b = 0; b < 5; b++) {
        largeBlockSet.push(makeBlock(
          `Page${p}-Block${b}`,
          "FAQPage",
          `https://example.com/page-${p}`,
          { "@type": "FAQPage", name: `FAQ ${p}-${b}` }
        ));
      }
    }

    expect(largeBlockSet.length).toBeGreaterThanOrEqual(200);
    mockResolveSite.mockResolvedValue(makeSite(largeBlockSet));

    const start = performance.now();
    const res = await GET(
      makeRequest("example-com", "_all", { format: "grouped" }),
      makeCtx("example-com", "_all")
    );
    const elapsed = performance.now() - start;

    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(500);

    const body = await res.json();
    // All blocks present (minus any RobotsTxt)
    const totalBlocks =
      body.sitewide.length +
      body.homepage.length +
      (Object.values(body.pages) as SchemaBlock[][]).reduce((sum, arr) => sum + arr.length, 0);
    expect(totalBlocks).toBe(largeBlockSet.length);
  });
});

// ---------------------------------------------------------------------------
// IT10: CORS headers present
// ---------------------------------------------------------------------------

describe("IT10 — CORS headers", () => {
  it("Access-Control-Allow-Origin: * present on new endpoint", async () => {
    const res = await GET(
      makeRequest("example-com", "pricing"),
      makeCtx("example-com", "pricing")
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("CORS also present on _sitewide", async () => {
    const res = await GET(
      makeRequest("example-com", "_sitewide"),
      makeCtx("example-com", "_sitewide")
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("CORS also present on _all?format=grouped", async () => {
    const res = await GET(
      makeRequest("example-com", "_all", { format: "grouped" }),
      makeCtx("example-com", "_all")
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
