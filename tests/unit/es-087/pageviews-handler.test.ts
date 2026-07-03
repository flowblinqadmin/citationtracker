/**
 * ES-087 — /api/v1/page_views handler unit tests
 *
 * Handler-level tests with mocked db + mocked auth. Branches that cannot be
 * meaningfully unit-tested without a real DB chain (has_more cursor math,
 * response shape) are asserted end-to-end in the integration suite.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Chainable DB mock ────────────────────────────────────────────────────────
// Drizzle's query builder returns a chain that is ultimately awaited. We
// queue the final resolved values per invocation and have every intermediate
// method return the same proxy until awaited.
const dbReturnQueue: unknown[] = [];
function dbQueueNext(value: unknown) { dbReturnQueue.push(value); }

function makeChainable(): any {
  let resolvedValue: unknown = undefined;
  let hasShifted = false;
  const chain: any = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then" || prop === "catch" || prop === "finally") {
        if (!hasShifted) {
          resolvedValue = dbReturnQueue.shift() ?? [];
          hasShifted = true;
        }
        const p = Promise.resolve(resolvedValue);
        return (p as any)[prop].bind(p);
      }
      return () => chain;
    },
  });
  return chain;
}

vi.mock("@/lib/db", () => ({
  db: {
    select: () => makeChainable(),
    update: () => makeChainable(),
    query: vi.fn(),
  },
}));

vi.mock("@/lib/api-auth", () => ({
  verifyApiToken: vi.fn(),
  requireScope: (scopes: string[], required: string) => {
    if (!scopes.includes(required)) {
      const e: any = new Error("Insufficient scope");
      e.status = 403;
      throw e;
    }
  },
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
}));

// Avoid the schema module's SIGNUP_BONUS_CREDITS env dependency at import time.
vi.mock("@/lib/config", () => ({
  SIGNUP_BONUS_CREDITS: 100,
  FREE_MAX_PAGES: 10,
}));

import { GET } from "@/app/api/v1/page_views/route";
import { verifyApiToken } from "@/lib/api-auth";
import { checkRateLimit } from "@/lib/rate-limit";

function makeReq(params: Record<string, string>, headers: Record<string, string> = {}) {
  const url = new URL("https://geo.flowblinq.com/api/v1/page_views");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url, {
    method: "GET",
    headers: { authorization: "Bearer test.jwt.token", ...headers },
  }) as any;
}

function mockValidToken(overrides: Partial<{ team_id: string; sub: string; scopes: string[] }> = {}) {
  (verifyApiToken as any).mockResolvedValue({
    sub: "client-abc",
    team_id: "team-A",
    scopes: ["pageviews:read"],
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  });
}

function mockRateLimitOk() {
  (checkRateLimit as any).mockResolvedValue({ allowed: true, remaining: 119, resetAt: Date.now() + 3600_000 });
}

function mockRateLimitExhausted(retryAfterS = 30) {
  (checkRateLimit as any).mockResolvedValue({ allowed: false, remaining: 0, resetAt: Date.now() + retryAfterS * 1000 });
}

// Happy-path api_client row (non-revoked, non-blocked, zero counter).
function queueValidApiClient() {
  dbQueueNext([{
    id: "acid-1",
    clientId: "client-abc",
    teamId: "team-A",
    revokedAt: null,
    blockedAt: null,
    consecutiveBadRequests: 0,
  }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  dbReturnQueue.length = 0;
  mockRateLimitOk();
});

describe("rate-limit gate (TS-087 #7)", () => {
  it("returns 429 with Retry-After when bucket exhausted", async () => {
    mockValidToken();
    mockRateLimitExhausted(30);
    const res = await GET(makeReq({ domain: "x.com" }));
    expect(res.status).toBe(429);
    const retryAfter = Number(res.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThanOrEqual(29);
    expect(retryAfter).toBeLessThanOrEqual(31);
    expect((await res.json()).error).toBe("rate_limit_exceeded");
    // Rate-limit runs AFTER JWT verify — the bucket key is token.sub (client_id),
    // which is only trustworthy post-signature-verification. Verifying before
    // rate-limiting prevents attackers forging unsigned JWTs to grief a legit
    // client_id's quota.
    expect(verifyApiToken).toHaveBeenCalled();
  });
});

describe("auth (TS-087 #4, #5, #6)", () => {
  it("returns 401 missing_token when authorization header absent", async () => {
    const res = await GET(makeReq({ domain: "x.com" }, { authorization: "" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("missing_token");
  });

  it("returns 401 missing_token when header is not a Bearer scheme", async () => {
    const res = await GET(makeReq({ domain: "x.com" }, { authorization: "Basic abc" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("missing_token");
  });

  it("returns 401 token_expired when verifyApiToken throws ERR_JWT_EXPIRED", async () => {
    const err: any = new Error("token_expired");
    err.code = "ERR_JWT_EXPIRED";
    (verifyApiToken as any).mockRejectedValue(err);
    const res = await GET(makeReq({ domain: "x.com" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("token_expired");
  });

  it("returns 401 malformed_token on generic verify failure", async () => {
    (verifyApiToken as any).mockRejectedValue(new Error("bad sig"));
    const res = await GET(makeReq({ domain: "x.com" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("malformed_token");
  });

  it("returns 401 client_revoked when row has revokedAt set", async () => {
    mockValidToken();
    dbQueueNext([{ id: "acid-1", clientId: "client-abc", teamId: "team-A",
      revokedAt: new Date(), blockedAt: null, consecutiveBadRequests: 0 }]);
    const res = await GET(makeReq({ domain: "x.com" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("client_revoked");
  });

  it("returns 401 client_blocked when row has blockedAt set", async () => {
    mockValidToken();
    dbQueueNext([{ id: "acid-1", clientId: "client-abc", teamId: "team-A",
      revokedAt: null, blockedAt: new Date(), consecutiveBadRequests: 21 }]);
    const res = await GET(makeReq({ domain: "x.com" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("client_blocked");
  });

  it("returns 401 client_revoked when api_clients row missing entirely", async () => {
    mockValidToken();
    dbQueueNext([]);
    const res = await GET(makeReq({ domain: "x.com" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("client_revoked");
  });
});

describe("scope (TS-087 #2)", () => {
  it("returns 403 insufficient_scope when token lacks pageviews:read", async () => {
    mockValidToken({ scopes: ["account:read"] });
    queueValidApiClient();
    const res = await GET(makeReq({ domain: "x.com" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("insufficient_scope");
  });
});

describe("param validation (TS-087 #3, #13, #15)", () => {
  beforeEach(() => {
    mockValidToken();
  });

  it("returns 400 missing_domain when query param absent", async () => {
    queueValidApiClient();
    dbQueueNext([{ consecutive: 1, blockedAt: null }]); // recordBad() return
    const res = await GET(makeReq({}));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("missing_domain");
  });

  it("returns 400 conflicting_params when both cursor and since supplied", async () => {
    queueValidApiClient();
    dbQueueNext([{ consecutive: 1, blockedAt: null }]);
    const res = await GET(makeReq({ domain: "x.com", cursor: "abc", since: "2026-04-21T00:00:00Z" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("conflicting_params");
  });

  it("returns 400 bad_since on malformed since", async () => {
    queueValidApiClient();
    dbQueueNext([{ consecutive: 1, blockedAt: null }]);
    const res = await GET(makeReq({ domain: "x.com", since: "not-a-date" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_since");
  });

  it("returns 400 bad_cursor on malformed cursor", async () => {
    queueValidApiClient();
    dbQueueNext([{ consecutive: 1, blockedAt: null }]);
    const res = await GET(makeReq({ domain: "x.com", cursor: "!!!invalid!!!" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_cursor");
  });

  it("returns 400 bad_limit when limit < 1", async () => {
    queueValidApiClient();
    dbQueueNext([{ consecutive: 1, blockedAt: null }]);
    const res = await GET(makeReq({ domain: "x.com", limit: "0" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_limit");
  });

  it("returns 400 bad_limit when limit > 1000", async () => {
    queueValidApiClient();
    dbQueueNext([{ consecutive: 1, blockedAt: null }]);
    const res = await GET(makeReq({ domain: "x.com", limit: "5000" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_limit");
  });

  it("returns 400 bad_limit when limit is non-numeric", async () => {
    queueValidApiClient();
    dbQueueNext([{ consecutive: 1, blockedAt: null }]);
    const res = await GET(makeReq({ domain: "x.com", limit: "abc" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_limit");
  });
});

describe("domain ownership (TS-087 #3, #9)", () => {
  it("returns 404 domain_not_found when team does not own domain", async () => {
    mockValidToken();
    queueValidApiClient();
    dbQueueNext([]); // geoSites lookup → empty
    const res = await GET(makeReq({ domain: "not-my-domain.com" }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("domain_not_found");
  });
});
