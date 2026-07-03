/**
 * POST /api/t/collect — analytics beacon collection (Vercel Edge runtime)
 *
 * Tests for analytics features. After the Edge migration the route writes
 * via supabase-js (snake_case column names) instead of Drizzle (camelCase
 * JS field names), so assertions reference the DB-native names.
 *
 * COLLECT-1  UTM params extracted from page URL and stored
 * COLLECT-2  City stored from x-vercel-ip-city header
 * COLLECT-3  Region stored from x-vercel-ip-region-code header
 * COLLECT-4  Session ID stored when beacon sends `sid`
 * COLLECT-5  Time on page stored when beacon sends `tms` (integer ms)
 * COLLECT-6  Custom event stored with event_name + props when `type: 'event'`
 * COLLECT-7  CSS referrer (/_next/static/) is nullified
 * COLLECT-8  Normal pageview still works with `type: 'pageview'` (explicit)
 * COLLECT-9  Normal pageview works when `type` is omitted (default)
 * COLLECT-10 Missing required field `s` returns 400
 * COLLECT-11 Missing required field `u` returns 400
 * COLLECT-12 Both `s` and `u` missing returns 400
 * COLLECT-13 Existing fields (country, visitor_id, screen_width, bot_name) still stored
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
// Must be hoisted so they are available before module resolution runs.

// Tests inspect the inserted row via `mockInsert.mock.calls[0][0]`. The route
// now goes through a single collect_pageview RPC instead of a two-call
// pattern, so we route the RPC's 4th arg (the row) through mockInsert as a
// shim — existing assertions stay valid.
const { mockInsert, mockCollect, mockNanoid } = vi.hoisted(() => {
  const _mockInsert = vi.fn().mockResolvedValue({ data: null, error: null });
  const _mockCollect = vi.fn();
  _mockCollect.mockImplementation(
    (_rateKey: string, _limit: number, _windowMs: number, row: Record<string, unknown>) => {
      _mockInsert(row);
      return Promise.resolve({
        allowed: true,
        remaining: 99,
        resetAt: Date.now() + 60000,
        inserted: true,
      });
    },
  );
  return {
    mockInsert: _mockInsert,
    mockCollect: _mockCollect,
    mockNanoid: vi.fn().mockReturnValue("test-nanoid"),
  };
});

vi.mock("@/lib/supabase-edge", () => ({
  hashIp: vi.fn().mockResolvedValue(null),
  collectPageviewEdge: mockCollect,
}));

vi.mock("nanoid", () => ({
  nanoid: mockNanoid,
}));

// Import the route handler AFTER mocks are set up
import { POST } from "./route";

// ── Helpers ───────────────────────────────────────────────────────────────────

interface BeaconPayload {
  s: string;
  u: string;
  r?: string;
  sr?: string;
  vid?: string;
  w?: number;
  v?: string;
  sid?: string;
  tms?: number;
  type?: string;
  event_name?: string;
  props?: Record<string, unknown>;
}

function makeRequest(
  body: Partial<BeaconPayload>,
  headers: Record<string, string> = {}
): NextRequest {
  const allHeaders: Record<string, string> = {
    "content-type": "application/json",
    ...headers,
  };
  return new NextRequest("http://localhost/api/t/collect", {
    method: "POST",
    headers: allHeaders,
    body: JSON.stringify(body),
  });
}

/** Returns the shimmed insert tracker. The combined collect_pageview RPC
 * shim (set up at the top of this file) forwards its row arg to mockInsert,
 * so existing tests that inspect `insert.mock.calls[0][0]` continue to work. */
function mockSuccessfulInsert() {
  return mockInsert;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockNanoid
    .mockReturnValueOnce("id-attempt-1")
    .mockReturnValueOnce("id-attempt-2");
});

// ── COLLECT-10, COLLECT-11, COLLECT-12 — validation ─────────────────────────

