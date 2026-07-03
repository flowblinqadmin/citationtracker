/**
 * Unit tests for app/auth/exchange/route.ts — GET /auth/exchange?code=JWT
 *
 * Tests the exchange code authentication flow that accepts a short-lived JWT
 * containing Supabase session tokens, sets the session cookie, and redirects.
 *
 *   AX-1  Valid exchange code → sets Supabase session → redirects to path
 *   AX-2  Expired JWT → redirects to /auth/login?error=exchange-expired
 *   AX-3  Missing code param → redirects to /auth/login
 *   AX-4  Invalid JWT signature → redirects to /auth/login?error=exchange-expired
 *   AX-5  Missing tokens in payload → redirects to /auth/login?error=invalid-exchange
 *   AX-6  Redirect path validation — rejects external URLs, defaults to /dashboard
 *   AX-7  Site token in hash — redirect URL includes #st=TOKEN&sid=ID
 *   AX-8  Missing API_JWT_SECRET → redirects to /auth/login?error=server-misconfigured
 *         (distinct from exchange-expired so a real env-var drift surfaces a
 *         specific signal in the UI, not a silent "your link expired")
 *
 * Mocks: jose/jwtVerify, @supabase/ssr/createServerClient, next/headers/cookies
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Mocks ────────────────────────────────────────────────────────────────────

// vi.hoisted runs before vi.mock hoisting, so these fns are available in factories
const { mockSetSession, mockSignOut, mockCookieSet, mockCookieGetAll } = vi.hoisted(() => ({
  mockSetSession: vi.fn().mockResolvedValue({ data: {}, error: null }),
  mockSignOut: vi.fn().mockResolvedValue({ error: null }),
  mockCookieSet: vi.fn(),
  mockCookieGetAll: vi.fn().mockReturnValue([]),
}));

vi.mock("jose", () => ({
  jwtVerify: vi.fn(),
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({
    auth: {
      setSession: mockSetSession,
      signOut: mockSignOut,
    },
  })),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn().mockResolvedValue({
    getAll: mockCookieGetAll,
    set: mockCookieSet,
  }),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { GET } from "@/app/auth/exchange/route";
import { jwtVerify } from "jose";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BASE_URL = "http://localhost:3000";

function makeRequest(params?: Record<string, string>): NextRequest {
  const url = new URL("/auth/exchange", BASE_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }
  return new NextRequest(url);
}

function validPayload(overrides?: Record<string, unknown>) {
  return {
    access_token: "mock-access-token-abc",
    refresh_token: "mock-refresh-token-xyz",
    redirect: "/audit/abc123",
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET /auth/exchange", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetSession.mockResolvedValue({ data: {}, error: null });
  });

  it("AX-1: valid exchange code → sets Supabase session → redirects to redirect path", async () => {
    const payload = validPayload();
    vi.mocked(jwtVerify).mockResolvedValue({
      payload,
      protectedHeader: { alg: "HS256" },
    } as any);

    const res = await GET(makeRequest({ code: "valid-jwt-token" }));

    // Should call setSession with the tokens
    expect(mockSetSession).toHaveBeenCalledWith({
      access_token: "mock-access-token-abc",
      refresh_token: "mock-refresh-token-xyz",
    });

    // Should redirect to the specified path
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/audit/abc123");
  });

  it("AX-1b: signs out with scope:'local' BEFORE setSession — never a global revoke", async () => {
    // Regression: the default (global) signOut() revokes EVERY session for the
    // user on the Supabase server. For a returning user the OTP-minted session
    // is the same user's, so a global sign-out killed the brand-new session a
    // moment before setSession wrote it to the cookie — /dashboard then bounced
    // back to /auth/login. New users had no prior session, so the bug only ever
    // hit returning users. scope:"local" clears the local cookie without the
    // server-side revoke.
    vi.mocked(jwtVerify).mockResolvedValue({
      payload: validPayload(),
      protectedHeader: { alg: "HS256" },
    } as any);

    await GET(makeRequest({ code: "valid-jwt-token" }));

    expect(mockSignOut).toHaveBeenCalledWith({ scope: "local" });
    // Ordering: clear local cookie state, THEN write the new session.
    expect(mockSignOut.mock.invocationCallOrder[0]).toBeLessThan(
      mockSetSession.mock.invocationCallOrder[0],
    );
  });

  it("AX-2: expired JWT → redirects to /auth/login?error=exchange-expired", async () => {
    vi.mocked(jwtVerify).mockRejectedValue(
      new Error("JWTExpired: JWT has expired")
    );

    const res = await GET(makeRequest({ code: "expired-jwt-token" }));

    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/auth/login");
    expect(location.searchParams.get("error")).toBe("exchange-expired");

    // Should NOT attempt to set session
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  it("AX-3: missing code param → redirects to /auth/login", async () => {
    const res = await GET(makeRequest());

    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/auth/login");
    expect(location.searchParams.has("error")).toBe(false);

    expect(vi.mocked(jwtVerify)).not.toHaveBeenCalled();
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  it("AX-4: invalid JWT signature → redirects to /auth/login?error=exchange-expired", async () => {
    vi.mocked(jwtVerify).mockRejectedValue(
      new Error("JWSSignatureVerificationFailed: signature verification failed")
    );

    const res = await GET(makeRequest({ code: "tampered-jwt-token" }));

    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/auth/login");
    expect(location.searchParams.get("error")).toBe("exchange-expired");

    expect(mockSetSession).not.toHaveBeenCalled();
  });

  it("AX-5: missing tokens in payload → redirects to /auth/login?error=invalid-exchange", async () => {
    // JWT is valid but payload lacks access_token/refresh_token
    vi.mocked(jwtVerify).mockResolvedValue({
      payload: { redirect: "/audit/abc123" },
      protectedHeader: { alg: "HS256" },
    } as any);

    const res = await GET(makeRequest({ code: "valid-but-empty-jwt" }));

    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/auth/login");
    expect(location.searchParams.get("error")).toBe("invalid-exchange");

    expect(mockSetSession).not.toHaveBeenCalled();
  });

  it("AX-5b: missing refresh_token only → redirects to /auth/login?error=invalid-exchange", async () => {
    vi.mocked(jwtVerify).mockResolvedValue({
      payload: { access_token: "has-access", redirect: "/audit/abc123" },
      protectedHeader: { alg: "HS256" },
    } as any);

    const res = await GET(makeRequest({ code: "missing-refresh-jwt" }));

    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/auth/login");
    expect(location.searchParams.get("error")).toBe("invalid-exchange");
  });

  describe("AX-6: redirect path validation", () => {
    it("rejects absolute external URL — defaults to /dashboard", async () => {
      vi.mocked(jwtVerify).mockResolvedValue({
        payload: validPayload({ redirect: "https://evil.com/steal" }),
        protectedHeader: { alg: "HS256" },
      } as any);

      const res = await GET(makeRequest({ code: "open-redirect-jwt" }));

      expect(res.status).toBe(307);
      const location = new URL(res.headers.get("location")!);
      expect(location.pathname).toBe("/dashboard");
      // Must NOT redirect to evil.com
      expect(location.hostname).not.toBe("evil.com");
    });

    it("rejects protocol-relative URL — defaults to /dashboard", async () => {
      vi.mocked(jwtVerify).mockResolvedValue({
        payload: validPayload({ redirect: "//evil.com/steal" }),
        protectedHeader: { alg: "HS256" },
      } as any);

      const res = await GET(makeRequest({ code: "proto-relative-jwt" }));

      expect(res.status).toBe(307);
      const location = new URL(res.headers.get("location")!);
      expect(location.pathname).toBe("/dashboard");
    });

    it("allows valid relative paths with query params", async () => {
      vi.mocked(jwtVerify).mockResolvedValue({
        payload: validPayload({ redirect: "/sites/abc123?tab=overview" }),
        protectedHeader: { alg: "HS256" },
      } as any);

      const res = await GET(makeRequest({ code: "query-param-jwt" }));

      expect(res.status).toBe(307);
      const location = new URL(res.headers.get("location")!);
      expect(location.pathname).toBe("/sites/abc123");
      expect(location.searchParams.get("tab")).toBe("overview");
    });

    it("rejects javascript: URI — defaults to /dashboard", async () => {
      vi.mocked(jwtVerify).mockResolvedValue({
        payload: validPayload({ redirect: "javascript:alert(1)" }),
        protectedHeader: { alg: "HS256" },
      } as any);

      const res = await GET(makeRequest({ code: "js-uri-jwt" }));

      expect(res.status).toBe(307);
      const location = new URL(res.headers.get("location")!);
      expect(location.pathname).toBe("/dashboard");
    });

    it("defaults to /dashboard when redirect is undefined", async () => {
      vi.mocked(jwtVerify).mockResolvedValue({
        payload: validPayload({ redirect: undefined }),
        protectedHeader: { alg: "HS256" },
      } as any);

      const res = await GET(makeRequest({ code: "no-redirect-jwt" }));

      expect(res.status).toBe(307);
      const location = new URL(res.headers.get("location")!);
      expect(location.pathname).toBe("/dashboard");
    });
  });

  it("AX-7: site_token and site_id present → redirect includes hash fragment #st=TOKEN&sid=ID", async () => {
    vi.mocked(jwtVerify).mockResolvedValue({
      payload: validPayload({
        site_token: "site-access-token-123",
        site_id: "site-uuid-456",
      }),
      protectedHeader: { alg: "HS256" },
    } as any);

    const res = await GET(makeRequest({ code: "site-token-jwt" }));

    expect(res.status).toBe(307);
    const location = res.headers.get("location")!;
    expect(location).toContain("/audit/abc123");
    expect(location).toContain("#st=site-access-token-123&sid=site-uuid-456");
  });

  it("AX-7b: site_token present but site_id missing → no hash fragment", async () => {
    vi.mocked(jwtVerify).mockResolvedValue({
      payload: validPayload({
        site_token: "site-access-token-123",
        // no site_id
      }),
      protectedHeader: { alg: "HS256" },
    } as any);

    const res = await GET(makeRequest({ code: "partial-site-jwt" }));

    expect(res.status).toBe(307);
    const location = res.headers.get("location")!;
    expect(location).not.toContain("#st=");
  });

  it("AX-8: missing API_JWT_SECRET → redirects to /auth/login?error=server-misconfigured (does NOT call jwtVerify)", async () => {
    const original = process.env.API_JWT_SECRET;
    delete process.env.API_JWT_SECRET;
    try {
      const res = await GET(makeRequest({ code: "any-jwt" }));

      expect(res.status).toBe(307);
      const location = new URL(res.headers.get("location")!);
      expect(location.pathname).toBe("/auth/login");
      expect(location.searchParams.get("error")).toBe("server-misconfigured");

      // Must NOT attempt to verify or call Supabase when secret is absent —
      // the failure must surface as a server-misconfigured signal, not blend
      // in with exchange-expired.
      expect(vi.mocked(jwtVerify)).not.toHaveBeenCalled();
      expect(mockSetSession).not.toHaveBeenCalled();
    } finally {
      if (original !== undefined) process.env.API_JWT_SECRET = original;
    }
  });

  it("AX-1b: jwtVerify is called with HS256 algorithm constraint", async () => {
    vi.mocked(jwtVerify).mockResolvedValue({
      payload: validPayload(),
      protectedHeader: { alg: "HS256" },
    } as any);

    await GET(makeRequest({ code: "any-jwt" }));

    expect(vi.mocked(jwtVerify)).toHaveBeenCalledWith(
      "any-jwt",
      expect.any(Uint8Array),
      { algorithms: ["HS256"] }
    );
  });
});
