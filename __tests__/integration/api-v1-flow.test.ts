/**
 * Integration Tests — Public API v1 full chain
 *
 * ES-019 Integration Test Plan (I-1 through I-6)
 *
 * Exercises the full POST /api/oauth/token → POST /api/v1/audit → GET /api/v1/audit/{id}
 * chain using real route handlers, real JWT (jose), mocked DB and bcrypt.
 *
 *   I-1  Full OAuth → audit submit → poll flow — all 3 steps succeed with correct shapes
 *   I-2  Free tier gate enforcement — same domain submitted 3× → 3rd returns 402
 *   I-3  Token expiry — expired JWT → GET /api/v1/audit/{id} returns 401
 *   I-4  Revoked client — revoke client, then use JWT → GET audit returns 401
 *        (Note: requires verifyApiToken to check client revokedAt, or route to verify;
 *         the test asserts the expected 401 behaviour per ES-019 spec)
 *   I-5  Scope mismatch — audit:read token attempts POST /api/v1/audit → 403
 *   I-6  MCP round-trip — POST audit, GET audit?format=mcp when complete → valid MCP result
 *
 * NOTE: @/lib/api-auth is NOT mocked — real jose JWT operations are used.
 * jose must be installed: npm install jose
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { SignJWT } from "jose";

// ─── Set env before module loads ──────────────────────────────────────────────
vi.hoisted(() => {
  process.env.API_JWT_SECRET = "cafebabe".repeat(8); // 64 hex chars = 32 bytes
});

// ─── Mocks (DB, bcrypt, qstash — NOT api-auth) ────────────────────────────────

vi.mock("@/lib/db/api-clients", () => ({
  getApiClientByClientId: vi.fn(),
  verifyApiClientSecret: vi.fn(),
  touchApiClientLastUsed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

// bcryptjs: mock to avoid slow hashing in integration tests
vi.mock("bcryptjs", () => {
  const hash = vi.fn().mockResolvedValue("$2b$12$integration-hash");
  const compare = vi.fn().mockResolvedValue(true);
  return { default: { hash, compare }, hash, compare };
});

vi.mock("@/lib/qstash", () => ({
  enqueueStage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/utils", () => ({
  normalizeDomain: vi.fn().mockImplementation((url: string) => {
    try { return new URL(url).hostname; } catch { return url; }
  }),
  slugify: vi.fn().mockReturnValue("example-com"),
}));

vi.mock("nanoid", () => ({
  nanoid: vi.fn().mockReturnValue("integration-site-id"),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    allowed: true, remaining: 9, resetAt: Date.now() + 60_000,
  }),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { POST as postOauthToken } from "@/app/api/oauth/token/route";
import { POST as postAudit } from "@/app/api/v1/audit/route";
import { GET as getAudit } from "@/app/api/v1/audit/[id]/route";
import {
  getApiClientByClientId,
  verifyApiClientSecret,
  touchApiClientLastUsed,
} from "@/lib/db/api-clients";
import { db } from "@/lib/db";
import { signApiToken } from "@/lib/api-auth";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const INTEGRATION_SECRET = "cafebabe".repeat(8);

const TEST_CLIENT = {
  id: "row-1",
  teamId: "team-integration",
  clientId: "integration-client-id",
  clientSecretHash: "$2b$12$integration-hash",
  name: "Integration Test App",
  scopes: ["audit:read", "audit:write", "account:read"],
  lastUsedAt: null,
  revokedAt: null,
  createdAt: new Date(),
};

function makeTokenRequest(body: unknown): Request {
  return new Request("http://localhost/api/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeAuditRequest(body: unknown, bearerToken: string): Request {
  return new Request("http://localhost/api/v1/audit", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${bearerToken}`,
    },
    body: JSON.stringify(body),
  });
}

function makeGetAuditRequest(
  id: string,
  bearerToken: string,
  searchParams?: Record<string, string>
): [Request, { params: Promise<{ id: string }> }] {
  const url = new URL(`http://localhost/api/v1/audit/${id}`);
  if (searchParams) {
    for (const [k, v] of Object.entries(searchParams)) url.searchParams.set(k, v);
  }
  const req = new Request(url.toString(), {
    headers: { authorization: `Bearer ${bearerToken}` },
  });
  return [req, { params: Promise.resolve({ id }) }];
}

function makeSelectChain(rows: unknown[] = []) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
  };
}

function makeInsertChain(row: unknown) {
  const chain = {
    values: vi.fn(),
    returning: vi.fn().mockResolvedValue([row]),
  };
  chain.values.mockReturnValue(chain);
  return chain;
}

const NEW_SITE_PENDING = {
  id: "integration-site-id",
  domain: "example.com",
  teamId: "team-integration",
  pipelineStatus: "pending",
  freeRunNumber: 1,
  freeOptimizationUsed: false,
  crawlLimit: 50,
  apiClientId: "integration-client-id",
};

const COMPLETE_SITE = {
  ...NEW_SITE_PENDING,
  pipelineStatus: "complete",
  slug: "example-com",
  geoScorecard: { overallScore: 78, categories: {} },
  recommendations: [],
  executiveSummary: "Score: 78/100",
  generatedLlmsTxt: "# Example\n...",
  createdAt: new Date(),
  updatedAt: new Date(),
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Integration: Public API v1 full chain", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default active client, bcrypt compare = true
    vi.mocked(getApiClientByClientId).mockResolvedValue(TEST_CLIENT);
    vi.mocked(verifyApiClientSecret).mockResolvedValue(true);
    vi.mocked(touchApiClientLastUsed).mockResolvedValue(undefined);
  });

  it("I-1: full OAuth → audit submit → poll — all 3 steps succeed", async () => {
    // Step 1: Get JWT via POST /api/oauth/token
    const tokenRes = await postOauthToken(
      makeTokenRequest({
        grant_type: "client_credentials",
        client_id: "integration-client-id",
        client_secret: "raw-secret-abc",
      })
    );
    expect(tokenRes.status).toBe(200);
    const tokenBody = await tokenRes.json();
    expect(tokenBody.access_token).toBeDefined();
    expect(tokenBody.token_type).toBe("Bearer");

    const accessToken = tokenBody.access_token;

    // Step 2: POST /api/v1/audit with the real JWT
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(makeSelectChain([]));
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(
      makeInsertChain(NEW_SITE_PENDING)
    );

    const auditRes = await postAudit(
      makeAuditRequest({ url: "https://example.com" }, accessToken)
    );
    expect(auditRes.status).toBe(201);
    const auditBody = await auditRes.json();
    expect(auditBody.audit_id).toBeDefined();
    expect(auditBody.status).toBe("pending");
    expect(auditBody.free_run_number).toBe(1);

    const auditId = auditBody.audit_id;

    // Step 3: GET /api/v1/audit/{id} — poll for result
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([{ ...COMPLETE_SITE, id: auditId }])
    );

    const [getReq, getCtx] = makeGetAuditRequest(auditId, accessToken);
    const getRes = await getAudit(getReq, getCtx);
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.audit_id).toBe(auditId);
    expect(getBody.status).toBe("complete");
    expect(getBody.overall_score).toBe(78);
  });

  it("I-2: free tier gate — same domain submitted 3×, third returns 402", async () => {
    // Get a real JWT first
    const tokenBody = await (
      await postOauthToken(
        makeTokenRequest({
          grant_type: "client_credentials",
          client_id: "integration-client-id",
          client_secret: "secret",
        })
      )
    ).json();
    const token = tokenBody.access_token;

    // First submission: new domain → 201
    (db.select as ReturnType<typeof vi.fn>).mockReturnValueOnce(makeSelectChain([]));
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      makeInsertChain(NEW_SITE_PENDING)
    );
    const res1 = await postAudit(makeAuditRequest({ url: "https://example.com" }, token));
    expect(res1.status).toBe(201);

    // Second submission: domain exists, run=1, pipelineStatus=complete → 409
    (db.select as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      makeSelectChain([
        {
          ...NEW_SITE_PENDING,
          pipelineStatus: "complete",
          freeRunNumber: 1,
          freeOptimizationUsed: false,
        },
      ])
    );
    const res2 = await postAudit(makeAuditRequest({ url: "https://example.com" }, token));
    expect(res2.status).toBe(409);

    // Third submission: domain exhausted (freeRunNumber=2, freeOptimizationUsed=true) → 402
    (db.select as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      makeSelectChain([
        {
          ...NEW_SITE_PENDING,
          pipelineStatus: "complete",
          freeRunNumber: 2,
          freeOptimizationUsed: true,
        },
      ])
    );
    const res3 = await postAudit(makeAuditRequest({ url: "https://example.com" }, token));
    expect(res3.status).toBe(402);
    const body3 = await res3.json();
    expect(body3.error).toBe("free_tier_exhausted");
    expect(body3.credits_purchase_url).toBeDefined();
  });

  it("I-3: expired JWT → GET /api/v1/audit/{id} returns 401", async () => {
    // Manually create an expired token signed with the test secret
    const secret = new TextEncoder().encode(INTEGRATION_SECRET);
    const expiredToken = await new SignJWT({
      sub: "integration-client-id",
      team_id: "team-integration",
      scopes: ["audit:read"],
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(secret);

    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([COMPLETE_SITE])
    );

    const [req, ctx] = makeGetAuditRequest("some-site-id", expiredToken);
    const res = await getAudit(req, ctx);

    expect(res.status).toBe(401);
  });

  it("I-4: revoked client — JWT valid but client is revoked → GET audit returns 401", async () => {
    // First, get a valid JWT from the active client
    const tokenBody = await (
      await postOauthToken(
        makeTokenRequest({
          grant_type: "client_credentials",
          client_id: "integration-client-id",
          client_secret: "secret",
        })
      )
    ).json();
    const token = tokenBody.access_token;

    // Now simulate client being revoked (future DB lookup in verifyApiToken or route)
    // The spec notes verifyApiToken should check revokedAt by looking up the client.
    // This test verifies the 401 outcome regardless of implementation approach.
    vi.mocked(getApiClientByClientId).mockResolvedValue({
      ...TEST_CLIENT,
      revokedAt: new Date(), // revoked NOW
    });

    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([COMPLETE_SITE])
    );

    const [req, ctx] = makeGetAuditRequest("some-site-id", token);
    const res = await getAudit(req, ctx);

    // Per ES-019 spec: revoked client should return 401
    // Implementation note: if verifyApiToken checks revokedAt via DB lookup, this passes.
    // If it's purely stateless JWT, token remains valid until exp. ScriptDev must implement
    // the revokedAt check (see ES-019 Notes #2 for the documented tradeoff).
    expect(res.status).toBe(401);
  });

  it("I-5: audit:read-only token attempts POST /api/v1/audit → 403", async () => {
    // Sign a real JWT with only audit:read scope
    const readOnlyToken = await signApiToken({
      sub: "integration-client-id",
      team_id: "team-integration",
      scopes: ["audit:read"], // no audit:write
    });

    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(makeSelectChain([]));

    const res = await postAudit(
      makeAuditRequest({ url: "https://example.com" }, readOnlyToken)
    );

    expect(res.status).toBe(403);
  });

  it("I-6: MCP round-trip — GET /api/v1/audit/{id}?format=mcp returns valid MCP result", async () => {
    // Get a real JWT
    const tokenBody = await (
      await postOauthToken(
        makeTokenRequest({
          grant_type: "client_credentials",
          client_id: "integration-client-id",
          client_secret: "secret",
        })
      )
    ).json();
    const token = tokenBody.access_token;

    // Simulate completed audit
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([COMPLETE_SITE])
    );

    const [req, ctx] = makeGetAuditRequest(
      "integration-site-id",
      token,
      { format: "mcp" }
    );
    const res = await getAudit(req, ctx);
    expect(res.status).toBe(200);

    const body = await res.json();
    // Valid MCP tool_result shape
    expect(body.type).toBe("tool_result");
    expect(body.tool).toBe("get_audit");
    expect(Array.isArray(body.content)).toBe(true);
    expect(body.content.length).toBeGreaterThan(0);
    expect(body.content[0].type).toBe("text");
  });
});
