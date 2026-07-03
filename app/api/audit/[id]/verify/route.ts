import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditReports } from "@/lib/db/schema";
import { verifyCode } from "@/lib/email-commerce";
import { checkOtpAttempt, recordOtpFailure, clearOtpFailures } from "@/lib/rate-limit-commerce";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { code } = await request.json();

    if (!code || typeof code !== "string") {
      return NextResponse.json(
        { error: "Verification code is required" },
        { status: 400 }
      );
    }

    const [report] = await db
      .select()
      .from(auditReports)
      .where(eq(auditReports.id, id))
      .limit(1);

    if (!report) {
      return NextResponse.json({ error: "Audit not found" }, { status: 404 });
    }

    // H1: DB-persisted, audit_id-keyed lockout. Was previously in-memory +
    // keyed on attacker-controllable contact_email.
    const lockCheck = await checkOtpAttempt(report.id);
    if (!lockCheck.allowed) {
      return NextResponse.json(
        { error: `Too many failed attempts. Try again after ${lockCheck.lockedUntil?.toISOString()}.` },
        { status: 429 }
      )
    }

    if (report.email_verified) {
      return NextResponse.json({
        verified: true,
        id: report.id,
        status: report.status,
      });
    }

    if (!report.verification_code || !report.code_expires_at) {
      return NextResponse.json(
        { error: "No verification code on record" },
        { status: 400 }
      );
    }

    if (new Date() > report.code_expires_at) {
      return NextResponse.json(
        { error: "Code expired. Please request a new audit." },
        { status: 410 }
      );
    }

    if (!verifyCode(code.trim(), report.verification_code)) {
      await recordOtpFailure(report.id);
      return NextResponse.json(
        { error: "Invalid verification code" },
        { status: 401 }
      );
    }

    // Success — clear failure count
    await clearOtpFailures(report.id);

    await db
      .update(auditReports)
      .set({
        email_verified: true,
        status: "verified",
        updated_at: new Date(),
      })
      .where(eq(auditReports.id, id));

    // H2 (2026-05-27 audit): this route previously created a Supabase user
    // and returned an exchangeCode that produced a logged-in session for
    // `report.contact_email`. The contact_email was submitted unauthenticated
    // by anyone, so an attacker could mint a session for an arbitrary
    // victim's address by clicking the OTP themselves (OTP only proves
    // mailbox access, not request originator). Account provisioning has
    // been moved out of audit verify entirely — sessions are only minted
    // through the explicit /auth/* paths a user actively chooses.
    return NextResponse.json({
      verified: true,
      id: report.id,
      merchant_url: report.merchant_url,
      merchant_name: report.merchant_name,
      product_category: report.product_category,
      revenue_estimate: report.revenue_estimate,
      status: "verified",
    });
  } catch (err) {
    console.error("Verify error:", err);
    return NextResponse.json(
      { error: "Verification failed" },
      { status: 500 }
    );
  }
}
