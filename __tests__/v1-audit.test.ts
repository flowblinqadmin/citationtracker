/**
 * Unit tests for app/api/v1/audit/route.ts — POST /api/v1/audit
 *
 * ES-019 Unit Test Plan (A-1 through A-9)
 *
 *   A-1  New domain, valid JWT → 201, audit_id, free_run_number=1
 *   A-2  Missing Authorization header → 401
 *   A-3  Invalid/expired JWT → 401
 *   A-4  Token missing audit:write scope → 403
 *   A-5  SSRF url (169.254.169.254) → 400
 *   A-6  Domain exists, freeRunNumber=1, pipelineStatus=complete → 409 with audit_id
 *   A-7  Domain exhausted (freeRunNumber=2, freeOptimizationUsed=true) → 402 with credits_purchase_url
 *   A-8  Domain currently in-progress (pipelineStatus=pending|running) → 200 with existing audit_id
 *   A-9  New domain → inserted row has crawlLimit=50
 *
 * Mocks: @/lib/api-auth, @/lib/db, @/lib/qstash, @/lib/utils, nanoid
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@/lib/api-auth", () => ({
  verifyApiToken: vi.fn(),
  requireScope: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock("@/lib/qstash", () => ({
  enqueueStage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/utils", () => ({
  normalizeDomain: vi.fn().mockImplementation((url: string) => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }),
  slugify: vi.fn().mockReturnValue("example-com"),
}));

vi.mock("nanoid", () => ({
  nanoid: vi.fn().mockReturnValue("new-site-id-nano"),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { POST } from "@/app/api/v1/audit/route";
import { verifyApiToken, requireScope } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { enqueueStage } from "@/lib/qstash";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(
  body: unknown,
  authHeader?: string
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (authHeader !== undefined) {
    headers["authorization"] = authHeader;
  }
  return new Request("http://localhost/api/v1/audit", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const VALID_TOKEN_PAYLOAD = {
  sub: "client-id-xyz",
  team_id: "team-abc",
  scopes: ["audit:read", "audit:write"],
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 3600,
};

function makeSelectChain(rows: unknown[] = []) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
  };
}

function makeInsertChain(returnedRow: unknown = null) {
  const row = returnedRow ?? {
    id: "new-site-id-nano",
    domain: "example.com",
    pipelineStatus: "pending",
    freeRunNumber: 1,
    freeOptimizationUsed: false,
    crawlLimit: 50,
    apiClientId: "client-id-xyz",
  };
  const chain = {
    values: vi.fn(),
    returning: vi.fn().mockResolvedValue([row]),
  };
  chain.values.mockReturnValue(chain);
  return chain;
}

const EXISTING_SITE_RUN1_COMPLETE = {
  id: "existing-site-id-001",
  domain: "example.com",
  teamId: "team-abc",
  pipelineStatus: "complete",
  freeRunNumber: 1,
  freeOptimizationUsed: false,
  crawlLimit: 50,
  apiClientId: "client-id-xyz",
};

const EXISTING_SITE_EXHAUSTED = {
  id: "existing-site-id-002",
  domain: "example.com",
  teamId: "team-abc",
  pipelineStatus: "complete",
  freeRunNumber: 2,
  freeOptimizationUsed: true,
  crawlLimit: 50,
  apiClientId: "client-id-xyz",
};

const EXISTING_SITE_IN_PROGRESS = {
  id: "existing-site-id-003",
  domain: "example.com",
  teamId: "team-abc",
  pipelineStatus: "running",
  freeRunNumber: 1,
  freeOptimizationUsed: false,
  crawlLimit: 50,
  apiClientId: "client-id-xyz",
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("POST /api/v1/audit", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Defaults: valid JWT, write scope, no existing site, insert succeeds
    vi.mocked(verifyApiToken).mockResolvedValue(VALID_TOKEN_PAYLOAD);
    vi.mocked(requireScope).mockReturnValue(undefined);
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(makeSelectChain([]));
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(makeInsertChain());
    vi.mocked(enqueueStage).mockResolvedValue(undefined);
  });

  it("A-1: new domain, valid JWT → 201 with audit_id, status=pending, free_run_number=1", async () => {
    const res = await POST(
      makeRequest({ url: "https://example.com" }, "Bearer valid-token")
    );
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.audit_id).toBeDefined();
    expect(body.status).toBe("pending");
    expect(body.free_run_number).toBe(1);
    expect(body.free_tier).toBe(true);
    expect(typeof body.estimated_completion_seconds).toBe("number");
  });

  it("A-2: missing Authorization header → 401", async () => {
    // No authorization header passed
    const res = await POST(makeRequest({ url: "https://example.com" }));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(vi.mocked(verifyApiToken)).not.toHaveBeenCalled();
  });

  it("A-3: invalid/expired token → 401", async () => {
    vi.mocked(verifyApiToken).mockRejectedValue(
      Object.assign(new Error("JWTExpired"), { code: "ERR_JWT_EXPIRED" })
    );

    const res = await POST(
      makeRequest({ url: "https://example.com" }, "Bearer expired-token")
    );
    const body = await res.json();

    expect(res.status).toBe(401);
  });

  it("A-4: token missing audit:write scope → 403", async () => {
    vi.mocked(requireScope).mockImplementation(() => {
      throw Object.assign(new Error("Insufficient scope: audit:write required"), {
        status: 403,
      });
    });

    const res = await POST(
      makeRequest({ url: "https://example.com" }, "Bearer read-only-token")
    );
    const body = await res.json();

    expect(res.status).toBe(403);
  });

  it("A-5: SSRF url (link-local 169.254.x.x) → 400", async () => {
    const res = await POST(
      makeRequest(
        { url: "http://169.254.169.254/latest/meta-data/" },
        "Bearer valid-token"
      )
    );
    const body = await res.json();

    expect(res.status).toBe(400);
  });

  it("A-5b: SSRF url (localhost) → 400", async () => {
    const res = await POST(
      makeRequest({ url: "http://localhost/admin" }, "Bearer valid-token")
    );
    const body = await res.json();

    expect(res.status).toBe(400);
  });

  it("A-6: domain exists, freeRunNumber=1, pipelineStatus=complete → 409 with audit_id", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([EXISTING_SITE_RUN1_COMPLETE])
    );

    const res = await POST(
      makeRequest({ url: "https://example.com" }, "Bearer valid-token")
    );
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("audit_exists");
    expect(body.audit_id).toBe("existing-site-id-001");
    expect(typeof body.message).toBe("string");
  });

  it("A-7: domain exhausted (freeRunNumber=2, freeOptimizationUsed=true) → 402 with credits_purchase_url", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([EXISTING_SITE_EXHAUSTED])
    );

    const res = await POST(
      makeRequest({ url: "https://example.com" }, "Bearer valid-token")
    );
    const body = await res.json();

    expect(res.status).toBe(402);
    expect(body.error).toBe("free_tier_exhausted");
    expect(typeof body.credits_purchase_url).toBe("string");
    expect(body.credits_purchase_url).toContain("flowblinq.com");
  });

  it("A-8: domain in-progress (pipelineStatus=running) → 200 with existing audit_id", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([EXISTING_SITE_IN_PROGRESS])
    );

    const res = await POST(
      makeRequest({ url: "https://example.com" }, "Bearer valid-token")
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.audit_id).toBe("existing-site-id-003");
    // Should return current status, not re-enqueue
    expect(vi.mocked(enqueueStage)).not.toHaveBeenCalled();
  });

  it("A-8b: domain in-progress (pipelineStatus=pending) → 200 with existing audit_id", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([{ ...EXISTING_SITE_IN_PROGRESS, pipelineStatus: "pending" }])
    );

    const res = await POST(
      makeRequest({ url: "https://example.com" }, "Bearer valid-token")
    );

    expect(res.status).toBe(200);
  });

  it("A-9: new domain → inserted row has crawlLimit=50 and apiClientId set", async () => {
    const capturedValues: Record<string, unknown>[] = [];
    const insertChain = {
      values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
        capturedValues.push(vals);
        return insertChain;
      }),
      returning: vi.fn().mockResolvedValue([
        {
          id: "new-site-id-nano",
          domain: "example.com",
          pipelineStatus: "pending",
          freeRunNumber: 1,
          freeOptimizationUsed: false,
          crawlLimit: 50,
          apiClientId: "client-id-xyz",
        },
      ]),
    };
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(insertChain);

    await POST(
      makeRequest({ url: "https://example.com" }, "Bearer valid-token")
    );

    expect(capturedValues.length).toBeGreaterThan(0);
    const insertedRow = capturedValues[0];
    expect(insertedRow.crawlLimit).toBe(50);
    expect(insertedRow.apiClientId).toBe("client-id-xyz");
    expect(insertedRow.freeRunNumber).toBe(1);
    expect(insertedRow.freeOptimizationUsed).toBe(false);
  });

  it("A-9b: enqueueStage is called once for new domain submission", async () => {
    await POST(
      makeRequest({ url: "https://example.com" }, "Bearer valid-token")
    );

    expect(vi.mocked(enqueueStage)).toHaveBeenCalledTimes(1);
  });
});