describe("POST /api/t/collect — validation", () => {
  it("COLLECT-10: returns 400 when `s` (slug) is missing", async () => {
    const req = makeRequest({ u: "https://example.com/page" });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("COLLECT-11: returns 400 when `u` (page URL) is missing", async () => {
    const req = makeRequest({ s: "my-slug" });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("COLLECT-12: returns 400 when both `s` and `u` are missing", async () => {
    const req = makeRequest({});
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

// ── COLLECT-1 — UTM extraction ────────────────────────────────────────────────

describe("POST /api/t/collect — UTM capture (COLLECT-1)", () => {
  it("extracts utm_source from the page URL query string", async () => {
    const insert = mockSuccessfulInsert();

    const req = makeRequest({
      s: "acme",
      u: "https://acme.com/landing?utm_source=google&utm_medium=cpc&utm_campaign=summer",
    });
    await POST(req);

    expect(insert).toHaveBeenCalled();
    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.utm_source).toBe("google");
  });

  it("extracts utm_medium from the page URL query string", async () => {
    const insert = mockSuccessfulInsert();

    const req = makeRequest({
      s: "acme",
      u: "https://acme.com/landing?utm_source=google&utm_medium=cpc&utm_campaign=summer",
    });
    await POST(req);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.utm_medium).toBe("cpc");
  });

  it("extracts utm_campaign from the page URL query string", async () => {
    const insert = mockSuccessfulInsert();

    const req = makeRequest({
      s: "acme",
      u: "https://acme.com/landing?utm_source=google&utm_medium=cpc&utm_campaign=summer",
    });
    await POST(req);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.utm_campaign).toBe("summer");
  });

  it("stores null for UTM fields when no query params are present", async () => {
    const insert = mockSuccessfulInsert();

    const req = makeRequest({ s: "acme", u: "https://acme.com/page" });
    await POST(req);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.utm_source).toBeNull();
    expect(row.utm_medium).toBeNull();
    expect(row.utm_campaign).toBeNull();
  });

  it("handles a URL with only some UTM params — missing ones are null", async () => {
    const insert = mockSuccessfulInsert();

    const req = makeRequest({
      s: "acme",
      u: "https://acme.com/page?utm_source=newsletter",
    });
    await POST(req);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.utm_source).toBe("newsletter");
    expect(row.utm_medium).toBeNull();
    expect(row.utm_campaign).toBeNull();
  });
});

// ── COLLECT-2, COLLECT-3 — City + Region ─────────────────────────────────────

describe("POST /api/t/collect — city and region (COLLECT-2, COLLECT-3)", () => {
  it("COLLECT-2: stores city from x-vercel-ip-city header", async () => {
    const insert = mockSuccessfulInsert();

    const req = makeRequest(
      { s: "acme", u: "https://acme.com/" },
      { "x-vercel-ip-city": "Toronto" }
    );
    await POST(req);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.city).toBe("Toronto");
  });

  it("COLLECT-3: stores region from x-vercel-ip-region-code header", async () => {
    const insert = mockSuccessfulInsert();

    const req = makeRequest(
      { s: "acme", u: "https://acme.com/" },
      { "x-vercel-ip-region-code": "ON" }
    );
    await POST(req);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.region).toBe("ON");
  });

  it("stores null for city and region when headers are absent", async () => {
    const insert = mockSuccessfulInsert();

    const req = makeRequest({ s: "acme", u: "https://acme.com/" });
    await POST(req);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.city).toBeNull();
    expect(row.region).toBeNull();
  });

  it("stores both city and region together", async () => {
    const insert = mockSuccessfulInsert();

    const req = makeRequest(
      { s: "acme", u: "https://acme.com/" },
      { "x-vercel-ip-city": "Vancouver", "x-vercel-ip-region-code": "BC" }
    );
    await POST(req);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.city).toBe("Vancouver");
    expect(row.region).toBe("BC");
  });
});

// ── COLLECT-4 — Session ID ────────────────────────────────────────────────────

describe("POST /api/t/collect — session ID (COLLECT-4)", () => {
  it("stores the session ID from `sid` field", async () => {
    const insert = mockSuccessfulInsert();

    const req = makeRequest({
      s: "acme",
      u: "https://acme.com/",
      sid: "sess-uuid-abc123",
    });
    await POST(req);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.session_id).toBe("sess-uuid-abc123");
  });

  it("stores null for session_id when `sid` is not sent", async () => {
    const insert = mockSuccessfulInsert();

    const req = makeRequest({ s: "acme", u: "https://acme.com/" });
    await POST(req);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.session_id).toBeNull();
  });
});

// ── COLLECT-5 — Time on Page ──────────────────────────────────────────────────

