import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { ensureTeamForUser } from "@/lib/services/provision-team";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const error = searchParams.get("error");
  const errorDescription = searchParams.get("error_description");
  const rawNext = searchParams.get("next") ?? "/dashboard";
  // Strict allowlist: must be a relative path with no protocol-relative or backslash tricks.
  // Blocks //evil.com, /\evil.com, ///evil.com, javascript:, data:, etc.
  const next = /^\/[a-zA-Z0-9\-_/?=&#%]*$/.test(rawNext) ? rawNext : "/dashboard";

  if (error) {
    console.error("[Auth Callback] OAuth provider error:", error, errorDescription);
    const errorUrl = new URL(`${origin}/auth/login?error=auth-code-error`);
    if (errorDescription) {
      errorUrl.searchParams.set("error_description", errorDescription);
    }
    return NextResponse.redirect(errorUrl);
  }

  if (!code) {
    console.error("[Auth Callback] No authorization code received");
    const errorUrl = new URL(`${origin}/auth/login?error=auth-code-error`);
    errorUrl.searchParams.set("error_description", "No authorization code received");
    return NextResponse.redirect(errorUrl);
  }

  try {
    const cookieStore = await cookies();

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll();
          },
          setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          },
        },
      }
    );

    const { data, error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);

    if (exchangeError) {
      console.error("[Auth Callback] Exchange error:", exchangeError.message);
      const errorUrl = new URL(`${origin}/auth/login?error=auth-code-error`);
      errorUrl.searchParams.set("error_description", exchangeError.message);
      return NextResponse.redirect(errorUrl);
    }

    if (!data?.session) {
      console.error("[Auth Callback] No session returned after code exchange");
      const errorUrl = new URL(`${origin}/auth/login?error=auth-code-error`);
      errorUrl.searchParams.set("error_description", "Authentication succeeded but no session was created");
      return NextResponse.redirect(errorUrl);
    }

    const user = data.session.user;
    const userEmail = user.email?.toLowerCase() ?? "";
    const userId = user.id;

    // Team creation + geo_sites auto-link (idempotent)
    try {
      if (userEmail) {
        await ensureTeamForUser(userId, userEmail);
      }
    } catch (teamErr) {
      // Non-fatal — log and continue to dashboard
      console.error("[Auth Callback] Team creation/link error:", teamErr);
    }

    // Use NEXT_PUBLIC_APP_URL in production to avoid trusting forged x-forwarded-host headers.
    const appUrl = process.env.NODE_ENV === "development"
      ? origin
      : (process.env.NEXT_PUBLIC_APP_URL ?? origin);

    return NextResponse.redirect(`${appUrl}${next}`);
  } catch (err) {
    console.error("[Auth Callback] Unexpected error:", err);
    const errorUrl = new URL(`${origin}/auth/login?error=auth-code-error`);
    errorUrl.searchParams.set("error_description", "An unexpected error occurred during authentication");
    return NextResponse.redirect(errorUrl);
  }
}
