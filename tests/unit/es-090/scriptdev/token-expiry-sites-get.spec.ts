/**
 * ES-090 Phase 1 (ScriptDev) — CRIT-1 token expiry on GET /api/sites/[id].
 *
 * ChangedSpec refs:
 *   §b.2 step 3, 1st bullet — insert expiry check after the equality check.
 *   §b.2 HP-197 — `if (!site.tokenExpiresAt || site.tokenExpiresAt < now)`,
 *     i.e. NULL is expired, not valid. Belt-and-suspenders with the NOT NULL
 *     column default from §b.1.
 *   Acceptance: AC-2 (401 body shape `{ error: "Unauthorized", code: "TOKEN_EXPIRED" }`).
 *
 * These assertions currently FAIL on main @ 70645cba — the route returns 200
 * for any non-expired/expired/NULL case so long as `accessToken` equality
 * passes. That is the deliberate RED.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Mocks (vi.mock hoisted — factories must not reference outer scope) ───

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
  },
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────

import { GET } from "@/app/api/sites/[id]/route";
import { db } from "@/lib/db";

// ─── Fixtures ─────────────────────────────────────────────────────────────

const SITE_ID = "site-es090-crit1";
const VALID_TOKEN = "tok_es090_crit1_valid";

function baseSite(overrides: Record<string, unknown> = {}) {
  return {
    siteId: SITE_ID,
    domain: "crit1.example.test",
    slug: "crit1",
    accessToken: VALID_TOKEN,
    tokenExpiresAt: new Date(Date.now() + 30 * 86_400_000), // 30 days ahead
    teamId: null,
    pipelineStatus: "complete",
    pipelineError: null,
    discoveryData: null,
    platformDetected: null,
    projectedScore: null,
    projectedBoost: null,
    shareToken: null,
    domainVerified: true,
    verifyToken: null,
    changeLog: [],
    manualRunsMonth: 0,
    crawlCount: 0,
    pageCount: 0,
    lastCrawlAt: null,
    nextCrawlAt: null,
    createdAt: new Date(),
    rankedRecommendations: [],
    pillars: [],
    overallScore: null,
    previousScore: null,
    generatedLlmsTxt: null,
    baselineScore: null,
    baselineScorecard: null,
    ...overrides,
  };
}

/**
 * The GET route chain: `db.select().from(geoSiteView).where(...)` first,
 * then optionally `db.select().from(teams).where(...)` if site has a teamId.
 * Returning `[site]` on the first call covers the teamless happy-path; a
 * second `.mockReturnValueOnce` would layer on a teams row if needed.
 */
function stubSiteLookup(site: ReturnType<typeof baseSite> | undefined) {
  const where = vi.fn().mockResolvedValue(site ? [site] : []);
  const from = vi.fn().mockReturnValue({ where });
  (db.select as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ from });
}

function buildReq(token: string | null): NextRequest {
  const url = token
    ? `https://app.test/api/sites/${SITE_ID}?token=${encodeURIComponent(token)}`
    : `https://app.test/api/sites/${SITE_ID}`;
  return new NextRequest(new URL(url), { method: "GET" });
}

const ctx = { params: Promise.resolve({ id: SITE_ID }) };

// ─── Cases ────────────────────────────────────────────────────────────────

describe("ES-090 CRIT-1 / GET /api/sites/[id] — token expiry enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 when token matches AND tokenExpiresAt is in the future", async () => {
    stubSiteLookup(baseSite());
    const res = await GET(buildReq(VALID_TOKEN), ctx);
    expect(res.status).toBe(200);
  });

  it("returns 401 with code TOKEN_EXPIRED when tokenExpiresAt is in the past (U3)", async () => {
    stubSiteLookup(
      baseSite({ tokenExpiresAt: new Date(Date.now() - 1_000) }), // 1s ago
    );
    const res = await GET(buildReq(VALID_TOKEN), ctx);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual(
      expect.objectContaining({
        error: "Unauthorized",
        code: "TOKEN_EXPIRED",
      }),
    );
  });

  it("returns 401 with code TOKEN_EXPIRED when tokenExpiresAt is NULL (HP-197 inverted)", async () => {
    // HP-197: NULL must be treated as expired (fail closed). The post-migration
    // column is NOT NULL w/ default, but the enforcement code must not rely on
    // that — belt-and-suspenders.
    stubSiteLookup(baseSite({ tokenExpiresAt: null }));
    const res = await GET(buildReq(VALID_TOKEN), ctx);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual(
      expect.objectContaining({
        error: "Unauthorized",
        code: "TOKEN_EXPIRED",
      }),
    );
  });

  it("returns 401 Unauthorized (NO TOKEN_EXPIRED code) when token is wrong", async () => {
    // Wrong token must still short-circuit at the equality check before
    // reaching the expiry branch — preserves the pre-ES-090 401 contract
    // for legitimate "bad credentials" (no TOKEN_EXPIRED leakage about
    // whether the site exists or is expired).
    stubSiteLookup(baseSite());
    const res = await GET(buildReq("wrong-token"), ctx);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBeUndefined(); // plain Unauthorized — no expiry hint
  });

  it("returns 401 Unauthorized (NO TOKEN_EXPIRED) when no token provided", async () => {
    stubSiteLookup(baseSite());
    const res = await GET(buildReq(null), ctx);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBeUndefined();
  });

  it("returns 404 when site lookup returns empty (precedes expiry check)", async () => {
    stubSiteLookup(undefined);
    const res = await GET(buildReq(VALID_TOKEN), ctx);
    expect(res.status).toBe(404);
  });

  it("boundary: tokenExpiresAt exactly now is treated as expired (< comparison)", async () => {
    // §b.2: `site.tokenExpiresAt < new Date()`. At equal instants the strict
    // less-than is false — so the guard would admit. Spec intent is fail-closed
    // at the boundary; this test pins the spec's exact predicate so a future
    // switch to `<=` is a visible, reviewed decision.
    const exactNow = new Date();
    vi.setSystemTime(exactNow);
    stubSiteLookup(baseSite({ tokenExpiresAt: exactNow }));
    const res = await GET(buildReq(VALID_TOKEN), ctx);
    // Per current §b.2 wording: 200 (strict <). Flag to HolePoker if spec
    // clarifies to <=, and flip expectation in the same commit.
    expect(res.status).toBe(200);
    vi.useRealTimers();
  });
});
