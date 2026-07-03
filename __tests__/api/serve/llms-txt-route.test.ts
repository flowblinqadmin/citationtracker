/**
 * ES-082 Phase A — serve route /api/serve/[slug]/llms.txt tests (U35-U41)
 *
 * Author:   ReviewMaster (Agent 9)
 * Date:     2026-04-09
 * Spec:     geo/docs/specs/engineering/ES-082-llms-txt-empty-generation-fix.md (§c.5, §b.6)
 *
 * Tests the post-fix three-state discrimination:
 *   - 404  → site not found OR generatedLlmsTxt === null (legacy / never-generated)
 *   - 503  → site exists with generatedLlmsTxt === "" (empty-generation bug)
 *   - 200  → generatedLlmsTxt is non-empty
 *
 * RED state today (pre-fix): the route at line 15 collapses both `!site`
 * and `!site.generatedLlmsTxt` into 404. So:
 *   U35  ✓  pre-fix (200 happy path already works)
 *   U36  ✓  pre-fix (404 when site is null)
 *   U37  ✓  pre-fix (404 when generatedLlmsTxt is null — by accident)
 *   U38  ✗  RED — currently returns 404 for empty string, must return 503
 *   U39  ✗  RED — depends on U38
 *   U40  ✗  RED — depends on U38
 *   U41  ✗  RED — depends on U38
 *
 * 4 RED → GREEN after ScriptDev's serve-route rewrite per §b.6.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Hoisted mocks ───────────────────────────────────────────────────────────

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

// ─── Imports under test ──────────────────────────────────────────────────────

import { GET } from "@/app/api/serve/[slug]/llms.txt/route";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(slug: string): NextRequest {
  return new NextRequest(`https://geo.flowblinq.com/api/serve/${slug}/llms.txt`);
}

function makeContext(slug: string) {
  return { params: Promise.resolve({ slug }) };
}

beforeEach(() => {
  mockResolveSiteForServing.mockReset();
  mockLogCrawl.mockReset();
});

// ═══════════════════════════════════════════════════════════════════════════
// §c.5 — llms.txt route 200 / 404 / 503 discrimination
// ═══════════════════════════════════════════════════════════════════════════

describe("ES-082 §c.5 — GET /api/serve/[slug]/llms.txt (RM independent)", () => {
  it("U35: returns 200 with body when site has non-empty generatedLlmsTxt", async () => {
    const content = "# Test Brand\n\n> Summary line.\n\n## About\nBody.";
    mockResolveSiteForServing.mockResolvedValue({
      id: "manipal-fixture-rm",
      generatedLlmsTxt: content,
    });

    const res = await GET(makeRequest("manipal-fixture-rm"), makeContext("manipal-fixture-rm"));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe(content);
  });

  it("U36: returns 404 when resolveSiteForServing returns null", async () => {
    mockResolveSiteForServing.mockResolvedValue(null);

    const res = await GET(makeRequest("nonexistent-rm"), makeContext("nonexistent-rm"));

    expect(res.status).toBe(404);
    expect(await res.text()).toMatch(/not found/i);
  });

  it("U37: returns 404 when site exists with generatedLlmsTxt === null", async () => {
    mockResolveSiteForServing.mockResolvedValue({
      id: "legacy-fixture-rm",
      generatedLlmsTxt: null,
    });

    const res = await GET(makeRequest("legacy-fixture-rm"), makeContext("legacy-fixture-rm"));

    expect(res.status).toBe(404);
  });

  it("U38: **RED until §b.6 lands** — returns 503 with Retry-After when site exists with generatedLlmsTxt === ''", async () => {
    // Load-bearing post-fix assertion. Pre-fix the route returns 404 for
    // empty-string content (collapsed branch at route.ts:15). Post-fix
    // (§b.6) it returns 503 with Retry-After: 600 and a customer-facing
    // body explaining the regeneration path.
    mockResolveSiteForServing.mockResolvedValue({
      id: "manipal-fixture-rm",
      generatedLlmsTxt: "",
    });

    const res = await GET(makeRequest("manipal-fixture-rm"), makeContext("manipal-fixture-rm"));

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("600");
    expect(await res.text()).toMatch(/please re-run the audit/i);
  });

  it("U39: 503 response sets Cache-Control: no-store (must not be cached by intermediaries)", async () => {
    mockResolveSiteForServing.mockResolvedValue({
      id: "manipal-fixture-rm",
      generatedLlmsTxt: "",
    });

    const res = await GET(makeRequest("manipal-fixture-rm"), makeContext("manipal-fixture-rm"));

    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")?.toLowerCase()).toContain("no-store");
  });

  it("U40: 503 path logs llms_txt_empty crawl type via logCrawl", async () => {
    mockResolveSiteForServing.mockResolvedValue({
      id: "manipal-fixture-rm",
      generatedLlmsTxt: "",
    });

    await GET(makeRequest("manipal-fixture-rm"), makeContext("manipal-fixture-rm"));

    // logCrawl signature: (req, siteId, slug, assetType)
    expect(mockLogCrawl).toHaveBeenCalled();
    const call = mockLogCrawl.mock.calls.find((c) =>
      c.some((arg: unknown) => arg === "llms_txt_empty"),
    );
    expect(call).toBeDefined();
  });

  it("U41: 503 Cache-Control is NOT 'public, max-age=3600' (the 200-path header)", async () => {
    // Anti-regression: a future change that conflates the 503 path with the
    // 200 cache headers would let intermediaries cache the empty-state
    // response and persist customer pain. Pin both directions.
    mockResolveSiteForServing.mockResolvedValue({
      id: "manipal-fixture-rm",
      generatedLlmsTxt: "",
    });

    const res = await GET(makeRequest("manipal-fixture-rm"), makeContext("manipal-fixture-rm"));

    const cacheControl = res.headers.get("cache-control") ?? "";
    expect(cacheControl).not.toMatch(/public/i);
    expect(cacheControl).not.toMatch(/max-age=3600/);
  });
});
