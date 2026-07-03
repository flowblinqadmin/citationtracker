/**
 * Serve route GET handler tests — /api/serve/[slug]/llms.txt
 *
 * Covers the 8 tests in this file. Earlier rate-limit / IP-parsing tests
 * (RL-1..RL-4, IP-1..IP-2) were removed in commit a248c7c when rate limiting
 * moved out of this route. NF-3 was updated to assert 503 (was 404) per
 * ES-082 §b.6 — empty generatedLlmsTxt now distinguishes from null:
 *   - null/missing → 404 (legacy / never-generated)
 *   - empty string → 503 with Retry-After (Manipal-class generation failure)
 *   - non-empty → 200
 *
 *   Not found / missing data
 *   NF-1  Slug not found in DB — 404
 *   NF-2  Site exists but generatedLlmsTxt is null — 404
 *   NF-3  Site exists but generatedLlmsTxt is empty string — 503 (ES-082 §b.6)
 *
 *   Happy path with response headers
 *   HP-1  Valid site — 200 with correct Content-Type, Cache-Control, X-Generator
 *   HP-2  Valid site — response body matches generatedLlmsTxt content
 *
 *   Error handling
 *   EH-1  DB error — 500
 *
 *   logCrawl integration
 *   LC-1  logCrawl called with correct arguments for valid request
 *   LC-2  logCrawl rejection does not crash the 200 response (void call)
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Hoisted mock handles ─────────────────────────────────────────────────────
// vi.hoisted() runs before module resolution, giving us stable references
// that can be captured in vi.mock() factory closures.

const { mockCheckRateLimit, mockIsKnownAICrawler, mockLogCrawl } = vi.hoisted(() => ({
  mockCheckRateLimit: vi.fn(),
  mockIsKnownAICrawler: vi.fn(),
  mockLogCrawl: vi.fn(),
}));

// ─── Mocks — must be declared before any import of the module under test ──────

vi.mock("@/lib/db", () => ({
  db: { select: vi.fn() },
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mockCheckRateLimit,
}));

vi.mock("@/lib/crawler-allowlist", () => ({
  isKnownAICrawler: mockIsKnownAICrawler,
}));

vi.mock("@/lib/log-crawl", () => ({
  logCrawl: mockLogCrawl,
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  and: vi.fn(),
  isNotNull: vi.fn(),
  like: vi.fn(),
  desc: vi.fn(),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { db } from "@/lib/db";
import { GET } from "@/app/api/serve/[slug]/llms.txt/route";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Builds a NextRequest and the RouteContext params pair expected by the handler.
 * The ip parameter is used for the x-forwarded-for header; omit to test the
 * "no header" path.
 */
function makeRequest(
  slug: string,
  ua = "Mozilla/5.0",
  ip?: string
): [NextRequest, { params: Promise<{ slug: string }> }] {
  const headers: Record<string, string> = { "user-agent": ua };
  if (ip !== undefined) {
    headers["x-forwarded-for"] = ip;
  }
  const req = new NextRequest(
    `https://geo.flowblinq.com/api/serve/${slug}/llms.txt`,
    { method: "GET", headers }
  );
  return [req, { params: Promise.resolve({ slug }) }];
}

/**
 * Builds the fluent DB select chain returned by db.select().
 * from() → where() → resolves with the provided rows array.
 */
