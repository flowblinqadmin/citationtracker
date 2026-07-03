// Verifies that the middleware redirect for unauthenticated /dashboard
// requests preserves the query string in the redirectTo param.
//
// Regression target: Bravo's $10-buyer install-CTA points at
// /dashboard?onboard=install. If a customer's magic link expires and they
// fall back to OTP via /auth/login, redirectTo must carry ?onboard=install
// so the post-auth landing page knows to open the install wizard.

import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      // Unauthenticated: getUser() (the verified auth check used by the
      // middleware) returns no user → /dashboard redirects to /auth/login.
      getUser: async () => ({ data: { user: null }, error: null }),
      getSession: async () => ({ data: { session: null }, error: null }),
      getClaims: async () => ({ data: { claims: null }, error: null }),
    },
  }),
}));

const ENV_BACKUP = { ...process.env };
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";

const { updateSession } = await import("@/lib/supabase/middleware");

function makeReq(path: string): NextRequest {
  return new NextRequest(new Request(`http://localhost${path}`));
}

describe("middleware redirect — query preservation", () => {
  it("preserves ?onboard=install in redirectTo when redirecting unauthenticated /dashboard", async () => {
    const res = await updateSession(makeReq("/dashboard?onboard=install"));
    expect(res.status).toBe(307);
    const location = res.headers.get("location");
    expect(location).toBeTruthy();
    const redirectToParam = new URL(location!).searchParams.get("redirectTo");
    expect(redirectToParam).toBe("/dashboard?onboard=install");
  });

  it("preserves multiple query params", async () => {
    const res = await updateSession(makeReq("/dashboard/domains?filter=active&sort=score"));
    const location = res.headers.get("location");
    const redirectToParam = new URL(location!).searchParams.get("redirectTo");
    expect(redirectToParam).toBe("/dashboard/domains?filter=active&sort=score");
  });

  it("redirects without trailing question mark when no query is present", async () => {
    const res = await updateSession(makeReq("/dashboard"));
    const location = res.headers.get("location");
    const redirectToParam = new URL(location!).searchParams.get("redirectTo");
    expect(redirectToParam).toBe("/dashboard");
  });
});

afterAll(() => {
  Object.assign(process.env, ENV_BACKUP);
});
