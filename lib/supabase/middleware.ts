import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const DEBUG = process.env.NODE_ENV === "development";

export async function updateSession(request: NextRequest) {
  // Strip any client-supplied auth headers before we set our own
  request.headers.delete("x-user-id");
  request.headers.delete("x-user-email");
  request.headers.delete("x-supabase-token");
  request.headers.delete("x-token-exp");

  const { pathname } = request.nextUrl;

  if (DEBUG) {
    console.error(`[MIDDLEWARE] START: ${pathname}`);
  }

  // Skip static files and auth callback early
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/auth/callback")
  ) {
    return NextResponse.next();
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY)?.trim();

  if (!url || !key) {
    console.error("[MIDDLEWARE] ERROR: Missing Supabase env vars");
    return NextResponse.next();
  }

  // CRITICAL: Create ONE response object and mutate it.
  // Multiple NextResponse.next() objects lose cookies.
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
        // Set cookies on request (for downstream server components)
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value)
        );
        // Create new response with updated request
        supabaseResponse = NextResponse.next({ request });
        // Set cookies on response (for browser)
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options)
        );
      },
    },
  });

  // getUser() authenticates the token against the Supabase Auth server and
  // refreshes the session (via the refresh_token) if the access token expired,
  // persisting new cookies through the setAll callback above. Its returned user
  // is verified — unlike getSession().user, which is read straight from the
  // cookies and can be spoofed. Supabase guidance: never trust getSession() for
  // identity in server code; protect pages with getUser().
  const { data: { user } } = await supabase.auth.getUser();

  const isAuthenticated = !!user;

  if (DEBUG) {
    console.error(`[MIDDLEWARE] getUser: authenticated=${isAuthenticated}`);
  }

  // /dashboard requires authentication
  const isProtectedPath = pathname.startsWith("/dashboard");

  if (!isAuthenticated && isProtectedPath) {
    // Preserve query string in redirectTo so post-auth navigation can act on
    // signals like ?onboard=install (Bravo's $10-buyer install-CTA target).
    // Without this, customers whose magic link expires get OTP-fallbacked to
    // /dashboard with no install signal.
    const redirectTo = encodeURIComponent(pathname + request.nextUrl.search);
    if (DEBUG) console.error(`[MIDDLEWARE] REDIRECT: ${pathname} -> /auth/login`);
    return NextResponse.redirect(new URL(`/auth/login?redirectTo=${redirectTo}`, request.url));
  }

  // Redirect authenticated users away from login page — unless ?switch=1 is set,
  // which allows switching accounts without the old session leaking through.
  if (isAuthenticated && pathname === "/auth/login") {
    const switchAccount = request.nextUrl.searchParams.get("switch");
    if (!switchAccount) {
      if (DEBUG) console.error(`[MIDDLEWARE] REDIRECT: /auth/login -> /dashboard`);
      return NextResponse.redirect(new URL("/dashboard", request.url));
    }
  }

  // Forward VERIFIED identity to downstream API routes (which trust x-user-id
  // without re-validating — see lib/supabase/authenticated-client.ts). The id
  // and email come from getUser() above (authenticated against the Auth
  // server), never from session.user. We still read the access token + expiry
  // from getSession() to forward as x-supabase-token — reading those fields is
  // safe; only session.user is unsafe to trust.
  if (user) {
    const { data: { session } } = await supabase.auth.getSession();

    if (session?.access_token) {
      const tokenExp = session.expires_at
        ? Math.floor(session.expires_at)
        : Math.floor(Date.now() / 1000) + 3600;

      supabaseResponse.headers.set("x-supabase-token", session.access_token);
      supabaseResponse.headers.set("x-user-id", user.id);
      supabaseResponse.headers.set("x-user-email", user.email ?? "");
      supabaseResponse.headers.set("x-token-exp", tokenExp.toString());
    }
  }

  return supabaseResponse;
}
