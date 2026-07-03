/**
 * Tests for updateSession() in lib/supabase/middleware.ts.
 *
 * Security regression guard: the middleware forwards an identity (x-user-id /
 * x-user-email) that downstream API routes trust WITHOUT re-validating (see
 * lib/supabase/authenticated-client.ts). That identity must therefore come
 * from supabase.auth.getUser() — which authenticates the token against the
 * Auth server — and NEVER from supabase.auth.getSession().user, which is read
 * straight from cookies and can be spoofed. (Trusting session.user was the
 * source of the "Using the user object as returned from getSession()... could
 * be insecure" warning.)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockGetUser, mockGetSession } = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockGetSession: vi.fn(),
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({
    auth: { getUser: mockGetUser, getSession: mockGetSession },
  })),
}));

import { updateSession } from "@/lib/supabase/middleware";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(path: string): NextRequest {
  return new NextRequest(new Request(`http://localhost${path}`));
}

const VERIFIED_USER = { id: "verified-uid", email: "verified@example.com" };

// A session whose .user DISAGREES with getUser() — if the middleware ever
// forwards this id, it is trusting the spoofable cookie value.
const SPOOFED_SESSION = {
  access_token: "access-token-123",
  expires_at: 1_900_000_000,
  user: { id: "SPOOFED-uid", email: "attacker@evil.com" },
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("updateSession — verified identity forwarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://proj.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
    mockGetUser.mockReset();
    mockGetSession.mockReset();
    mockGetUser.mockResolvedValue({ data: { user: VERIFIED_USER }, error: null });
    mockGetSession.mockResolvedValue({ data: { session: SPOOFED_SESSION }, error: null });
  });

  it("uses getUser() (not getSession) to decide authentication", async () => {
    await updateSession(makeRequest("/dashboard"));
    expect(mockGetUser).toHaveBeenCalled();
  });

  it("forwards the getUser()-verified id/email, never session.user", async () => {
    const res = await updateSession(makeRequest("/dashboard/domains/abc123"));

    expect(res.headers.get("x-user-id")).toBe("verified-uid");
    expect(res.headers.get("x-user-id")).not.toBe("SPOOFED-uid"); // the cookie value
    expect(res.headers.get("x-user-email")).toBe("verified@example.com");
    expect(res.headers.get("x-user-email")).not.toBe("attacker@evil.com");
  });

  it("forwards the access token + expiry from the session (those fields are safe)", async () => {
    const res = await updateSession(makeRequest("/dashboard"));
    expect(res.headers.get("x-supabase-token")).toBe("access-token-123");
    expect(res.headers.get("x-token-exp")).toBe("1900000000");
  });

  it("unauthenticated request to /dashboard → redirect to /auth/login, no identity forwarded", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const res = await updateSession(makeRequest("/dashboard/domains/abc123"));

    expect(res.status).toBe(307); // NextResponse.redirect default
    expect(res.headers.get("location")).toContain("/auth/login");
    expect(res.headers.get("x-user-id")).toBeNull();
  });

  it("authenticated user on a non-protected path → no redirect, identity still forwarded", async () => {
    const res = await updateSession(makeRequest("/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-user-id")).toBe("verified-uid");
  });

  it("verified user but no session token → no token header, no crash", async () => {
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });

    const res = await updateSession(makeRequest("/dashboard"));

    expect(res.status).toBe(200);
    expect(res.headers.get("x-supabase-token")).toBeNull();
    expect(res.headers.get("x-user-id")).toBeNull();
  });

  it("strips any client-supplied identity headers from the incoming request", async () => {
    // An attacker setting x-user-id directly must not survive into downstream.
    const req = new NextRequest(
      new Request("http://localhost/dashboard", {
        headers: { "x-user-id": "injected-uid", "x-user-email": "inject@evil.com" },
      }),
    );
    await updateSession(req);
    expect(req.headers.get("x-user-id")).toBeNull();
    expect(req.headers.get("x-user-email")).toBeNull();
  });
});
