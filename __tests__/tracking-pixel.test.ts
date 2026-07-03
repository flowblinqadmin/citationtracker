/**
 * Tracking pixel system tests — /api/t/[slug] and /api/t/collect
 *
 * Both routes run on Vercel Edge runtime after the Fluid→Edge pivot. The
 * mocks reflect the new dependency graph: supabase-edge replaces Drizzle
 * (@/lib/db), the supabase-js `.from(table).insert(row)` chain replaces
 * `db.insert(table).values(row)`, and helper calls (serve-lookup,
 * log-crawl, rate-limit) live inside the route file now. Row assertions
 * use DB-native snake_case column names.
 *
 * JS endpoint (GET /api/t/[slug]) — unified bot/human:
 *   JS-1  Returns valid JavaScript with Content-Type: application/javascript
 *   JS-2  Human UA → returns 24hr cache header (max-age=86400)
 *   JS-3  The JS contains the slug baked in
 *   JS-4  Human UA → JS contains sendBeacon with absolute URL
 *   JS-5  Human UA → JS is under 1300 bytes
 *   JS-6  Bot UA (GPTBot) → returns schema injection JS containing _fbInject
 *   JS-7  Bot UA → Cache-Control: public, max-age=3600
 *   JS-8  Both responses include Vary: User-Agent
 *   JS-9  Bot with no schema blocks → falls back to beacon JS
 *   JS-13 Unknown bot (Twitterbot) → gets schema injection
 *
 * Img pixel (GET /api/t/[slug] with Accept: image/*):
 *   IMG-1  Accept: image/gif → Content-Type: image/gif
 *   IMG-2  Response body is valid 1x1 GIF (starts with GIF89a)
 *   IMG-3  Cache-Control: no-store (must fire on every page load)
 *   IMG-4  Logs pageview to DB with referrer from Referer header
 *   IMG-5  Bot UA + Accept: image/* → still returns GIF (img path wins)
 *
 * Beacon collector (POST /api/t/collect):
 *   BC-1  Valid beacon → 204 No Content, logs to DB
 *   BC-2  Missing slug → 400
 *   BC-3  Bot user agent (GPTBot) → logged with bot_name "GPTBot"
 *   BC-4  Normal browser UA → logged with bot_name "unknown"
 *   BC-5  CORS: response has Access-Control-Allow-Origin: *
 *   BC-6  OPTIONS preflight returns correct CORS headers
 *   BC-7  Rate limiting: excessive requests get 429
 *
 * Bot vs human classification (parseBotName):
 *   BOT-1  GPTBot → "GPTBot"
 *   BOT-2  ClaudeBot → "ClaudeBot"
 *   BOT-3  Chrome browser → "unknown"
 *   BOT-4  Empty/null UA → "unknown"
 *   BOT-5  Twitterbot → "TwitterBot"
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Hoisted mock handles ─────────────────────────────────────────────────────

const {
  mockInsert,
  mockMaybeSingle,
  mockNanoid,
  mockCheckRateLimit,
  mockCollectPageview,
} = vi.hoisted(() => ({
  // supabase-js .from(table).insert(row) returns a thenable with { error }.
  // Used by the [slug] route (img pixel + crawl log) and shimmed below for
  // the /api/t/collect route which now goes through collectPageviewEdge.
  mockInsert: vi.fn(),
  // supabase-js .from(table).select(...).<filter chain>.maybeSingle()
  // returns { data, error }. Tests override .data per case.
  mockMaybeSingle: vi.fn(),
  mockNanoid: vi.fn().mockReturnValue("mock-nano-id"),
  // Combined rate-limit + insert RPC used by /api/t/collect. Default: allow,
  // shim row through mockInsert so existing row-shape assertions still work.
  mockCollectPageview: vi.fn(),
  mockCheckRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 9,
    resetAt: Date.now() + 60000,
  }),
}));

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("nanoid", () => ({
  nanoid: mockNanoid,
}));

vi.mock("@/lib/supabase-edge", () => {
  /**
   * Minimal supabase-js shape used by the beacon routes:
   *   .from(table).insert(row) → Promise<{ error }>
   *   .from(table).select(cols).<filters>.maybeSingle() → { data, error }
   *
   * The select chain returns `this` from every filter method so the route
   * code can call any order of .eq/.not/.like/.order/.limit before the
   * terminal .maybeSingle().
   */
  const selectChain: Record<string, unknown> = {
    eq: vi.fn(),
    not: vi.fn(),
    like: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
    maybeSingle: mockMaybeSingle,
  };
  selectChain.eq = vi.fn().mockReturnValue(selectChain);
  selectChain.not = vi.fn().mockReturnValue(selectChain);
  selectChain.like = vi.fn().mockReturnValue(selectChain);
  selectChain.order = vi.fn().mockReturnValue(selectChain);
  selectChain.limit = vi.fn().mockReturnValue(selectChain);

  const from = vi.fn(() => ({
    insert: mockInsert,
    select: vi.fn(() => selectChain),
  }));

  // Default impl: shim the row through mockInsert so existing assertions
  // on insert.mock.calls[...] keep working. Individual tests can override
  // with mockCollectPageview.mockResolvedValueOnce(...) to simulate rate limits.
  mockCollectPageview.mockImplementation(
    (
      _rateKey: string,
      _limit: number,
      _windowMs: number,
      row: Record<string, unknown>,
    ) => {
      mockInsert(row);
      return Promise.resolve({
        allowed: true,
        remaining: 9,
        resetAt: Date.now() + 60000,
        inserted: true,
      });
    },
  );

  return {
    supabaseEdge: {
      from,
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
    hashIp: vi.fn().mockResolvedValue(null),
    checkRateLimitEdge: mockCheckRateLimit,
    collectPageviewEdge: mockCollectPageview,
  };
});

