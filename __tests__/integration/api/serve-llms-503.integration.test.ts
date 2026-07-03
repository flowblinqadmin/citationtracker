/**
 * ES-082 Phase A — serve route 503 integration tests (IT7-IT11)
 *
 * Author:   ReviewMaster (Agent 9)
 * Date:     2026-04-09
 * Spec:     geo/docs/specs/engineering/ES-082-llms-txt-empty-generation-fix.md (§d.2, §b.6, §b.7)
 *
 * Tests the post-fix end-to-end behavior of the serve route 503 branch
 * AND the verify-connection 503 branch, exercised through the route
 * handlers with mocked DB lookups (no real DB connection — same pattern
 * as the rest of this repo's "integration" tests).
 *
 * Test breakdown:
 *   IT7   — serve route returns 503 for empty content (LOAD-BEARING for AC-15)
 *   IT8   — serve route returns 200 for non-empty content (regression guard)
 *   IT9   — serve route returns 404 when row doesn't exist (regression guard)
 *   IT10  — verify-connection end-to-end: detects 503 from proxy
 *   IT11  — verify-connection end-to-end: still detects 404 (regression guard)
 *
 * RED state today:
 *   IT7  ✗  RED — pre-fix returns 404 for empty string
 *   IT8  ✓  pre-fix
 *   IT9  ✓  pre-fix
 *   IT10 ✗  RED — pre-fix has no 503 branch in verify-connection ladder
 *   IT11 ✓  pre-fix
 *
 * 2 RED → GREEN after §b.6 + §b.7.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Hoisted mocks ───────────────────────────────────────────────────────────

const { mockResolveSiteForServing, mockLogCrawl, mockSelect } = vi.hoisted(() => ({
  mockResolveSiteForServing: vi.fn(),
  mockLogCrawl: vi.fn(),
  mockSelect: vi.fn(),
}));

vi.mock("@/lib/serve-lookup", () => ({
  resolveSiteForServing: mockResolveSiteForServing,
}));

vi.mock("@/lib/log-crawl", () => ({
  logCrawl: mockLogCrawl,
}));

vi.mock("@/lib/db", () => ({
  db: { select: mockSelect },
}));

vi.mock("@/lib/db/schema", () => ({
  geoSites: {},
}));

// ─── Imports under test ──────────────────────────────────────────────────────

import { GET as GET_LLMS_TXT } from "@/app/api/serve/[slug]/llms.txt/route";
import { POST as POST_VERIFY } from "@/app/api/sites/[id]/verify-connection/route";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SLUG = "manipal-fixture-rm-it7";
const SITE_ID = SLUG;
const DOMAIN = "manipalhospitals.com";
const ACCESS_TOKEN = "rm-it-tok-503";

function makeServeRequest(slug: string): NextRequest {
  return new NextRequest(`https://geo.flowblinq.com/api/serve/${slug}/llms.txt`);
}

function makeServeContext(slug: string) {
  return { params: Promise.resolve({ slug }) };
}

function makeVerifyRequest(): NextRequest {
  return new NextRequest(
    `https://geo.flowblinq.com/api/sites/${SITE_ID}/verify-connection`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    },
  );
}

function makeVerifyContext() {
  return { params: Promise.resolve({ id: SITE_ID }) };
}

function chainSelectVerifyRow() {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([
        { id: SITE_ID, domain: DOMAIN, slug: SLUG, accessToken: ACCESS_TOKEN },
      ]),
    }),
  };
}

function mockFetchStatus(status: number, body: string = "") {
  return vi.spyOn(global, "fetch").mockResolvedValue(
    new Response(body, { status, headers: { "content-type": "text/plain" } }) as any,
  );
}

beforeEach(() => {
  mockResolveSiteForServing.mockReset();
  mockLogCrawl.mockReset();
  mockSelect.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
// IT7-IT9 — serve route 200/404/503 end-to-end
// ═══════════════════════════════════════════════════════════════════════════

describe("ES-082 §d.2 — serve route 503 end-to-end (RM independent)", () => {
  it("IT7: **RED until §b.6 lands** — empty content row returns 503 + Retry-After + customer body", async () => {
    mockResolveSiteForServing.mockResolvedValue({
      id: SITE_ID,
      generatedLlmsTxt: "", // empty-generation bug state
    });

    const res = await GET_LLMS_TXT(makeServeRequest(SLUG), makeServeContext(SLUG));
    const body = await res.text();

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("600");
    // The customer-facing body must include both the diagnostic intent and
    // the action ("re-run the audit") so a partial revert would also surface.
    expect(body).toMatch(/please re-run the audit/i);
    // Anti-cache assertion — must NOT be cacheable
    expect(res.headers.get("cache-control")?.toLowerCase()).toContain("no-store");
  });

  it("IT8: 200 for non-empty content (regression guard)", async () => {
    const content = "# Manipal Hospitals\n\n> Summary.\n\n## About\nBody.";
    mockResolveSiteForServing.mockResolvedValue({
      id: SITE_ID,
      generatedLlmsTxt: content,
    });

    const res = await GET_LLMS_TXT(makeServeRequest(SLUG), makeServeContext(SLUG));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(content);
    expect(res.headers.get("cache-control")?.toLowerCase()).toMatch(/public.*max-age=3600|max-age=3600.*public/);
  });

  it("IT9: 404 when site row doesn't exist (regression guard)", async () => {
    mockResolveSiteForServing.mockResolvedValue(null);

    const res = await GET_LLMS_TXT(
      makeServeRequest("nonexistent-rm"),
      makeServeContext("nonexistent-rm"),
    );

    expect(res.status).toBe(404);
    expect(await res.text()).toMatch(/not found/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// IT10-IT11 — verify-connection 503 end-to-end
// ═══════════════════════════════════════════════════════════════════════════

describe("ES-082 §d.2 — verify-connection 503 end-to-end (RM independent)", () => {
  it("IT10: **RED until §b.7 lands** — proxy 503 → customer-facing 503 message", async () => {
    mockSelect.mockReturnValue(chainSelectVerifyRow());
    mockFetchStatus(503, "Generation pending or failed");

    const res = await POST_VERIFY(makeVerifyRequest(), makeVerifyContext());
    const body = (await res.json()) as { connected: boolean; detail: string };

    expect(body.connected).toBe(false);
    expect(body.detail).toMatch(/correctly proxying/i);
    expect(body.detail).toMatch(/re-run the audit/i);
    expect(body.detail).toMatch(/generation issue/i);
    // Anti-regression: must NOT be the generic "Got HTTP" branch
    expect(body.detail).not.toMatch(/Got HTTP 503/i);
  });

  it("IT11: proxy 404 → existing rewrite-rule message (regression guard for §b.7 ladder ordering)", async () => {
    mockSelect.mockReturnValue(chainSelectVerifyRow());
    mockFetchStatus(404, "Not found");

    const res = await POST_VERIFY(makeVerifyRequest(), makeVerifyContext());
    const body = (await res.json()) as { connected: boolean; detail: string };

    expect(body.connected).toBe(false);
    expect(body.detail).toMatch(/rewrite rule isn't installed/i);
    // Must NOT incorrectly fire the 503 message
    expect(body.detail).not.toMatch(/correctly proxying/i);
  });
});