describe("POST /api/t/collect — time on page (COLLECT-5)", () => {
  it("stores time on page ms from `tms` field", async () => {
    const insert = mockSuccessfulInsert();

    const req = makeRequest({
      s: "acme",
      u: "https://acme.com/",
      tms: 45000,
    });
    await POST(req);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.time_on_page_ms).toBe(45000);
  });

  it("stores null for time_on_page_ms when `tms` is not sent", async () => {
    const insert = mockSuccessfulInsert();

    const req = makeRequest({ s: "acme", u: "https://acme.com/" });
    await POST(req);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.time_on_page_ms).toBeNull();
  });

  it("stores null for time_on_page_ms when `tms` is not an integer", async () => {
    const insert = mockSuccessfulInsert();

    const req = makeRequest({
      s: "acme",
      u: "https://acme.com/",
      tms: "not-a-number" as unknown as number,
    });
    await POST(req);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.time_on_page_ms).toBeNull();
  });
});

// ── COLLECT-6 — Custom Events ─────────────────────────────────────────────────

describe("POST /api/t/collect — custom events (COLLECT-6)", () => {
  it("stores event_name and props when `type` is 'event'", async () => {
    const insert = mockSuccessfulInsert();

    const req = makeRequest({
      s: "acme",
      u: "https://acme.com/checkout",
      type: "event",
      event_name: "purchase",
      props: { value: 99.99, currency: "USD" },
    });
    await POST(req);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.event_name).toBe("purchase");
    expect(row.event_props).toEqual({ value: 99.99, currency: "USD" });
    expect(row.type).toBe("event");
  });

  it("stores null for event_name and event_props on a standard pageview", async () => {
    const insert = mockSuccessfulInsert();

    const req = makeRequest({ s: "acme", u: "https://acme.com/" });
    await POST(req);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.event_name).toBeNull();
    expect(row.event_props).toBeNull();
  });

  it("accepts event with no props (props is optional)", async () => {
    const insert = mockSuccessfulInsert();

    const req = makeRequest({
      s: "acme",
      u: "https://acme.com/signup",
      type: "event",
      event_name: "signup_started",
    });
    await POST(req);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.event_name).toBe("signup_started");
    expect(row.event_props).toBeNull();
  });
});

// ── COLLECT-7 — CSS Referrer Filter ──────────────────────────────────────────

describe("POST /api/t/collect — CSS referrer filter (COLLECT-7)", () => {
  it("nullifies referrer when it contains /_next/static/", async () => {
    const insert = mockSuccessfulInsert();

    const req = makeRequest({
      s: "acme",
      u: "https://acme.com/page",
      r: "https://acme.com/_next/static/chunks/app.js",
    });
    await POST(req);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.referrer).toBeNull();
  });

  it("nullifies sr (server referrer) when it contains /_next/static/", async () => {
    const insert = mockSuccessfulInsert();

    const req = makeRequest({
      s: "acme",
      u: "https://acme.com/page",
      sr: "https://acme.com/_next/static/css/main.css",
    });
    await POST(req);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.referrer).toBeNull();
  });

  it("preserves legitimate external referrer", async () => {
    const insert = mockSuccessfulInsert();

    const req = makeRequest({
      s: "acme",
      u: "https://acme.com/page",
      r: "https://google.com/search?q=acme",
    });
    await POST(req);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.referrer).toBe("https://google.com/search?q=acme");
  });

  it("preserves legitimate same-origin referrer without _next/static", async () => {
    const insert = mockSuccessfulInsert();

    const req = makeRequest({
      s: "acme",
      u: "https://acme.com/checkout",
      r: "https://acme.com/products",
    });
    await POST(req);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.referrer).toBe("https://acme.com/products");
  });

  it("handles referrer that is exactly the _next/static path segment", async () => {
    const insert = mockSuccessfulInsert();

    const req = makeRequest({
      s: "acme",
      u: "https://acme.com/page",
      r: "/_next/static/webpack/bundle.js",
    });
    await POST(req);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.referrer).toBeNull();
  });
});

// ── COLLECT-8, COLLECT-9 — Standard pageview ─────────────────────────────────

describe("POST /api/t/collect — standard pageview (COLLECT-8, COLLECT-9)", () => {
  it("COLLECT-8: accepts type: 'pageview' explicitly and returns 204", async () => {
    mockSuccessfulInsert();

    const req = makeRequest({
      s: "acme",
      u: "https://acme.com/",
      type: "pageview",
    });
    const res = await POST(req);
    expect(res.status).toBe(204);
  });

  it("COLLECT-8: stores type as 'pageview' when sent explicitly", async () => {
    const insert = mockSuccessfulInsert();

    const req = makeRequest({
      s: "acme",
      u: "https://acme.com/about",
      type: "pageview",
    });
    await POST(req);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.type).toBe("pageview");
  });

  it("COLLECT-9: returns 204 when type is omitted (default pageview)", async () => {
    mockSuccessfulInsert();

    const req = makeRequest({ s: "acme", u: "https://acme.com/" });
    const res = await POST(req);
    expect(res.status).toBe(204);
  });

  it("COLLECT-9: defaults type to 'pageview' when not sent", async () => {
    const insert = mockSuccessfulInsert();

    const req = makeRequest({ s: "acme", u: "https://acme.com/" });
    await POST(req);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.type).toBe("pageview");
  });
});

