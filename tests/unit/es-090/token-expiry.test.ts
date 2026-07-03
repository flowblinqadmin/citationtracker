/**
 * ES-090 CRIT-1 — Token expiry + rotation (U1-U7).
 *
 * Phase A (RED): main @ 70645cba schema lacks `tokenExpiresAt` / `tokenRotatedAt`
 * columns; all 4 enforcement sites only equality-check the token.
 *
 * Spec refs: ES-090 §b.1, §b.2.
 *
 * Mocks the DB at the call-shape level — these tests verify the route handlers
 * inspect `tokenExpiresAt` after the equality check and return
 * `{ code: "TOKEN_EXPIRED" }` on 401.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { TOKEN_TTL_MS } from "@/lib/constants/token-ttl";

interface FakeSite {
  id: string;
  accessToken: string;
  tokenExpiresAt: Date | null;
  tokenRotatedAt: Date | null;
  teamId?: string | null;
  geoScorecard?: unknown;
  // Verify route (rotateIfExpired path):
  emailVerified?: boolean;
  userId?: string | null;
  ownerEmail?: string;
  // HP-237 OTP gate — verify route now requires a pending OTP even on the
  // already-emailVerified re-login branch (assertOtpGate runs first).
  verificationCode?: string | null;
  codeExpiresAt?: Date | null;
  // Regenerate route:
  auditMode?: string | null;
  pipelineStatus?: string | null;
  domain?: string;
}

const { state, dbMock } = vi.hoisted(() => {
  const state: { site: FakeSite | null; teamCredits: number } = {
    site: null,
    teamCredits: 100,
  };
  const dbMock = {
    select: vi.fn((_proj?: unknown) => ({
      from: vi.fn((tbl: { __name?: string }) => ({
        where: vi.fn(async () => {
          if (tbl?.__name === "teams") return [{ id: "t1", creditBalance: state.teamCredits }];
          if (tbl?.__name === "consent_records") return [];
          if (tbl?.__name === "team_members") return [];
          if (tbl?.__name === "team_domains") return [];
          return state.site ? [state.site] : [];
        }),
      })),
    })),
    // Default update chain supports both the legacy `.set().where()` AND
     // HP-236's atomic `.set().where().returning()` shape. .where() returns
     // an object that is both awaitable (Promise<undefined>) AND has a
     // .returning() method (returns an array so destructuring `const
     // [rotated] = await ...` yields undefined in the default branch).
    update: vi.fn(() => ({
      set: vi.fn(() => {
        const whereResult = {
          returning: vi.fn(async () => [] as Array<{ accessToken?: string }>),
          then: (resolve: (v: undefined) => void) => { resolve(undefined); return Promise.resolve(undefined); },
        };
        return { where: vi.fn(() => whereResult) };
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((_v: unknown) => ({
        onConflictDoNothing: vi.fn(async () => undefined),
        then: (resolve: (v: undefined) => void) => { resolve(undefined); return Promise.resolve(undefined); },
      })),
    })),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(dbMock)),
  };
  return { state, dbMock };
});

vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/db/schema", () => ({
  geoSites:    { __name: "geo_sites", id: "id", accessToken: "access_token", tokenExpiresAt: "token_expires_at" },
  geoSiteView: { __name: "geo_site_view", siteId: "site_id", accessToken: "access_token", tokenExpiresAt: "token_expires_at" },
  teams:       { __name: "teams", id: "id", creditBalance: "credit_balance" },
  teamMembers: { __name: "team_members" },
  teamDomains: { __name: "team_domains" },
  creditTransactions: { __name: "credit_transactions" },
  consentRecords: { __name: "consent_records", id: "id", userId: "user_id", tosVersion: "tos_version", eulaVersion: "eula_version" },
  citationCheckResponses: {},
  citationCheckScores: {},
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => args),
  sql: (s: TemplateStringsArray) => s.join(""),
  gte: vi.fn(), and: vi.fn(), isNull: vi.fn(),
  // HP-236 atomic rotateIfExpired uses and/or/isNull/lt against tokenExpiresAt.
  or: vi.fn((...args: unknown[]) => args),
  lt: vi.fn((...args: unknown[]) => args),
}));

vi.mock("@/lib/qstash", () => ({ enqueueStage: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: vi.fn(() => null) }));
vi.mock("@/lib/services/provision-team", () => ({ ensureTeamForUser: vi.fn(async () => ({ teamId: "t1", userId: "u1" })) }));
vi.mock("@/lib/services/exchange-code", () => ({ generateExchangeCode: vi.fn(async () => "exchange-code-stub") }));
vi.mock("@/lib/email", () => ({
  // lib/email.verifyCode is SYNC in prod — mock must match signature.
  verifyCode: vi.fn((_code: string, _hash: string) => true),
  sendVerificationEmail: vi.fn(async () => undefined),
}));
vi.mock("@/lib/rate-limit", () => ({
  // HP-239 split primitives — verify route now imports these by name.
  checkOtpLock: vi.fn(async () => ({ allowed: true as boolean, lockedUntil: null as Date | null })),
  incrementOtpAttempt: vi.fn(async () => ({ lockedOut: false })),
  // Legacy wrapper kept for any lingering callers.
  checkAndIncrementOtpAttempt: vi.fn(async () => ({ allowed: true, attemptsLeft: 5 })),
  clearOtpAttempts: vi.fn(async () => undefined),
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 100, reset: Date.now() + 60_000 })),
}));
vi.mock("@/lib/services/citation-prompt-generator", () => ({ generatePrompts: vi.fn(), extractTopCityNames: vi.fn() }));
vi.mock("@/lib/services/citation-checker", () => ({ runCitationCheck: vi.fn(), aggregateByDimension: vi.fn(), aggregateCompetitorsByDimension: vi.fn(), generateDominanceInsights: vi.fn() }));
vi.mock("@/lib/services/real-prompt-discoverer", () => ({ discoverRealPrompts: vi.fn() }));
vi.mock("@/lib/services/crawl-coverage-validator", () => ({ validateCrawlCoverage: vi.fn() }));
vi.mock("@/lib/services/engine-preference-analyzer", () => ({ analyzeEnginePreferences: vi.fn() }));
vi.mock("@/lib/services/tree-extractor", () => ({ extractTrees: vi.fn() }));
vi.mock("@/lib/services/brand-detector", () => ({ extractBrandKeywords: vi.fn() }));
vi.mock("@/lib/services/category-extractor", () => ({ extractCategoriesViaHaiku: vi.fn() }));
vi.mock("@/lib/services/competitor-discovery", () => ({ discoverCompetitors: vi.fn() }));

// Default update-chain factory — kept out of vi.hoisted so beforeEach can
// fully reset `dbMock.update`'s implementation each test (clears any lingering
// mockImplementationOnce queued by a prior test that threw before consuming it).
function defaultUpdateImpl(): { set: (patch: unknown) => { where: (cond: unknown) => { returning: () => Promise<Array<{ accessToken?: string }>>; then: (resolve: (v: undefined) => void) => Promise<undefined> } } } {
  return {
    set: () => {
      const whereResult = {
        returning: async () => [] as Array<{ accessToken?: string }>,
        then: (resolve: (v: undefined) => void) => { resolve(undefined); return Promise.resolve(undefined); },
      };
      return { where: () => whereResult };
    },
  };
}

beforeEach(() => {
  state.site = null;
  state.teamCredits = 100;
  dbMock.select.mockClear();
  // mockReset() clears BOTH call history and implementations (including any
  // leftover mockImplementationOnce from a prior test that threw). We then
  // reinstate the default chain so routes that aren't spied-on still work.
  dbMock.update.mockReset();
  dbMock.update.mockImplementation(defaultUpdateImpl);
  dbMock.insert.mockClear();
});

function makeReq(token: string): NextRequest {
  return new NextRequest(`https://geo.flowblinq.com/api/sites/x?token=${token}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

function makePostReq(path: string, body: unknown, token?: string): NextRequest {
  const url = token
    ? `https://geo.flowblinq.com${path}?token=${token}`
    : `https://geo.flowblinq.com${path}`;
  return new NextRequest(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

const FUTURE = new Date(Date.now() + 86_400_000);
const PAST = new Date(Date.now() - 1000);

describe("ES-090 CRIT-1 — token expiry on the 4 gated routes", () => {
  it("U3: GET /api/sites/[id] returns 401 with code:TOKEN_EXPIRED when expired", async () => {
    state.site = { id: "x", accessToken: "tok", tokenExpiresAt: PAST, tokenRotatedAt: PAST, teamId: null };
    const { GET } = await import("@/app/api/sites/[id]/route?u3");
    const res = await GET(makeReq("tok"), { params: Promise.resolve({ id: "x" }) });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("TOKEN_EXPIRED");
  });

  it("U4: POST /api/sites/[id]/citation-check returns 401 when expired AND does not deduct credit", async () => {
    state.site = { id: "x", accessToken: "tok", tokenExpiresAt: PAST, tokenRotatedAt: PAST, teamId: "t1", geoScorecard: { foo: 1 } };
    const { POST } = await import("@/app/api/sites/[id]/citation-check/route?u4");
    const res = await POST(makeReq("tok"), { params: Promise.resolve({ id: "x" }) });
    expect(res.status).toBe(401);
    expect(dbMock.insert).not.toHaveBeenCalled(); // no creditTransactions row
  });

  it("U5: POST /api/sites/[id]/competitor-discovery returns 401 when expired", async () => {
    state.site = { id: "x", accessToken: "tok", tokenExpiresAt: PAST, tokenRotatedAt: PAST, teamId: "t1" };
    const { POST } = await import("@/app/api/sites/[id]/competitor-discovery/route?u5");
    const res = await POST(makeReq("tok"), { params: Promise.resolve({ id: "x" }) });
    expect(res.status).toBe(401);
  });

  it("U6: POST /api/sites/[id]/regenerate returns 401 when expired", async () => {
    state.site = { id: "x", accessToken: "tok", tokenExpiresAt: PAST, tokenRotatedAt: PAST };
    const { POST } = await import("@/app/api/sites/[id]/regenerate/route?u6");
    const res = await POST(makeReq("tok"), { params: Promise.resolve({ id: "x" }) });
    expect(res.status).toBe(401);
  });

  it("U7 (INVERTED per HP-197): null tokenExpiresAt is treated as EXPIRED (fails closed)", async () => {
    // Amendment: HP-197 requires fail-closed semantics on NULL. Combined with
    // §b.1 NOT NULL DEFAULT NOW()+90d, NULL should never occur in a healthy row
    // — but if a writer forgets to populate, code treats NULL as expired (401)
    // rather than valid (old behavior).
    state.site = { id: "x", accessToken: "tok", tokenExpiresAt: null, tokenRotatedAt: null, teamId: null };
    const { GET } = await import("@/app/api/sites/[id]/route?u7");
    const res = await GET(makeReq("tok"), { params: Promise.resolve({ id: "x" }) });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("TOKEN_EXPIRED");
  });

  it("U1 (HP-213 Track A): verify route writes tokenExpiresAt ≈ now + 90d via rotateIfExpired", async () => {
    // HP-227 Track B removed the __test_buildVerifyTokenPatch export. HP-213
    // Track A rewrite: drive POST down the HP-224 rotateIfExpired path
    // (emailVerified + userId + !hasConsent + !tosAccepted + PAST expiry) and
    // capture the first `db.update().set()` patch via mockImplementationOnce.
    //
    // HP-236 added `.returning()` to the atomic conditional-UPDATE chain —
    // the mock must return a truthy `rotated` row so rotateIfExpired takes
    // the happy path and returns the new token (rather than the re-SELECT
    // fallback which wouldn't fire on the first winner).
    let capturedPatch: Record<string, unknown> | null = null;
    dbMock.update.mockImplementationOnce(() => ({
      set: vi.fn((patch: Record<string, unknown>) => {
        capturedPatch = patch;
        return {
          where: vi.fn(() => ({
            returning: async () => [{ accessToken: patch.accessToken as string }],
            then: (resolve: (v: undefined) => void) => { resolve(undefined); return Promise.resolve(undefined); },
          })),
        };
      }),
    }));
    state.site = {
      id: "x",
      accessToken: "old-token",
      tokenExpiresAt: PAST,
      tokenRotatedAt: null,
      teamId: null,
      // Fields read by verify route's rotateIfExpired branch:
      emailVerified: true,
      userId: "u1",
      ownerEmail: "u1@example.test",
      // HP-237 OTP gate prerequisites — without a pending OTP the gate 401s
      // before we ever reach rotateIfExpired. verifyCode() is mocked to
      // always return true, so any `code` param passes the constant-time
      // compare step.
      verificationCode: "hash-of-valid-otp",
      codeExpiresAt: FUTURE,
    } as FakeSite & Record<string, unknown>;

    const { POST } = await import("@/app/api/sites/[id]/verify/route?u1");
    const res = await POST(
      makePostReq("/api/sites/x/verify", { code: "123456", tosAccepted: false }),
      { params: Promise.resolve({ id: "x" }) },
    );
    expect(res.status, "verify POST should return 200 on rotateIfExpired path").toBe(200);

    expect(capturedPatch, "verify rotateIfExpired must call db.update(geoSites).set(...)").not.toBeNull();
    expect(capturedPatch!.accessToken, "rotation patch includes new accessToken").toEqual(expect.any(String));
    expect((capturedPatch!.accessToken as string).length).toBeGreaterThanOrEqual(32);

    const expiresAt = capturedPatch!.tokenExpiresAt;
    expect(expiresAt, "rotation patch includes tokenExpiresAt").toBeInstanceOf(Date);
    const expected = Date.now() + TOKEN_TTL_MS;
    expect(Math.abs((expiresAt as Date).getTime() - expected)).toBeLessThan(5_000);
    expect(capturedPatch!.tokenRotatedAt, "rotation patch includes tokenRotatedAt").toBeInstanceOf(Date);
  });

  it("U2 (HP-213 Track A): regenerate rotates token + refreshes expiry + sets tokenRotatedAt ≈ now", async () => {
    // HP-227 Track B removed the __test_buildRegeneratePatch export. HP-213
    // Track A rewrite: drive POST down the free-path branch (teamId=null,
    // pipelineStatus not running/complete, FUTURE expiry) and capture the
    // single `db.update().set()` patch via mockImplementationOnce.
    let capturedPatch: Record<string, unknown> | null = null;
    dbMock.update.mockImplementationOnce(() => ({
      set: vi.fn((patch: Record<string, unknown>) => {
        capturedPatch = patch;
        return {
          where: vi.fn(() => ({
            returning: async () => [] as Array<{ accessToken?: string }>,
            then: (resolve: (v: undefined) => void) => { resolve(undefined); return Promise.resolve(undefined); },
          })),
        };
      }),
    }));
    state.site = {
      id: "x",
      accessToken: "tok",
      tokenExpiresAt: FUTURE,
      tokenRotatedAt: null,
      teamId: null,
      // Fields read by regenerate route:
      auditMode: null,
      pipelineStatus: "failed",
      domain: "example.test",
    } as FakeSite & Record<string, unknown>;

    const { POST } = await import("@/app/api/sites/[id]/regenerate/route?u2");
    const res = await POST(makeReq("tok"), { params: Promise.resolve({ id: "x" }) });
    expect(res.status, "regenerate POST free path should return 202").toBe(202);

    expect(capturedPatch, "regenerate must call db.update(geoSites).set(...)").not.toBeNull();
    expect(capturedPatch!.accessToken, "rotation patch includes new accessToken").toEqual(expect.any(String));
    expect((capturedPatch!.accessToken as string).length).toBeGreaterThanOrEqual(32);
    expect(capturedPatch!.accessToken).not.toBe("tok");

    const expiresAt = capturedPatch!.tokenExpiresAt;
    expect(expiresAt, "rotation patch includes tokenExpiresAt").toBeInstanceOf(Date);
    expect(Math.abs((expiresAt as Date).getTime() - (Date.now() + TOKEN_TTL_MS))).toBeLessThan(5_000);
    expect(capturedPatch!.tokenRotatedAt, "rotation patch includes tokenRotatedAt").toBeInstanceOf(Date);
  });
});
