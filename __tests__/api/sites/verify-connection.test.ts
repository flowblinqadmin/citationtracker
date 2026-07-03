/**
 * ES-082 Phase A — verify-connection 503 branch tests (U42-U44)
 *
 * Author:   ReviewMaster (Agent 9)
 * Date:     2026-04-09
 * Spec:     geo/docs/specs/engineering/ES-082-llms-txt-empty-generation-fix.md (§c.7, §b.7)
 *
 * Tests the new 503 branch that ScriptDev's §b.7 patch adds to the
 * verify-connection POST handler. The branch must be inserted BEFORE the
 * existing 404/429/403/generic branches because the existing if/else if
 * ladder dispatches on result.status order.
 *
 * RED state today (pre-fix):
 *   U42 ✗  RED — 503 from proxy currently falls into the generic "Got HTTP {status}" branch
 *   U43 ✓  pre-fix (404 branch already exists)
 *   U44 ✗  RED — depends on the new 503 branch existing
 *
 * 2 RED → GREEN after ScriptDev's §b.7 patch lands.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Hoisted mocks ───────────────────────────────────────────────────────────

const { mockSelect } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: mockSelect,
  },
}));

vi.mock("@/lib/db/schema", () => ({
  geoSites: {},
}));

// ─── Imports under test ──────────────────────────────────────────────────────

import { POST } from "@/app/api/sites/[id]/verify-connection/route";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ACCESS_TOKEN = "rm-test-access-token";
const SITE_ID = "manipal-fixture-rm";
const DOMAIN = "manipalhospitals.com";

function makeSiteRow() {
  return {
    id: SITE_ID,
    domain: DOMAIN,
    slug: SITE_ID,
    accessToken: ACCESS_TOKEN,
  };
}

function chainableSelect(rows: any[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
    }),
  };
}

function makeRequest(): NextRequest {
  return new NextRequest(
    `https://geo.flowblinq.com/api/sites/${SITE_ID}/verify-connection`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    },
  );
}

function makeContext() {
  return { params: Promise.resolve({ id: SITE_ID }) };
}

/**
 * Mock global fetch so proxyFetch's Tier 1 loop sees a controlled response.
 * The first non-429/non-403 response wins per route.ts:24.
 */
function mockFetchStatus(status: number, body: string = "") {
  return vi.spyOn(global, "fetch").mockResolvedValue(
    new Response(body, {
      status,
      headers: { "content-type": "text/plain" },
    }) as any,
  );
}

beforeEach(() => {
  mockSelect.mockReset();
  mockSelect.mockReturnValue(chainableSelect([makeSiteRow()]));
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
// §c.7 — verify-connection 503 branch (U42-U44)
// ═══════════════════════════════════════════════════════════════════════════

describe("ES-082 §c.7 — POST /api/sites/[id]/verify-connection (RM independent)", () => {
  it("U42: **RED until §b.7 lands** — returns customer-facing 503 message when proxy returns HTTP 503", async () => {
    // Per §b.7 the new branch text:
    //   "Your site is correctly proxying to our serve URL, but our generated
    //    llms.txt file is currently empty for this site. Please re-run the
    //    audit from your dashboard. (We're aware of this and tracking it as
    //    a generation issue, not a setup issue on your end.)"
    //
    // Pre-fix the 503 status falls into the generic "Got HTTP {status}"
    // branch at line 105 because no 503 branch exists yet.
    mockFetchStatus(503, "Generation pending or failed — please re-run the audit from your dashboard.");

    const res = await POST(makeRequest(), makeContext());
    const body = (await res.json()) as { connected: boolean; detail: string };

    expect(body.connected).toBe(false);
    // Two phrase fragments from the §b.7 message text — both must match
    // so a partial-text revert (e.g. removing the "we're aware" parenthetical)
    // would also surface.
    expect(body.detail).toMatch(/correctly proxying/i);
    expect(body.detail).toMatch(/re-run the audit/i);
  });

  it("U43: returns existing 404 message when proxy returns HTTP 404 (regression guard)", async () => {
    mockFetchStatus(404, "Not found");

    const res = await POST(makeRequest(), makeContext());
    const body = (await res.json()) as { connected: boolean; detail: string };

    expect(body.connected).toBe(false);
    expect(body.detail).toMatch(/rewrite rule isn't installed/i);
    // Anti-regression: must NOT use the 503 message text
    expect(body.detail).not.toMatch(/correctly proxying/i);
  });

  it("U44: **RED until §b.7 lands** — 503 branch matched BEFORE the generic 'Got HTTP {status}' fallback", async () => {
    // Order-matters test. Pre-fix, status 503 falls into the generic branch
    // because no 503 case exists in the ladder. Post-fix, the 503 case must
    // come first (or before the generic fallback) so it's matched.
    //
    // We pin two specific anti-fallback phrases: the generic branch uses
    // "Got HTTP" and "Check your rewrite configuration". Neither must
    // appear in the 503 case's response.
    mockFetchStatus(503);

    const res = await POST(makeRequest(), makeContext());
    const body = (await res.json()) as { connected: boolean; detail: string };

    expect(body.detail).not.toMatch(/Got HTTP 503/i);
    expect(body.detail).not.toMatch(/Check your rewrite configuration/i);
    // And positively: the new 503 message must be present
    expect(body.detail).toMatch(/correctly proxying/i);
  });
});