// ── COLLECT-13 — Existing fields still work ───────────────────────────────────

describe("POST /api/t/collect — existing fields still stored (COLLECT-13)", () => {
  it("stores country from x-vercel-ip-country header", async () => {
    const insert = mockSuccessfulInsert();

    const req = makeRequest(
      { s: "acme", u: "https://acme.com/", vid: "visitor-123", w: 1440 },
      { "x-vercel-ip-country": "CA", "user-agent": "Mozilla/5.0" }
    );
    await POST(req);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.country).toBe("CA");
  });

  it("stores visitor_id from vid field", async () => {
    const insert = mockSuccessfulInsert();

    const req = makeRequest({ s: "acme", u: "https://acme.com/", vid: "vis-abc" });
    await POST(req);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.visitor_id).toBe("vis-abc");
  });

  it("stores screen_width from w field", async () => {
    const insert = mockSuccessfulInsert();

    const req = makeRequest({ s: "acme", u: "https://acme.com/", w: 1920 });
    await POST(req);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.screen_width).toBe(1920);
  });

  it("parses bot name from user-agent", async () => {
    const insert = mockSuccessfulInsert();

    const req = makeRequest(
      { s: "acme", u: "https://acme.com/" },
      { "user-agent": "GPTBot/1.0" }
    );
    await POST(req);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.bot_name).toBe("GPTBot");
  });

  it("stores slug and page_url", async () => {
    const insert = mockSuccessfulInsert();

    const req = makeRequest({ s: "my-slug", u: "https://example.com/deep/page" });
    await POST(req);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.slug).toBe("my-slug");
    expect(row.page_url).toBe("https://example.com/deep/page");
  });

  it("prefers sr (server referrer) over r (client referrer) when both are present", async () => {
    const insert = mockSuccessfulInsert();

    const req = makeRequest({
      s: "acme",
      u: "https://acme.com/page",
      r: "https://client-ref.com",
      sr: "https://server-ref.com",
    });
    await POST(req);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.referrer).toBe("https://server-ref.com");
  });
});

// ── Security & edge cases ─────────────────────────────────────────────────────