// parseBotName, schema-js-builder, cors are pure — let real modules load.

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { GET } from "@/app/api/t/[slug]/route";
import { POST, OPTIONS } from "@/app/api/t/collect/route";
import { parseBotName } from "@/lib/bot-parser";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeGetRequest(slug: string, userAgent?: string, extra?: { accept?: string; referer?: string }) {
  const headers: Record<string, string> = {};
  if (userAgent) headers["user-agent"] = userAgent;
  if (extra?.accept) headers["accept"] = extra.accept;
  if (extra?.referer) headers["referer"] = extra.referer;
  const req = new NextRequest(`http://localhost/api/t/${slug}`, { headers });
  const ctx = { params: Promise.resolve({ slug }) };
  return { req, ctx };
}

function makePostRequest(
  body: Record<string, unknown>,
  options?: { userAgent?: string; ip?: string }
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (options?.userAgent) {
    headers["user-agent"] = options.userAgent;
  }
  if (options?.ip) {
    headers["x-forwarded-for"] = options.ip;
  }
  return new NextRequest("http://localhost/api/t/collect", {
    method: "POST",
    body: JSON.stringify(body),
    headers,
  });
}

// ─── Test data ────────────────────────────────────────────────────────────────

const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const GPTBOT_UA = "Mozilla/5.0 (compatible; GPTBot/1.0; +https://openai.com/gptbot)";
const TWITTERBOT_UA = "Twitterbot/1.0";

const MOCK_SITE_WITH_SCHEMA = {
  id: "site-123",
  domain: "example.com",
  generated_schema_blocks: [
    { type: "Organization", jsonLd: { "@type": "Organization", name: "Acme" } },
    {
      type: "FAQPage",
      pageTarget: "https://example.com/faq",
      jsonLd: { "@type": "FAQPage", name: "FAQ" },
    },
  ],
  pipeline_status: "complete",
};

const MOCK_SITE_NO_SCHEMA = {
  id: "site-456",
  domain: "example.com",
  generated_schema_blocks: null,
  pipeline_status: "complete",
};

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Default: insert succeeds (no error)
  mockInsert.mockResolvedValue({ data: null, error: null });
  // Default: no site found (human path)
  mockMaybeSingle.mockResolvedValue({ data: null, error: null });
});

// ═══════════════════════════════════════════════════════════════════════════════
// JS Endpoint — GET /api/t/[slug] — Human UA
// ═══════════════════════════════════════════════════════════════════════════════

