import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { generateExchangeCode } from "@/lib/services/exchange-code";
import { db } from "@/lib/db";
import { consentRecords } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { CURRENT_TOS_VERSION, CURRENT_EULA_VERSION } from "@/lib/config";
import { checkRateLimit } from "@/lib/rate-limit";
import { nanoid } from "nanoid";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_RE = /^\d{6}$/;

export async function POST(request: NextRequest) {
  try {
    // 1. Parse body
    const body = await request.json();
    const rawEmail = body?.email;
    const code = body?.code;
    const tosAccepted = body?.tosAccepted === true;

    // 2. Validate email
    if (!rawEmail || typeof rawEmail !== "string" || !EMAIL_RE.test(rawEmail.trim())) {
      return NextResponse.json(
        { error: "Invalid email address" },
        { status: 400 }
      );
    }

    // 3. Validate code format
    if (!code || typeof code !== "string" || !CODE_RE.test(code)) {
      return NextResponse.json(
        { error: "Invalid code format. Must be 6 digits." },
        { status: 400 }
      );
    }

    // 4. Normalize email
    const email = rawEmail.trim().toLowerCase();

    // 5. Rate limit
    const rl = await checkRateLimit(`otp_verify:${email}`, 10, 15 * 60 * 1000);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Too many attempts. Please try again later.", resetAt: rl.resetAt },
        { status: 429 }
      );
    }

    // 6. Create Supabase anon client (NOT admin)
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    // 7. Verify OTP
    const { data, error } = await supabase.auth.verifyOtp({
      email,
      token: code,
      type: "email",
    });

    if (error || !data?.session) {
      return NextResponse.json(
        { error: "Invalid or expired code" },
        { status: 401 }
      );
    }

    const { session } = data;
    const user = session.user;

    // 8. Check consent
    const existing = await db
      .select()
      .from(consentRecords)
      .where(
        and(
          eq(consentRecords.userId, user.id),
          eq(consentRecords.tosVersion, CURRENT_TOS_VERSION),
          eq(consentRecords.eulaVersion, CURRENT_EULA_VERSION)
        )
      );

    let requiresConsent = existing.length === 0;

    // 9. If tosAccepted and consent is needed, insert consent record
    if (tosAccepted && requiresConsent) {
      const ipAddress =
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
      const userAgent = request.headers.get("user-agent") || null;

      await db.insert(consentRecords).values({
        id: nanoid(),
        userId: user.id,
        email: user.email ?? email,
        tosVersion: CURRENT_TOS_VERSION,
        eulaVersion: CURRENT_EULA_VERSION,
        ipAddress,
        userAgent,
      });

      requiresConsent = false;
    }

    // 10. Generate exchange code
    const exchangeCode = await generateExchangeCode({
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      redirect: "/dashboard",
      siteToken: "",
      siteId: "",
    });

    // 11. Return success
    return NextResponse.json({
      success: true,
      exchangeCode,
      requiresConsent,
    });
  } catch (err) {
    console.error("[otp/verify] unexpected error:", err);
    return NextResponse.json(
      { error: "Verification failed" },
      { status: 500 }
    );
  }
}