describe("Security & edge cases", () => {
  // ── Body size limit ──────────────────────────────────────────────────────────

  it("returns 413 when Content-Length exceeds 8 KB", async () => {
    const req = makeRequest(
      { s: "acme", u: "https://acme.com/" },
      { "content-length": "9000" }
    );
    const res = await POST(req);
    expect(res.status).toBe(413);
  });

  // ── Type enum validation ─────────────────────────────────────────────────────

  it("coerces unknown type to 'pageview' (rejects 'admin')", async () => {
    const insert = mockSuccessfulInsert();

    const req = makeRequest({
      s: "acme",
      u: "https://acme.com/",
      type: "admin",
    });
    await POST(req);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.type).toBe("pageview");
    expect(row.type).not.toBe("admin");
  });

  it("accepts type: 'event' as a valid enum value", async () => {
    const insert = mockSuccessfulInsert();

    const req = makeRequest({
      s: "acme",
      u: "https://acme.com/checkout",
      type: "event",
      event_name: "add_to_cart",
    });
    await POST(req);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.type).toBe("event");
  });

  // ── Field truncation ─────────────────────────────────────────────────────────

  it("truncates event_name to 100 chars when event_name exceeds that", async () => {
    const insert = mockSuccessfulInsert();
    const longName = "x".repeat(200);

    const req = makeRequest({
      s: "acme",
      u: "https://acme.com/",
      type: "event",
      event_name: longName,
    });
    await POST(req);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(typeof row.event_name).toBe("string");
    expect((row.event_name as string).length).toBe(100);
  });

  it("truncates session_id to 128 chars when sid exceeds that", async () => {
    const insert = mockSuccessfulInsert();
    const longSid = "s".repeat(200);

    const req = makeRequest({
      s: "acme",
      u: "https://acme.com/",
      sid: longSid,
    });
    await POST(req);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(typeof row.session_id).toBe("string");
    expect((row.session_id as string).length).toBe(128);
  });

  it("truncates page_url to 2048 chars when u exceeds that", async () => {
    const insert = mockSuccessfulInsert();
    const longUrl = "https://acme.com/" + "p".repeat(3000);

    const req = makeRequest({ s: "acme", u: longUrl });
    await POST(req);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(typeof row.page_url).toBe("string");
    expect((row.page_url as string).length).toBe(2048);
  });

  // ── eventProps validation ────────────────────────────────────────────────────

  it("stores valid flat props object (string, number, boolean, null values)", async () => {
    const insert = mockSuccessfulInsert();
    const flatProps = { a: "hello", b: 42, c: true, d: null };

    const req = makeRequest({
      s: "acme",
      u: "https://acme.com/",
      type: "event",
      event_name: "test_event",
      props: flatProps,
    });
    await POST(req);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.event_props).toEqual(flatProps);
  });

  it("rejects nested object props (stores null)", async () => {
    const insert = mockSuccessfulInsert();

    const req = makeRequest({
      s: "acme",
      u: "https://acme.com/",
      type: "event",
      event_name: "test_event",
      props: { a: { b: 1 } } as unknown as Record<string, unknown>,
    });
    await POST(req);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.event_props).toBeNull();
  });

  it("rejects array props (stores null)", async () => {
    const insert = mockSuccessfulInsert();

    const req = makeRequest({
      s: "acme",
      u: "https://acme.com/",
      type: "event",
      event_name: "test_event",
      props: [1, 2, 3] as unknown as Record<string, unknown>,
    });
    await POST(req);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.event_props).toBeNull();
  });

  it("rejects props with more than 50 keys (stores null)", async () => {
    const insert = mockSuccessfulInsert();
    const tooManyKeys = Object.fromEntries(
      Array.from({ length: 51 }, (_, i) => [`key${i}`, i])
    );

    const req = makeRequest({
      s: "acme",
      u: "https://acme.com/",
      type: "event",
      event_name: "test_event",
      props: tooManyKeys,
    });
    await POST(req);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.event_props).toBeNull();
  });

  // ── Extended CSS referrer filter ─────────────────────────────────────────────

  it("nullifies referrer containing /_next/image/ (CSS asset path)", async () => {
    const insert = mockSuccessfulInsert();

    const req = makeRequest({
      s: "acme",
      u: "https://acme.com/page",
      r: "https://www.flowblinq.com/_next/image/foo.png",
    });
    await POST(req);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.referrer).toBeNull();
  });

  it("nullifies referrer containing /_next/chunks/ (JS bundle path)", async () => {
    const insert = mockSuccessfulInsert();

    const req = makeRequest({
      s: "acme",
      u: "https://acme.com/page",
      r: "/_next/chunks/main.js",
    });
    await POST(req);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.referrer).toBeNull();
  });

  it("preserves a legitimate external referrer (not a Next.js asset path)", async () => {
    const insert = mockSuccessfulInsert();

    const req = makeRequest({
      s: "acme",
      u: "https://acme.com/page",
      r: "https://google.com/",
    });
    await POST(req);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.referrer).toBe("https://google.com/");
  });

  // ── City truncation ──────────────────────────────────────────────────────────

  it("truncates city to 100 chars when x-vercel-ip-city header is excessively long", async () => {
    const insert = mockSuccessfulInsert();
    const longCity = "C".repeat(150);

    const req = makeRequest(
      { s: "acme", u: "https://acme.com/" },
      { "x-vercel-ip-city": longCity }
    );
    await POST(req);

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(typeof row.city).toBe("string");
    expect((row.city as string).length).toBe(100);
  });

  // ── CORS headers ─────────────────────────────────────────────────────────────

  it("sets Access-Control-Allow-Origin: * and omits Allow-Credentials for unknown origins", async () => {
    mockSuccessfulInsert();

    const req = new NextRequest("http://localhost/api/t/collect", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.com",
      },
      body: JSON.stringify({ s: "acme", u: "https://acme.com/" }),
    });
    const res = await POST(req);

    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("echoes origin and sets Allow-Credentials for allow-listed origins", async () => {
    mockSuccessfulInsert();

    const req = new NextRequest("http://localhost/api/t/collect", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://www.flowblinq.com",
      },
      body: JSON.stringify({ s: "acme", u: "https://acme.com/" }),
    });
    const res = await POST(req);

    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://www.flowblinq.com"
    );
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(res.headers.get("Vary")).toBe("Origin");
  });
});
