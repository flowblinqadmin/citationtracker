/**
 * ES-082 Phase A — serve route /api/serve/[slug]/llms-full.txt mirror tests (M35-M41)
 *
 * Author:   ReviewMaster (Agent 9)
 * Date:     2026-04-09
 * Spec:     geo/docs/specs/engineering/ES-082-llms-txt-empty-generation-fix.md (§c.6, §b.6)
 *
 * Mirror of llms-txt-route.test.ts (U35-U41) against the full-text serve
 * route. Per ES-082 §b.6 the same 404/503/200 discrimination applies
 * defensively — currently no full-text empty cases exist in production,
 * but the symmetry must be enforced so a future regression on the short
 * route does not creep into the full route uncaught.
 *
 * Test IDs M35-M41 mirror U35-U41 verbatim with these substitutions:
 *   - field:       `generatedLlmsTxt` → `generatedLlmsFullTxt`
 *   - log type:    `llms_txt_empty`   → `llms_full_txt_empty`
 *   - route:       `/llms.txt`        → `/llms-full.txt`
 *
 * RED state today (pre-fix): the route at line 15 collapses both `!site`
 * and `!site.generatedLlmsFullTxt` into 404. So:
 *   M35  ✓  pre-fix
 *   M36  ✓  pre-fix
 *   M37  ✓  pre-fix
 *   M38  ✗  RED — must return 503 for empty string
 *   M39  ✗  RED
 *   M40  ✗  RED
 *   M41  ✗  RED
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockResolveSiteForServing, mockLogCrawl } = vi.hoisted(() => ({
  mockResolveSiteForServing: vi.fn(),
  mockLogCrawl: vi.fn(),
}));

vi.mock("@/lib/serve-lookup", () => ({
  resolveSiteForServing: mockResolveSiteForServing,
}));

vi.mock("@/lib/log-crawl", () => ({
  logCrawl: mockLogCrawl,
}));

import { GET } from "@/app/api/serve/[slug]/llms-full.txt/route";

function makeRequest(slug: string): NextRequest {
  return new NextRequest(`https://geo.flowblinq.com/api/serve/${slug}/llms-full.txt`);
}

function makeContext(slug: string) {
  return { params: Promise.resolve({ slug }) };
}

beforeEach(() => {
  mockResolveSiteForServing.mockReset();
  mockLogCrawl.mockReset();
});

describe("ES-082 §c.6 — GET /api/serve/[slug]/llms-full.txt mirror (RM independent)", () => {
  it("M35: returns 200 with body when site has non-empty generatedLlmsFullTxt", async () => {
    const content = "# Test Brand\n\n> Summary.\n\n## About\n" + "Body. ".repeat(200);
    mockResolveSiteForServing.mockResolvedValue({
      id: "manipal-fixture-rm",
      generatedLlmsFullTxt: content,
    });

    const res = await GET(makeRequest("manipal-fixture-rm"), makeContext("manipal-fixture-rm"));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe(content);
  });

  it("M36: returns 404 when resolveSiteForServing returns null", async () => {
    mockResolveSiteForServing.mockResolvedValue(null);
    const res = await GET(makeRequest("nonexistent-rm"), makeContext("nonexistent-rm"));
    expect(res.status).toBe(404);
  });

  it("M37: returns 404 when site exists with generatedLlmsFullTxt === null", async () => {
    mockResolveSiteForServing.mockResolvedValue({
      id: "legacy-fixture-rm",
      generatedLlmsFullTxt: null,
    });
    const res = await GET(makeRequest("legacy-fixture-rm"), makeContext("legacy-fixture-rm"));
    expect(res.status).toBe(404);
  });

  it("M38: **RED until §b.6 lands** — returns 503 with Retry-After when generatedLlmsFullTxt === ''", async () => {
    mockResolveSiteForServing.mockResolvedValue({
      id: "manipal-fixture-rm",
      generatedLlmsFullTxt: "",
    });

    const res = await GET(makeRequest("manipal-fixture-rm"), makeContext("manipal-fixture-rm"));

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("600");
    expect(await res.text()).toMatch(/please re-run the audit/i);
  });

  it("M39: 503 response sets Cache-Control: no-store", async () => {
    mockResolveSiteForServing.mockResolvedValue({
      id: "manipal-fixture-rm",
      generatedLlmsFullTxt: "",
    });
    const res = await GET(makeRequest("manipal-fixture-rm"), makeContext("manipal-fixture-rm"));
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")?.toLowerCase()).toContain("no-store");
  });

  it("M40: 503 path logs llms_full_txt_empty crawl type via logCrawl", async () => {
    mockResolveSiteForServing.mockResolvedValue({
      id: "manipal-fixture-rm",
      generatedLlmsFullTxt: "",
    });
    await GET(makeRequest("manipal-fixture-rm"), makeContext("manipal-fixture-rm"));

    expect(mockLogCrawl).toHaveBeenCalled();
    const call = mockLogCrawl.mock.calls.find((c) =>
      c.some((arg: unknown) => arg === "llms_full_txt_empty"),
    );
    expect(call).toBeDefined();
  });

  it("M41: 503 Cache-Control is NOT 'public, max-age=3600' (anti-regression)", async () => {
    mockResolveSiteForServing.mockResolvedValue({
      id: "manipal-fixture-rm",
      generatedLlmsFullTxt: "",
    });
    const res = await GET(makeRequest("manipal-fixture-rm"), makeContext("manipal-fixture-rm"));
    const cacheControl = res.headers.get("cache-control") ?? "";
    expect(cacheControl).not.toMatch(/public/i);
    expect(cacheControl).not.toMatch(/max-age=3600/);
  });
});
