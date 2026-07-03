import { NextResponse } from "next/server";
import { z } from "zod";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { auditReports } from "@/lib/db/schema";
import { Resend } from "resend";
import {
  generateVerificationCode,
  hashCode,
  sendCommerceVerificationEmail,
} from "@/lib/email-commerce";
import { escapeHtml } from "@/lib/sanitize";
import { checkRateLimit } from "@/lib/rate-limit-commerce";
import { getClientIp } from "@/lib/client-ip";

const BLOCKED_HOSTS = /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.|::1|fe80:)/i;

const createAuditSchema = z.object({
  merchant_url: z
    .string()
    .min(3)
    .transform((v) => (v.startsWith("http") ? v : `https://${v}`))
    .refine((url) => {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
        if (BLOCKED_HOSTS.test(parsed.hostname)) return false;
        return true;
      } catch { return false; }
    }, { message: "URL must be a public website" }),
  merchant_name: z.string().max(200).optional(),
  contact_email: z.string().email(),
  product_category: z.string().max(200).optional(),
  revenue_estimate: z.string().optional(),
});

function extractNameFromUrl(url: string): string {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    // "factorymotorparts.com" → "factorymotorparts"
    return hostname.split(".")[0];
  } catch {
    return url;
  }
}

export async function POST(request: Request) {
  try {
    // Rate limit: 10 requests per IP per 15 min, 3 per email per 15 min
    const ip = getClientIp(request)
    if (!(await checkRateLimit(`audit-ip:${ip}`, 10, 15 * 60 * 1000))) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429 }
      )
    }

    const body = await request.json();
    const parsed = createAuditSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const {
      merchant_url,
      contact_email,
      product_category,
      revenue_estimate,
    } = parsed.data;
    const merchant_name = parsed.data.merchant_name || extractNameFromUrl(merchant_url);

    // M6 (2026-05-27 audit): nanoid(12) ≈ 71 bits — brute-forceable when
    // combined with the H7 enumeration surface. Bumped to 24 chars to
    // mirror auditPurchases.purchaseToken entropy.
    const id = nanoid(24);
    const skipVerify = process.env.SKIP_EMAIL_VERIFY === "true" && (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test");

    if (skipVerify) {
      console.warn("EMAIL VERIFICATION BYPASSED — dev mode");
      await db.insert(auditReports).values({
        id,
        merchant_url,
        merchant_name,
        contact_email,
        product_category: product_category || null,
        revenue_estimate: revenue_estimate || null,
        verification_code: null,
        code_expires_at: null,
        status: "verified",
        email_verified: true,
      });
    } else {
      const code = generateVerificationCode();
      const hashedCode = hashCode(code);
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min

      await db.insert(auditReports).values({
        id,
        merchant_url,
        merchant_name,
        contact_email,
        product_category: product_category || null,
        revenue_estimate: revenue_estimate || null,
        verification_code: hashedCode,
        code_expires_at: expiresAt,
        status: "pending_verification",
      });

      await sendCommerceVerificationEmail(contact_email, merchant_name, code);
    }

    // Notify admin (fire-and-forget)
    const resend = new Resend(process.env.RESEND_API_KEY);
    const safeName = escapeHtml(merchant_name);
    const safeUrl = escapeHtml(merchant_url);
    const safeEmail = escapeHtml(contact_email);
    const safeCategory = escapeHtml(product_category || "Not specified");
    const safeRevenue = escapeHtml(revenue_estimate || "Not specified");
    // M5 (2026-05-27 audit): escapeHtml does NOT defeat `javascript:` URIs
    // inside href values. Validate the scheme explicitly — anything other
    // than http(s) falls back to `#`. The displayed text still shows the
    // raw URL (escaped) for admin visibility.
    let safeHref = "#";
    try {
      const parsed = new URL(merchant_url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        safeHref = escapeHtml(parsed.toString());
      }
    } catch {
      safeHref = "#";
    }
    resend.emails.send({
      from: "FlowBlinq Audit <noreply@send.flowblinq.com>",
      to: "ar@flowblinq.com",
      subject: `New Audit: ${safeName} (${safeUrl})`,
      html: `
        <h2>New AI Visibility Audit</h2>
        <p><strong>Store:</strong> ${safeName}</p>
        <p><strong>URL:</strong> <a href="${safeHref}">${safeUrl}</a></p>
        <p><strong>Email:</strong> ${safeEmail}</p>
        <p><strong>Category:</strong> ${safeCategory}</p>
        <p><strong>Revenue:</strong> ${safeRevenue}</p>
        <p><strong>Audit ID:</strong> <a href="https://geo.flowblinq.com/audit/${id}">${id}</a></p>
        <hr />
        <p><em>Submitted via geo.flowblinq.com</em></p>
      `,
    }).then(({ error }) => {
      if (error) console.error("Admin notification email failed:", JSON.stringify(error));
    }).catch((e) => console.error("Admin notification email error:", e));

    return NextResponse.json({ id, status: skipVerify ? "verified" : "pending_verification" });
  } catch (err) {
    console.error("Create audit error:", err);
    return NextResponse.json(
      { error: "Failed to create audit" },
      { status: 500 }
    );
  }
}
