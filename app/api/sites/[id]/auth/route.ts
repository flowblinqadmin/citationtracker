import { NextRequest, NextResponse, after } from "next/server";
import { db } from "@/lib/db";
import { geoSites } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { generateVerificationCode, hashCode, sendVerificationEmail } from "@/lib/email";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/client-ip";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/sites/[id]/auth — request access recovery via email OTP.
 *
 * Does NOT return the accessToken. Instead sends a new OTP to the verified
 * owner email. The user then verifies via /api/sites/[id]/verify as usual.
 */
export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const { email } = await req.json() as { email?: string };

    if (!email?.trim()) {
      return NextResponse.json({ error: "Email required" }, { status: 400 });
    }

    // Rate limit: 5 auth recovery attempts per IP per 15 minutes
    const ip = getClientIp(req);
    const rl = await checkRateLimit(`auth:${ip}`, 5, 15 * 60 * 1000);
    if (!rl.allowed) {
      return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
    }

    const [site] = await db
      .select({ id: geoSites.id, ownerEmail: geoSites.ownerEmail, domain: geoSites.domain })
      .from(geoSites)
      .where(eq(geoSites.id, id));

    if (!site) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // M1 (2026-05-27 audit): constant-shape response. Run OTP write +
    // email send via after() so response timing does not reveal whether
    // the email was the site's owner.
    if (site.ownerEmail.toLowerCase() === email.trim().toLowerCase()) {
      const code = generateVerificationCode();
      const codeHash = hashCode(code);
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
      const targetEmail = email.trim().toLowerCase();
      const domain = site.domain;
      after(async () => {
        try {
          await db
            .update(geoSites)
            .set({
              verificationCode: codeHash,
              codeExpiresAt: expiresAt,
              updatedAt: new Date(),
            })
            .where(eq(geoSites.id, id));
          await sendVerificationEmail(targetEmail, code, domain);
        } catch (err) {
          console.error("[sites/auth] after() OTP write/send failed:", err);
        }
      });
    }

    return NextResponse.json({
      message: "If that email matches, a verification code has been sent.",
    });
  } catch (err) {
    console.error("POST /api/sites/[id]/auth error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