describe("GET /api/t/[slug] — human UA", () => {
  it("JS-1: returns Content-Type: application/javascript", async () => {
    const { req, ctx } = makeGetRequest("test-slug", CHROME_UA);
    const res = await GET(req, ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/javascript");
  });

  it("JS-2: returns 24hr cache header", async () => {
    const { req, ctx } = makeGetRequest("test-slug", CHROME_UA);
    const res = await GET(req, ctx);

    expect(res.headers.get("Cache-Control")).toBe("public, max-age=86400");
  });

  it("JS-3: the JS contains the slug baked in", async () => {
    const { req, ctx } = makeGetRequest("my-store-slug", CHROME_UA);
    const res = await GET(req, ctx);
    const body = await res.text();

    expect(body).toContain("my-store-slug");
  });

  it("JS-4: the JS contains sendBeacon or fetch call to collect endpoint", async () => {
    const { req, ctx } = makeGetRequest("test-slug", CHROME_UA);
    const res = await GET(req, ctx);
    const body = await res.text();

    const hasSendBeacon = body.includes("sendBeacon");
    const hasFetch = body.includes("fetch");
    expect(hasSendBeacon || hasFetch).toBe(true);
  });

  it("JS-5: JS is under 1900 bytes", async () => {
    // Budget grew from 500 → 1300 → 1500 → 1900 as the IIFE added features.
    // The fix/beacon-mobile-perf changes (requestIdleCallback deferral with a
    // setTimeout fallback, memoized session id, and a guarded send() that
    // honors sendBeacon's return value) took it to ~1656 bytes. 1900 leaves
    // headroom; it's still well under 2KB uncompressed (a few hundred bytes
    // gzipped). See docs/research/script-injection-best-practices.md.
    const { req, ctx } = makeGetRequest("test-slug", CHROME_UA);
    const res = await GET(req, ctx);
    const body = await res.text();

    expect(body.length).toBeLessThan(1900);
  });

  it("JS-14: beacon JS hooks pushState for SPA navigation tracking", async () => {
    const { req, ctx } = makeGetRequest("test-slug", CHROME_UA);
    const res = await GET(req, ctx);
    const body = await res.text();

    expect(body).toContain("pushState");
    expect(body).toContain("popstate");
  });

  it("JS-12: beacon JS has absolute URL https://geo.flowblinq.com/api/t/collect", async () => {
    const { req, ctx } = makeGetRequest("test-slug", CHROME_UA);
    const res = await GET(req, ctx);
    const body = await res.text();

    expect(body).toContain("https://geo.flowblinq.com/api/t/collect");
    expect(body).not.toMatch(/var e="\/api\/t\/collect"/);
  });

  it("JS-3b: slug with disallowed characters is rejected (404)", async () => {
    // SECURITY (Phase D, 2026-05-16): the route allowlists [a-zA-Z0-9_-]{1,120}
    // and 404s anything else BEFORE the slug touches the DB or gets baked into
    // an emitted JS body. Replaces the prior posture of "always serialize via
    // JSON.stringify and trust the encoding" — which was XSS-safe but still
    // exposed the slug as a DB-query / response-body surface.
    const { req, ctx } = makeGetRequest('slug"with<html>', CHROME_UA);
    const res = await GET(req, ctx);

    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toBe("");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// JS Endpoint — GET /api/t/[slug] — Bot UA
// ═══════════════════════════════════════════════════════════════════════════════

describe("GET /api/t/[slug] — bot UA", () => {
  it("JS-6: bot UA (GPTBot) → returns schema injection JS containing _fbInject", async () => {
    // First maybeSingle() returns the exact-slug row; second returns the
    // latest-by-domain row (same content, since the test has one site).
    mockMaybeSingle
      .mockResolvedValueOnce({ data: MOCK_SITE_WITH_SCHEMA, error: null })
      .mockResolvedValueOnce({ data: MOCK_SITE_WITH_SCHEMA, error: null });
    const { req, ctx } = makeGetRequest("flowblinq-com", GPTBOT_UA);
    const res = await GET(req, ctx);
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toContain("_fbInject");
    expect(body).toContain("Organization");
    expect(body).toContain("application/ld+json");
  });

  it("JS-7: bot UA response has Cache-Control: public, max-age=3600", async () => {
    mockMaybeSingle
      .mockResolvedValueOnce({ data: MOCK_SITE_WITH_SCHEMA, error: null })
      .mockResolvedValueOnce({ data: MOCK_SITE_WITH_SCHEMA, error: null });
    const { req, ctx } = makeGetRequest("flowblinq-com", GPTBOT_UA);
    const res = await GET(req, ctx);

    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
  });

  it("JS-8: both bot and human responses include Vary: User-Agent", async () => {
    // Bot
    mockMaybeSingle
      .mockResolvedValueOnce({ data: MOCK_SITE_WITH_SCHEMA, error: null })
      .mockResolvedValueOnce({ data: MOCK_SITE_WITH_SCHEMA, error: null });
    const botReq = makeGetRequest("flowblinq-com", GPTBOT_UA);
    const botRes = await GET(botReq.req, botReq.ctx);
    expect(botRes.headers.get("Vary")).toBe("User-Agent");

    // Human (no DB lookup happens)
    const humanReq = makeGetRequest("flowblinq-com", CHROME_UA);
    const humanRes = await GET(humanReq.req, humanReq.ctx);
    expect(humanRes.headers.get("Vary")).toBe("User-Agent");
  });

  it("JS-9: bot with no schema blocks → falls back to beacon JS", async () => {
    mockMaybeSingle.mockResolvedValue({ data: MOCK_SITE_NO_SCHEMA, error: null });
    const { req, ctx } = makeGetRequest("flowblinq-com", GPTBOT_UA);
    const res = await GET(req, ctx);
    const body = await res.text();

    // Should fall back to beacon JS
    expect(body).toContain("sendBeacon");
    expect(body).not.toContain("_fbInject");
  });

  it("JS-13: unknown bot (Twitterbot) → gets schema injection", async () => {
    mockMaybeSingle
      .mockResolvedValueOnce({ data: MOCK_SITE_WITH_SCHEMA, error: null })
      .mockResolvedValueOnce({ data: MOCK_SITE_WITH_SCHEMA, error: null });
    const { req, ctx } = makeGetRequest("flowblinq-com", TWITTERBOT_UA);
    const res = await GET(req, ctx);
    const body = await res.text();

    expect(body).toContain("_fbInject");
    expect(body).toContain("Organization");
  });

  it("JS-9b: bot with site not found → falls back to beacon JS", async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    const { req, ctx } = makeGetRequest("nonexistent", GPTBOT_UA);
    const res = await GET(req, ctx);
    const body = await res.text();

    expect(body).toContain("sendBeacon");
    expect(body).not.toContain("_fbInject");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Img Pixel — GET /api/t/[slug] with Accept: image/*
// ═══════════════════════════════════════════════════════════════════════════════

describe("GET /api/t/[slug] — img pixel", () => {
  it("IMG-1: Accept: image/gif → Content-Type: image/gif", async () => {
    const { req, ctx } = makeGetRequest("test-slug", CHROME_UA, { accept: "image/gif, image/*;q=0.8" });
    const res = await GET(req, ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/gif");
  });

  it("IMG-2: response body is valid 1x1 GIF (starts with GIF89a)", async () => {
    const { req, ctx } = makeGetRequest("test-slug", CHROME_UA, { accept: "image/gif" });
    const res = await GET(req, ctx);
    const buf = await res.arrayBuffer();
    const header = new TextDecoder().decode(new Uint8Array(buf, 0, 6));

    expect(header).toBe("GIF89a");
  });

  it("IMG-3: Cache-Control: no-store (must fire on every page load)", async () => {
    const { req, ctx } = makeGetRequest("test-slug", CHROME_UA, { accept: "image/gif" });
    const res = await GET(req, ctx);

    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });

  it("IMG-4: logs pageview to DB with referrer from Referer header", async () => {
    const { req, ctx } = makeGetRequest("test-slug", CHROME_UA, {
      accept: "image/gif",
      referer: "https://example.com/pricing",
    });
    await GET(req, ctx);

    expect(mockInsert).toHaveBeenCalled();
    const row = mockInsert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.page_url).toBe("https://example.com/pricing");
    expect(row.slug).toBe("test-slug");
  });

  it("IMG-5: bot UA + Accept: image/* → still returns GIF (img path wins)", async () => {
    const { req, ctx } = makeGetRequest("test-slug", GPTBOT_UA, { accept: "image/gif" });
    const res = await GET(req, ctx);

    expect(res.headers.get("Content-Type")).toBe("image/gif");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Beacon Collector — POST /api/t/collect
// ═══════════════════════════════════════════════════════════════════════════════

describe("POST /api/t/collect", () => {
  it("BC-1: valid beacon → 204 No Content, logs to DB", async () => {
    const req = makePostRequest(
      { s: "test-slug", u: "https://example.com/page", r: "https://google.com", w: 1920 },
      { userAgent: "Mozilla/5.0 Chrome/120", ip: "1.2.3.4" }
    );
    const res = await POST(req);

    expect(res.status).toBe(204);
    expect(mockInsert).toHaveBeenCalled();
  });

  it("BC-2: missing slug → 400", async () => {
    const req = makePostRequest(
      { u: "https://example.com/page" },
      { ip: "10.0.0.1" }
    );
    const res = await POST(req);

    expect(res.status).toBe(400);
  });

  it("BC-2b: missing URL → 400", async () => {
    const req = makePostRequest(
      { s: "test-slug" },
      { ip: "10.0.0.2" }
    );
    const res = await POST(req);

    expect(res.status).toBe(400);
  });

  it("BC-3: bot user agent (GPTBot) → logged with bot_name GPTBot", async () => {
    const req = makePostRequest(
      { s: "test-slug", u: "https://example.com/page" },
      { userAgent: "Mozilla/5.0 (compatible; GPTBot/1.0)", ip: "10.0.0.3" }
    );
    await POST(req);

    expect(mockInsert).toHaveBeenCalled();
    const row = mockInsert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.bot_name).toBe("GPTBot");
  });

  it("BC-4: normal browser UA → logged with bot_name from parseBotName (unknown for non-bots)", async () => {
    const req = makePostRequest(
      { s: "test-slug", u: "https://example.com/page" },
      { userAgent: CHROME_UA, ip: "10.0.0.4" }
    );
    await POST(req);

    const row = mockInsert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.bot_name).toBe("unknown");
  });

  it("BC-5: CORS — response has Access-Control-Allow-Origin: *", async () => {
    const req = makePostRequest(
      { s: "test-slug", u: "https://example.com/page" },
      { ip: "10.0.0.5" }
    );
    const res = await POST(req);

    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("BC-6: OPTIONS preflight returns correct CORS headers", async () => {
    const req = new NextRequest("http://localhost/api/t/collect", {
      method: "OPTIONS",
    });
    const res = await OPTIONS(req);

    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Content-Type");
    expect(res.headers.get("Access-Control-Max-Age")).toBe("86400");
  });

  it("BC-7: rate limiting — excessive requests from same IP get 429", async () => {
    mockCollectPageview.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60000,
      inserted: false,
    });

    const req = makePostRequest(
      { s: "test-slug", u: "https://example.com/page" },
      { ip: "rate-limit-test-ip" }
    );
    const res = await POST(req);

    expect(res.status).toBe(429);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Bot vs Human Classification — parseBotName
// ═══════════════════════════════════════════════════════════════════════════════

describe("parseBotName", () => {
  it("BOT-1: GPTBot → GPTBot", () => {
    expect(parseBotName("Mozilla/5.0 (compatible; GPTBot/1.0; +https://openai.com/gptbot)")).toBe("GPTBot");
  });

  it("BOT-2: ClaudeBot → ClaudeBot", () => {
    expect(parseBotName("ClaudeBot/1.0 (claude@anthropic.com)")).toBe("ClaudeBot");
  });

  it("BOT-3: Chrome browser → unknown", () => {
    expect(parseBotName(CHROME_UA)).toBe("unknown");
  });

  it("BOT-4: null UA → unknown", () => {
    expect(parseBotName(null)).toBe("unknown");
  });

  it("BOT-4b: empty string UA → unknown", () => {
    expect(parseBotName("")).toBe("unknown");
  });

  it("BOT-5: Twitterbot → TwitterBot", () => {
    expect(parseBotName("Twitterbot/1.0")).toBe("TwitterBot");
  });
});
