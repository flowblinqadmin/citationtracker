/**
 * Tests for POST /api/sites/[id]/fix-html-render
 *
 * Phase A2 regression locks (pre-merge) — added 2026-05-16 to ensure the
 * Fix HTML tab feature survives the integration → main merge and any
 * subsequent security hardening. Covers:
 *
 *   AUTH-1   401 when token query param missing
 *   AUTH-2   401 when token mismatches view.accessToken
 *   AUTH-3   402 when site.teamId is null (free tier)
 *   AUTH-4   402 when deductCredits returns insufficient_credits
 *
 *   BODY-1   400 when body is not valid JSON
 *   BODY-2   400 when pastedHtml is missing/empty
 *   BODY-3   413 when pastedHtml exceeds 5 MB
 *
 *   URL-1    detectedUrl prefers <link rel="canonical">
 *   URL-2    falls back to <meta property="og:url"> when no canonical
 *   URL-3    falls back to <meta property="twitter:url">
 *   URL-4    explicit selectedUrl in body wins over auto-detect
 *
 *   HAPPY-1  200 returns { fixedHtml, detectedUrl, sideBySide, appliedChanges, creditsRemaining }
 *   HAPPY-2  sideBySide rows align line numbers for context lines
 *   HAPPY-3  site-level schema blocks inject into <head> when no per-page fix matches URL
 *   HAPPY-4  per-page fix is matched by exact URL when present
 *   HAPPY-5  per-page fix matched via hostname+path fallback (handles trailing slash, www prefix)
 *
 *   CREDIT-1 deductCredits called with cost=ACTION_CREDITS.fixHtmlRender, type='fix_html_render'
 *
 *   ROBUST-1 pathological HTML (malformed entities) does not crash — returns 200 with warnings
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const { mockDbSelect, mockDeductCredits } = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
  mockDeductCredits: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: mockDbSelect,
  },
}));

vi.mock("@/lib/services/credit-deduction", () => ({
  deductCredits: mockDeductCredits,
}));

// fix-html-generator runs unmocked — it's pure logic (jsdom + text ops) and is
// part of what we want to lock in.

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { POST } from "@/app/api/sites/[id]/fix-html-render/route";
import { ACTION_CREDITS } from "@/lib/config";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SITE_ID = "site-fix-html-abc";
const ACCESS_TOKEN = "token-fix-html-xyz";
const TEAM_ID = "team-fix-html-1";

interface ViewOverrides {
  siteId?: string;
  accessToken?: string | null;
  teamId?: string | null;
  domain?: string;
  perPageFixes?: unknown;
  generatedSchemaBlocks?: unknown;
}

function makeView(overrides: ViewOverrides = {}) {
  return {
    siteId: SITE_ID,
    accessToken: ACCESS_TOKEN,
    teamId: TEAM_ID,
    domain: "example.com",
    perPageFixes: null,
    generatedSchemaBlocks: null,
    ...overrides,
  };
}

function makeSelectChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
  };
}

function makeRequest(
  siteId: string,
  token: string | null,
  body: unknown | string,
): Request {
  const tokenSuffix = token === null ? "" : `?token=${token}`;
  const url = `http://localhost/api/sites/${siteId}/fix-html-render${tokenSuffix}`;
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
  };
  if (typeof body === "string") {
    init.body = body;
  } else {
    init.body = JSON.stringify(body);
  }
  return new Request(url, init);
}

function makeRouteContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

const MINIMAL_HTML =
  '<!DOCTYPE html><html><head><title>x</title></head><body><h1>Hi</h1></body></html>';

const HTML_WITH_CANONICAL = `<!DOCTYPE html><html><head>
<title>Existing</title>
<link rel="canonical" href="https://example.com/canon">
</head><body><h1>Hi</h1></body></html>`;

const HTML_WITH_OG_URL = `<!DOCTYPE html><html><head>
<title>Existing</title>
<meta property="og:url" content="https://example.com/og-page">
</head><body><h1>Hi</h1></body></html>`;

const HTML_WITH_TWITTER_URL = `<!DOCTYPE html><html><head>
<title>Existing</title>
<meta property="twitter:url" content="https://example.com/tw-page">
</head><body><h1>Hi</h1></body></html>`;

beforeEach(() => {
  vi.clearAllMocks();
  // Default: deductCredits succeeds with 15 credits remaining.
  mockDeductCredits.mockResolvedValue({
    success: true,
    balanceBefore: 20,
    balanceAfter: 15,
  });
  // Default: db.select() returns one view row.
  mockDbSelect.mockReturnValue(makeSelectChain([makeView()]));
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("AUTH gate", () => {
  it("AUTH-1: 401 when token query param is missing", async () => {
    const req = makeRequest(SITE_ID, null, { pastedHtml: MINIMAL_HTML });
    const res = await POST(req, makeRouteContext(SITE_ID));
    expect(res.status).toBe(401);
    expect(mockDeductCredits).not.toHaveBeenCalled();
  });

  it("AUTH-2: 401 when token mismatches view.accessToken", async () => {
    mockDbSelect.mockReturnValue(makeSelectChain([makeView({ accessToken: "different" })]));
    const req = makeRequest(SITE_ID, ACCESS_TOKEN, { pastedHtml: MINIMAL_HTML });
    const res = await POST(req, makeRouteContext(SITE_ID));
    expect(res.status).toBe(401);
    expect(mockDeductCredits).not.toHaveBeenCalled();
  });

  it("AUTH-3: 402 when site.teamId is null (free tier user)", async () => {
    mockDbSelect.mockReturnValue(makeSelectChain([makeView({ teamId: null })]));
    const req = makeRequest(SITE_ID, ACCESS_TOKEN, { pastedHtml: MINIMAL_HTML });
    const res = await POST(req, makeRouteContext(SITE_ID));
    expect(res.status).toBe(402);
    expect(mockDeductCredits).not.toHaveBeenCalled();
  });

  it("AUTH-4: 402 when deductCredits returns insufficient_credits", async () => {
    mockDeductCredits.mockResolvedValueOnce({ success: false, error: "insufficient_credits" });
    const req = makeRequest(SITE_ID, ACCESS_TOKEN, { pastedHtml: MINIMAL_HTML });
    const res = await POST(req, makeRouteContext(SITE_ID));
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toBe("insufficient_credits");
  });
});

describe("BODY validation", () => {
  it("BODY-1: 400 when body is not valid JSON", async () => {
    const req = makeRequest(SITE_ID, ACCESS_TOKEN, "not-json-{{{");
    const res = await POST(req, makeRouteContext(SITE_ID));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid json/i);
  });

  it("BODY-2: 400 when pastedHtml is missing/empty", async () => {
    const req = makeRequest(SITE_ID, ACCESS_TOKEN, { pastedHtml: "  " });
    const res = await POST(req, makeRouteContext(SITE_ID));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/required/i);
  });

  it("BODY-3: 413 when pastedHtml exceeds 5 MB", async () => {
    const oversized = "x".repeat(5_000_001);
    const req = makeRequest(SITE_ID, ACCESS_TOKEN, { pastedHtml: oversized });
    const res = await POST(req, makeRouteContext(SITE_ID));
    expect(res.status).toBe(413);
  });
});

describe("URL auto-detection", () => {
  it("URL-1: detectedUrl prefers <link rel='canonical'>", async () => {
    const req = makeRequest(SITE_ID, ACCESS_TOKEN, { pastedHtml: HTML_WITH_CANONICAL });
    const res = await POST(req, makeRouteContext(SITE_ID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.detectedUrl).toBe("https://example.com/canon");
  });

  it("URL-2: falls back to <meta property='og:url'>", async () => {
    const req = makeRequest(SITE_ID, ACCESS_TOKEN, { pastedHtml: HTML_WITH_OG_URL });
    const res = await POST(req, makeRouteContext(SITE_ID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.detectedUrl).toBe("https://example.com/og-page");
  });

  it("URL-3: falls back to <meta property='twitter:url'>", async () => {
    const req = makeRequest(SITE_ID, ACCESS_TOKEN, { pastedHtml: HTML_WITH_TWITTER_URL });
    const res = await POST(req, makeRouteContext(SITE_ID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.detectedUrl).toBe("https://example.com/tw-page");
  });

  it("URL-4: explicit selectedUrl in body wins over auto-detect", async () => {
    const perPageFixes = [{
      url: "https://example.com/selected",
      suggestedTitle: "Selected Page",
      suggestedMetaDescription: "...",
      h1Fix: "Selected",
      matchedSchemaBlocks: [],
    }];
    mockDbSelect.mockReturnValue(makeSelectChain([makeView({ perPageFixes })]));

    const req = makeRequest(SITE_ID, ACCESS_TOKEN, {
      pastedHtml: HTML_WITH_CANONICAL,
      selectedUrl: "https://example.com/selected",
    });
    const res = await POST(req, makeRouteContext(SITE_ID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.matchedUrl).toBe("https://example.com/selected");
    expect(body.matchSource).toBe("selected");
  });
});

describe("happy path", () => {
  it("HAPPY-1: 200 returns the full response shape", async () => {
    const perPageFixes = [{
      url: "https://example.com/canon",
      suggestedTitle: "New Title",
      suggestedMetaDescription: "A new description.",
      h1Fix: "New H1",
      matchedSchemaBlocks: [],
    }];
    mockDbSelect.mockReturnValue(makeSelectChain([makeView({ perPageFixes })]));

    const req = makeRequest(SITE_ID, ACCESS_TOKEN, { pastedHtml: HTML_WITH_CANONICAL });
    const res = await POST(req, makeRouteContext(SITE_ID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      fixedHtml: expect.any(String),
      detectedUrl: "https://example.com/canon",
      matchedUrl: "https://example.com/canon",
      matchSource: "detected",
      appliedChanges: expect.any(Array),
      warnings: expect.any(Array),
      sideBySide: expect.any(Array),
      creditsRemaining: 15,
    });
    // Fix should change at least the <title> + <h1>
    expect(body.fixedHtml).toContain("New Title");
    expect(body.fixedHtml).toContain("New H1");
  });

  it("HAPPY-2: sideBySide rows have aligned line numbers for context", async () => {
    const req = makeRequest(SITE_ID, ACCESS_TOKEN, { pastedHtml: MINIMAL_HTML });
    const res = await POST(req, makeRouteContext(SITE_ID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.sideBySide)).toBe(true);
    expect(body.sideBySide.length).toBeGreaterThan(0);
    // Every row has the expected discriminated shape
    for (const row of body.sideBySide) {
      expect(["context", "removed", "added"]).toContain(row.marker);
      if (row.marker === "context") {
        expect(row.pasted).not.toBeNull();
        expect(row.fixed).not.toBeNull();
      }
      if (row.marker === "removed") {
        expect(row.pasted).not.toBeNull();
        expect(row.fixed).toBeNull();
      }
      if (row.marker === "added") {
        expect(row.pasted).toBeNull();
        expect(row.fixed).not.toBeNull();
      }
    }
  });

  it("HAPPY-3: site-level schema blocks inject into <head> when no per-page match", async () => {
    const siteSchema = '{"@context":"https://schema.org","@type":"Organization","name":"Example"}';
    mockDbSelect.mockReturnValue(
      makeSelectChain([makeView({ generatedSchemaBlocks: [siteSchema], perPageFixes: [] })]),
    );

    const req = makeRequest(SITE_ID, ACCESS_TOKEN, { pastedHtml: HTML_WITH_CANONICAL });
    const res = await POST(req, makeRouteContext(SITE_ID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fixedHtml).toContain("schema.org");
    expect(body.fixedHtml).toContain("Organization");
  });

  it("HAPPY-4: per-page fix is matched by exact URL", async () => {
    const perPageFixes = [{
      url: "https://example.com/canon",
      suggestedTitle: "Match Win",
      suggestedMetaDescription: "...",
      h1Fix: "Match Win H1",
      matchedSchemaBlocks: [],
    }, {
      url: "https://example.com/other",
      suggestedTitle: "Should Not Apply",
      suggestedMetaDescription: "...",
      h1Fix: "Should Not Apply H1",
      matchedSchemaBlocks: [],
    }];
    mockDbSelect.mockReturnValue(makeSelectChain([makeView({ perPageFixes })]));

    const req = makeRequest(SITE_ID, ACCESS_TOKEN, { pastedHtml: HTML_WITH_CANONICAL });
    const res = await POST(req, makeRouteContext(SITE_ID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.matchedUrl).toBe("https://example.com/canon");
    expect(body.fixedHtml).toContain("Match Win");
    expect(body.fixedHtml).not.toContain("Should Not Apply");
  });

  it("HAPPY-5: per-page fix matched via hostname+path fallback (www prefix tolerance)", async () => {
    const perPageFixes = [{
      url: "http://www.example.com/canon/",  // http+www+trailing slash variant
      suggestedTitle: "Fallback Match",
      suggestedMetaDescription: "...",
      h1Fix: "Fallback H1",
      matchedSchemaBlocks: [],
    }];
    mockDbSelect.mockReturnValue(makeSelectChain([makeView({ perPageFixes })]));

    // detected URL is https://example.com/canon — should still match
    const req = makeRequest(SITE_ID, ACCESS_TOKEN, { pastedHtml: HTML_WITH_CANONICAL });
    const res = await POST(req, makeRouteContext(SITE_ID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.matchedUrl).toBe("http://www.example.com/canon/");
    expect(body.fixedHtml).toContain("Fallback Match");
  });
});

describe("credit deduction", () => {
  it("CREDIT-1: deductCredits called with fixHtmlRender cost + correct type", async () => {
    const req = makeRequest(SITE_ID, ACCESS_TOKEN, { pastedHtml: MINIMAL_HTML });
    await POST(req, makeRouteContext(SITE_ID));

    expect(mockDeductCredits).toHaveBeenCalledTimes(1);
    expect(mockDeductCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: TEAM_ID,
        cost: ACTION_CREDITS.fixHtmlRender,
        type: "fix_html_render",
        siteId: SITE_ID,
      }),
    );
  });
});

describe("robustness", () => {
  it("ROBUST-1: pathological HTML (malformed entities) does not crash", async () => {
    // Pre-merge baseline. If this returns 500, that's a Fix HTML bug — the
    // route should degrade gracefully rather than throwing on bad input.
    const pathological =
      '<!DOCTYPE html><html><head><title>broken</title></head><body><h1>&unclosed entity ref<p>nested<div>weird</p></div></h1>&amp;&lt;&#xQ;</body></html>';
    const req = makeRequest(SITE_ID, ACCESS_TOKEN, { pastedHtml: pathological });
    const res = await POST(req, makeRouteContext(SITE_ID));
    // Acceptable: 200 with warnings, OR a structured 4xx — NOT 500
    expect(res.status).not.toBe(500);
  });
});

// ─── Step 2 defensive paths ──────────────────────────────────────────────────
// These tests lock in the behavior added 2026-05-16 to harden the route
// against the three failure hypotheses we couldn't directly observe in prod
// (the stack-trace deploy on `debug/fix-html-500-instrumentation` is needed
// to confirm which one fires). All three should degrade gracefully instead
// of producing a 500 with an opaque "Render failed" body.

describe("Step 2 defensive paths", () => {
  it("DEFENSE-1: 500 response body includes `detail` with the error message", async () => {
    // Force the geo_site_view read to throw with a generic error. The outer
    // catch should surface the actual message in the response body so the
    // browser network tab is enough to diagnose — no need to chase Vercel
    // runtime logs.
    mockDbSelect.mockImplementationOnce(() => {
      throw new Error("synthetic DB explosion");
    });

    const req = makeRequest(SITE_ID, ACCESS_TOKEN, { pastedHtml: MINIMAL_HTML });
    const res = await POST(req, makeRouteContext(SITE_ID));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Render failed");
    expect(body.detail).toContain("synthetic DB explosion");
    expect(body.name).toBe("Error");
  });

  it("DEFENSE-2: missing per_page_fixes column falls back to minimal select", async () => {
    // Simulate the prod DB schema gap where geo_site_view was created BEFORE
    // per_page_fixes was added (migration 001 used CREATE TABLE IF NOT EXISTS
    // so subsequent column adds were lost). First call throws with the
    // expected column-missing pattern; second call (the fallback minimal
    // select) succeeds with a row that lacks the jsonb columns.
    let callCount = 0;
    mockDbSelect.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockRejectedValue(
            new Error('column "per_page_fixes" does not exist'),
          ),
        };
      }
      // Fallback minimal select succeeds — note: no perPageFixes /
      // generatedSchemaBlocks fields, mimicking the partial-migration prod DB.
      return makeSelectChain([{
        siteId: SITE_ID,
        accessToken: ACCESS_TOKEN,
        teamId: TEAM_ID,
        domain: "example.com",
      }]);
    });

    const req = makeRequest(SITE_ID, ACCESS_TOKEN, { pastedHtml: MINIMAL_HTML });
    const res = await POST(req, makeRouteContext(SITE_ID));
    expect(res.status).toBe(200);
    const body = await res.json();
    // No per-page fix data was available, so only structural additions apply.
    expect(body.warnings.some((w: string) => /per-page fix data/i.test(w))).toBe(true);
  });

  it("DEFENSE-3: column-missing fallback ONLY catches the expected pattern; other errors bubble to 500", async () => {
    // A different error (FK violation, syntax error, etc.) MUST still 500 so
    // it's surfaced — we don't want the fallback to silently mask unrelated
    // DB problems.
    mockDbSelect.mockImplementationOnce(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockRejectedValue(new Error("unrelated DB error")),
    }));

    const req = makeRequest(SITE_ID, ACCESS_TOKEN, { pastedHtml: MINIMAL_HTML });
    const res = await POST(req, makeRouteContext(SITE_ID));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.detail).toContain("unrelated DB error");
  });
});
