import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

const ALLOWED_EMAILS = [
  "ar@flowblinq.com",
  "an@flowblinq.com",
  "roshan@flowblinq.com",
];

// M2 (2026-05-27 audit): NODE_ENV alone is a footgun — Vercel preview
// deploys that inherit `development` would mint sessions without OTP.
// Require BOTH Vercel non-prod AND an explicit opt-in env var so the
// bypass is impossible to enable accidentally.
const IS_LOCAL =
  process.env.NODE_ENV === "development" &&
  process.env.VERCEL_ENV !== "production" &&
  process.env.PARTS_DEV_BYPASS === "1";

/**
 * Parts dashboard auth.
 *
 * LOCAL: bypasses OTP — returns session directly for allowed emails.
 * PROD:  generates magic link via Supabase admin, exchanges hashed_token for session.
 *
 * POST { action: "send", email }  → sends OTP (prod) or returns token directly (local)
 * POST { action: "verify", email, code } → verifies OTP code (prod only)
 */
export async function POST(request: Request) {
  let body: { action: string; email: string; code?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { action, email } = body;
  if (!email || typeof email !== "string") {
    return NextResponse.json({ error: "Email required" }, { status: 400 });
  }

  const normalizedEmail = email.toLowerCase().trim();

  if (!ALLOWED_EMAILS.includes(normalizedEmail)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json({ error: "Auth service unavailable" }, { status: 503 });
  }

  // ── LOCAL: bypass OTP, return session directly ──
  if (IS_LOCAL && action === "send") {
    try {
      // Ensure user exists
      await admin.auth.admin.createUser({
        email: normalizedEmail,
        email_confirm: true,
      }).catch(() => {});

      // Generate magic link and exchange for session server-side
      const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
        type: "magiclink",
        email: normalizedEmail,
      });

      if (linkErr || !linkData?.properties?.hashed_token) {
        console.error("[Parts Auth] generateLink error:", linkErr?.message);
        return NextResponse.json({ error: "Auth failed" }, { status: 500 });
      }

      const hashedToken = linkData.properties.hashed_token;
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

      const verifyRes = await fetch(`${supabaseUrl}/auth/v1/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "apikey": anonKey! },
        body: JSON.stringify({ token_hash: hashedToken, type: "magiclink" }),
      });

      if (!verifyRes.ok) {
        const err = await verifyRes.text();
        console.error("[Parts Auth] token exchange error:", err);
        return NextResponse.json({ error: "Auth failed" }, { status: 500 });
      }

      const session = await verifyRes.json();

      return NextResponse.json({
        ok: true,
        accessToken: session.access_token,
        refreshToken: session.refresh_token,
        email: normalizedEmail,
        skipOtp: true,
      });
    } catch (err) {
      console.error("[Parts Auth] local auth error:", err);
      return NextResponse.json({ error: "Internal error" }, { status: 500 });
    }
  }

  // ── PROD: Send OTP ──
  if (action === "send") {
    try {
      await admin.auth.admin.createUser({
        email: normalizedEmail,
        email_confirm: true,
      }).catch(() => {});

      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

      const otpRes = await fetch(`${supabaseUrl}/auth/v1/otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "apikey": anonKey! },
        body: JSON.stringify({ email: normalizedEmail }),
      });

      if (!otpRes.ok) {
        const errText = await otpRes.text();
        console.error("[Parts Auth] GoTrue OTP error:", errText);
        // Rate limit — tell user to wait
        if (otpRes.status === 429) {
          return NextResponse.json({ error: "Please wait 60 seconds before requesting another code." }, { status: 429 });
        }
        return NextResponse.json({ error: "Failed to send code" }, { status: 500 });
      }

      return NextResponse.json({ ok: true, message: "Code sent to your email" });
    } catch (err) {
      console.error("[Parts Auth] send error:", err);
      return NextResponse.json({ error: "Internal error" }, { status: 500 });
    }
  }

  // ── Verify OTP (prod only) ──
  if (action === "verify") {
    const { code } = body;
    if (!code || typeof code !== "string") {
      return NextResponse.json({ error: "Code required" }, { status: 400 });
    }

    try {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

      const verifyRes = await fetch(`${supabaseUrl}/auth/v1/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "apikey": anonKey! },
        body: JSON.stringify({ email: normalizedEmail, token: code.trim(), type: "email" }),
      });

      if (!verifyRes.ok) {
        const errBody = await verifyRes.json().catch(() => ({}));
        const msg = (errBody as { msg?: string }).msg || "Invalid or expired code";
        return NextResponse.json({ error: msg }, { status: 401 });
      }

      const session = await verifyRes.json();

      if (!session?.access_token) {
        return NextResponse.json({ error: "Verification failed" }, { status: 401 });
      }

      return NextResponse.json({
        ok: true,
        accessToken: session.access_token,
        refreshToken: session.refresh_token,
        email: normalizedEmail,
      });
    } catch (err) {
      console.error("[Parts Auth] verify error:", err);
      return NextResponse.json({ error: "Internal error" }, { status: 500 });
    }
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
