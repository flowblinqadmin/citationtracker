/**
 * Unit tests for app/api/oauth/token/route.ts — POST /api/oauth/token
 *
 * ES-019 Unit Test Plan (O-1 through O-8)
 *
 *   O-1  Valid credentials → 200, access_token in body
 *   O-2  Wrong secret → 401 invalid_client
 *   O-3  Client not found → 401 invalid_client
 *   O-4  Revoked client → 401 client_revoked
 *   O-5  Wrong grant_type → 400 invalid_request
 *   O-6  Missing client_id field → 400 invalid_request
 *   O-7  Rate limited (>10 req/min same client_id) → 429 rate_limit_exceeded
 *   O-8  touchApiClientLastUsed called on successful auth
 *
 * Mocks: @/lib/db/api-clients, @/lib/api-auth, @/lib/rate-limit
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@/lib/db/api-clients", () => ({
  getApiClientByClientId: vi.fn(),
  verifyApiClientSecret: vi.fn(),
  touchApiClientLastUsed: vi.fn(),
}));

vi.mock("@/lib/api-auth", () => ({
  signApiToken: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { POST } from "@/app/api/oauth/token/route";
import {
  getApiClientByClientId,
  verifyApiClientSecret,
  touchApiClientLastUsed,
} from "@/lib/db/api-clients";
import { signApiToken } from "@/lib/api-auth";
import { checkRateLimit } from "@/lib/rate-limit";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ACTIVE_CLIENT = {
  id: "row-id-1",
  teamId: "team-abc",
  clientId: "client-id-xyz-24chars",
  clientSecretHash: "$2b$12$hashedsecret",
  name: "WordPress Plugin",
  scopes: ["audit:read", "audit:write", "account:read"],
  lastUsedAt: null,
  revokedAt: null,
  createdAt: new Date(),
};

const VALID_BODY = {
  grant_type: "client_credentials",
  client_id: "client-id-xyz-24chars",
  client_secret: "raw-secret-32chars-nanoid-here",
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("POST /api/oauth/token", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Defaults: active client, correct secret, within rate limit
    vi.mocked(getApiClientByClientId).mockResolvedValue(ACTIVE_CLIENT);
    vi.mocked(verifyApiClientSecret).mockResolvedValue(true);
    vi.mocked(touchApiClientLastUsed).mockResolvedValue(undefined);
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      remaining: 9,
      resetAt: Date.now() + 60_000,
    });
    vi.mocked(signApiToken).mockResolvedValue("mock-jwt-token.payload.sig");
  });

  it("O-1: valid credentials → 200 with access_token, token_type=Bearer, expires_in=3600", async () => {
    const res = await POST(makeRequest(VALID_BODY));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.access_token).toBe("mock-jwt-token.payload.sig");
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(3600);
    expect(typeof body.scope).toBe("string");
    // scope should be space-separated list of scopes
    expect(body.scope).toContain("audit:read");
    expect(body.scope).toContain("audit:write");
  });

  it("O-2: wrong secret → 401 invalid_client", async () => {
    vi.mocked(verifyApiClientSecret).mockResolvedValue(false);

    const res = await POST(
      makeRequest({ ...VALID_BODY, client_secret: "wrong-secret" })
    );
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("invalid_client");
  });

  it("O-3: client not found → 401 invalid_client", async () => {
    vi.mocked(getApiClientByClientId).mockResolvedValue(null);

    const res = await POST(
      makeRequest({ ...VALID_BODY, client_id: "unknown-client-id" })
    );
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("invalid_client");
  });

  it("O-4: revoked client → 401 client_revoked", async () => {
    vi.mocked(getApiClientByClientId).mockResolvedValue({
      ...ACTIVE_CLIENT,
      revokedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const res = await POST(makeRequest(VALID_BODY));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("client_revoked");
  });

  it("O-5: wrong grant_type → 400 invalid_request", async () => {
    const res = await POST(
      makeRequest({
        grant_type: "authorization_code",
        client_id: "cid",
        client_secret: "secret",
      })
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_request");
  });

  it("O-6: missing client_id → 400 invalid_request", async () => {
    const res = await POST(
      makeRequest({ grant_type: "client_credentials", client_secret: "secret" })
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_request");
  });

  it("O-6b: missing client_secret → 400 invalid_request", async () => {
    const res = await POST(
      makeRequest({ grant_type: "client_credentials", client_id: "cid" })
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_request");
  });

  it("O-7: rate limit exceeded → 429 rate_limit_exceeded", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });

    const res = await POST(makeRequest(VALID_BODY));
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(body.error).toBe("rate_limit_exceeded");
  });

  it("O-8: touchApiClientLastUsed called with correct clientId on success", async () => {
    await POST(makeRequest(VALID_BODY));

    expect(vi.mocked(touchApiClientLastUsed)).toHaveBeenCalledWith(
      "client-id-xyz-24chars"
    );
    expect(vi.mocked(touchApiClientLastUsed)).toHaveBeenCalledTimes(1);
  });

  it("O-8b: touchApiClientLastUsed NOT called on auth failure", async () => {
    vi.mocked(verifyApiClientSecret).mockResolvedValue(false);

    await POST(makeRequest(VALID_BODY));

    expect(vi.mocked(touchApiClientLastUsed)).not.toHaveBeenCalled();
  });
});
