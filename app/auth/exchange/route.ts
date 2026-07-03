import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * GET /auth/exchange?code=<JWT>
 *
 * Accepts a short-lived, signed JWT (60s TTL) containing Supabase session
 * tokens and a redirect target. Sets the Supabase session cookie on
 * geo.flowblinq.com and redirects — no tokens exposed in the URL.
 *
 * Used by flowblinq.com to hand off authenticated users after OTP
 * verification happens on the marketing site.
 */

function loadExchangeSecret(): Uint8Array | null {
  const raw = process.env.API_JWT_SECRET;
  if (!raw) return null;
  return new TextEncoder().encode(raw);
}

interface ExchangePayload {
  access_token: string;
  refresh_token: string;
  redirect: string;    // e.g. "/sites/abc123" or "/dashboard"
  site_token?: string; // site accessToken for sessionStorage
  site_id?: string;
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");

  if (!code) {
    return NextResponse.redirect(new URL("/auth/login", req.url));
  }

  // Surface a distinct error when the server is misconfigured rather than
  // silently failing JWT verification with an empty secret — that path used
  // to look identical to a genuinely expired token, which sent users back
  // to the email-entry form with no actionable signal.
  const exchangeSecret = loadExchangeSecret();
  if (!exchangeSecret) {
    console.error("[Auth Exchange] API_JWT_SECRET not configured");
    const appBase = process.env.NEXT_PUBLIC_APP_URL || req.url;
    return NextResponse.redirect(new URL("/auth/login?error=server-misconfigured", appBase));
  }

  try {
    const { payload } = await jwtVerify(code, exchangeSecret, {
      algorithms: ["HS256"],
    });

    const {
      access_token,
      refresh_token,
      redirect,
      site_token,
      site_id,
    } = payload as unknown as ExchangePayload;

    if (!access_token || !refresh_token) {
      return NextResponse.redirect(new URL("/auth/login?error=invalid-exchange", req.url));
    }

    // Validate redirect path — must be relative, no open redirect, no protocol-relative
    const safePath = (
      redirect &&
      redirect.startsWith("/") &&
      !redirect.startsWith("//") &&
      !redirect.includes("%2F%2F") &&
      !redirect.includes("%2f%2f") &&
      /^\/[a-zA-Z0-9\-_/?=&#[\]]*$/.test(redirect)
    ) ? redirect : "/dashboard";

    // Build redirect URL
    const appBase = process.env.NEXT_PUBLIC_APP_URL || req.url;
    const redirectUrl = new URL(safePath, appBase);
    if (site_token && site_id) {
      redirectUrl.hash = `st=${site_token}&sid=${site_id}`;
    }

    // Create redirect response FIRST, then set cookies on it
    const response = NextResponse.redirect(redirectUrl);

    // Set Supabase session cookie on the redirect response
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return req.cookies.getAll();
          },
          setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
            cookiesToSet.forEach(({ name, value, options }) => {
              response.cookies.set(name, value, options as any);
            });
          },
        },
      }
    );

    // Clear any existing session cookie before setting the new one.
    // MUST be scope:"local" — the default "global" scope revokes EVERY
    // session/refresh-token for the user on the Supabase server. For a
    // returning user the session just minted by OTP belongs to the same
    // user, so a global sign-out kills the brand-new session a moment
    // before setSession writes it to the cookie. The cookie then looks
    // valid but its session is already dead, so /dashboard middleware's
    // getSession() rejects it and bounces to /auth/login. New users have
    // no prior session, so the bug was invisible on the new-user path.
    // "local" clears only the local cookie state — no server revoke.
    await supabase.auth.signOut({ scope: "local" });
    await supabase.auth.setSession({
      access_token,
      refresh_token,
    });

    return response;
  } catch (err) {
    console.error("[Auth Exchange] JWT verify failed:", err);
    return NextResponse.redirect(new URL("/auth/login?error=exchange-expired", process.env.NEXT_PUBLIC_APP_URL || req.url));
  }
}