function makeSelectChain(rows: unknown[] = []) {
  // resolveSiteForServing uses two patterns:
  //   1. db.select().from().where() — resolves directly (exact slug lookup)
  //   2. db.select().from().where().orderBy().limit() — chained (domain lookup)
  // The where() mock must be both thenable (for pattern 1) and chainable (for pattern 2)
  const resolved = Promise.resolve(rows);
  const chain: Record<string, unknown> = {
    from: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  chain.where = vi.fn().mockImplementation(() => {
    const thenableChain = { ...chain, then: resolved.then.bind(resolved), catch: resolved.catch.bind(resolved) };
    return thenableChain;
  });
  return chain;
}

/** A minimal site row with a populated generatedLlmsTxt. */
const MOCK_SITE = {
  id: "site-abc-123",
  slug: "acme-corp",
  generatedLlmsTxt: "# ACME Corp\n\nThis is the llms.txt content.",
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/serve/[slug]/llms.txt", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Safe defaults so each test only overrides what it cares about.
    mockIsKnownAICrawler.mockReturnValue(false);
    mockCheckRateLimit.mockResolvedValue({
      allowed: true,
      remaining: 9,
      resetAt: Date.now() + 60_000,
    });
    mockLogCrawl.mockResolvedValue(undefined);
    vi.mocked(db.select).mockReturnValue(makeSelectChain([MOCK_SITE]) as ReturnType<typeof db.select>);
  });

  // ── Rate limiting ────────────────────────────────────────────────────────────

  // RL-1 through RL-4 removed — rate limiting removed from serve endpoints (HP-135)

  // ── Not found / missing data ─────────────────────────────────────────────────

  describe("Not found / missing data", () => {
    it("NF-1: slug not found in DB returns 404", async () => {
      vi.mocked(db.select).mockReturnValue(makeSelectChain([]) as ReturnType<typeof db.select>);
      const [req, ctx] = makeRequest("unknown-slug", "Mozilla/5.0", "1.2.3.4");

      const res = await GET(req, ctx);

      expect(res.status).toBe(404);
    });

    it("NF-2: site exists but generatedLlmsTxt is null returns 404", async () => {
      const siteWithoutContent = { ...MOCK_SITE, generatedLlmsTxt: null };
      vi.mocked(db.select).mockReturnValue(
        makeSelectChain([siteWithoutContent]) as ReturnType<typeof db.select>
      );
      const [req, ctx] = makeRequest("acme-corp", "Mozilla/5.0", "1.2.3.4");

      const res = await GET(req, ctx);

      expect(res.status).toBe(404);
    });

    it("NF-3: site exists but generatedLlmsTxt is empty string returns 503 (ES-082 §b.6)", async () => {
      // ES-082 §b.6 / AC-7: empty content is now distinguished from null.
      // - null/missing → 404 (legacy / never-generated)
      // - empty string → 503 with Retry-After (Manipal-class generation failure)
      // - non-empty → 200
      const siteWithEmptyContent = { ...MOCK_SITE, generatedLlmsTxt: "" };
      vi.mocked(db.select).mockReturnValue(
        makeSelectChain([siteWithEmptyContent]) as ReturnType<typeof db.select>
      );
      const [req, ctx] = makeRequest("acme-corp", "Mozilla/5.0", "1.2.3.4");

      const res = await GET(req, ctx);

      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBe("600");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    });
  });

  // ── Happy path with response headers ────────────────────────────────────────

  describe("Happy path", () => {
    it("HP-1: valid site returns 200 with correct Content-Type, Cache-Control, and X-Generator headers", async () => {
      const [req, ctx] = makeRequest("acme-corp", "Mozilla/5.0", "1.2.3.4");

      const res = await GET(req, ctx);

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
      expect(res.headers.get("X-Generator")).toBe("FlowBlinq GEO");
    });

    it("HP-2: valid site response body matches generatedLlmsTxt", async () => {
      const [req, ctx] = makeRequest("acme-corp", "Mozilla/5.0", "1.2.3.4");

      const res = await GET(req, ctx);
      const body = await res.text();

      expect(body).toBe(MOCK_SITE.generatedLlmsTxt);
    });
  });

  // ── Error handling ───────────────────────────────────────────────────────────

  describe("Error handling", () => {
    it("EH-1: DB error returns 500", async () => {
      vi.mocked(db.select).mockImplementation(() => {
        throw new Error("DB connection lost");
      });
      const [req, ctx] = makeRequest("acme-corp", "Mozilla/5.0", "1.2.3.4");

      const res = await GET(req, ctx);

      expect(res.status).toBe(500);
    });

    // EH-2, IP-1, IP-2 removed — rate limiting removed from serve endpoints (HP-135)
  });

  // ── logCrawl integration ─────────────────────────────────────────────────────

  describe("logCrawl integration", () => {
    it("LC-1: logCrawl is called with the request, site id, slug, and 'llms_txt' on a valid request", async () => {
      const slug = "acme-corp";
      const [req, ctx] = makeRequest(slug, "Mozilla/5.0", "1.2.3.4");

      await GET(req, ctx);

      expect(mockLogCrawl).toHaveBeenCalledOnce();
      expect(mockLogCrawl).toHaveBeenCalledWith(req, MOCK_SITE.id, slug, "llms_txt");
    });

    it("LC-2: logCrawl rejection does not crash the handler — response is still 200", async () => {
      // The handler calls logCrawl with void, so a rejection must be silently
      // swallowed and must not propagate into the response.
      mockLogCrawl.mockRejectedValue(new Error("logging service down"));
      const [req, ctx] = makeRequest("acme-corp", "Mozilla/5.0", "1.2.3.4");

      // Allow any unhandled promise rejection that fires asynchronously to settle.
      const res = await GET(req, ctx);

      expect(res.status).toBe(200);
    });
  });
});
