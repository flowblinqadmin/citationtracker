import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const DEBUG = process.env.NODE_ENV === "development";

export async function updateSession(request: NextRequest) {
  // Strip any client-supplied auth headers before we set our own. authorization
  // is stripped too — nothing downstream may authenticate from it.
  request.headers.delete("x-user-id");
  request.headers.delete("x-user-email");
  request.headers.delete("x-supabase-token");
  request.headers.delete("x-token-exp");
  request.headers.delete("authorization");

  const { pathname } = request.nextUrl;

  if (DEBUG) {
    console.error(`[MIDDLEWARE] START: ${pathname}`);
  }

  // Skip static files early
  if (pathname.startsWith("/_next")) {
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

  if (DEBUG) {
    console.error(`[MIDDLEWARE] getUser: authenticated=${!!user}`);
  }

  // No redirects here — this service has no auth pages of its own (login lives
  // on geo). The outer middleware decides redirect vs 401 from the presence of
  // the x-user-id header stamped below.

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
