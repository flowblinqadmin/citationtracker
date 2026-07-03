import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { checkRateLimit } from "@/lib/rate-limit";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: NextRequest) {
  try {
    // 1. Parse body
    const body = await request.json();
    const rawEmail = body?.email;

    // 2. Validate email
    if (!rawEmail || typeof rawEmail !== "string" || !EMAIL_RE.test(rawEmail.trim())) {
      return NextResponse.json(
        { error: "Invalid email address" },
        { status: 400 }
      );
    }

    // 3. Normalize
    const email = rawEmail.trim().toLowerCase();

    // 4. Rate limit
    const rl = await checkRateLimit(`otp_send:${email}`, 5, 15 * 60 * 1000);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Too many attempts. Please try again later.", resetAt: rl.resetAt },
        { status: 429 }
      );
    }

    // 5. Get Supabase admin client
    const supabase = getSupabaseAdmin();
    if (!supabase) {
      return NextResponse.json(
        { error: "Auth service unavailable" },
        { status: 500 }
      );
    }

    // 6. Send OTP via Supabase
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true },
    });

    if (error) {
      console.error("[otp/send] signInWithOtp failed:", error.message);
      return NextResponse.json(
        { error: "Failed to send verification code" },
        { status: 500 }
      );
    }

    // 7. Success
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[otp/send] unexpected error:", err);
    return NextResponse.json(
      { error: "Failed to send verification code" },
      { status: 500 }
    );
  }
}
