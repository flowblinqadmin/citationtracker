// POST /api/audit-purchase/checkout — unauthenticated Stripe checkout for $10 audit
// Pattern from: app/api/checkout/route.ts (lines 109-132, inline price_data)

import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { validatePublicUrl } from "@/lib/ssrf";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/client-ip";
import {
  signCheckoutBinding,
  CHECKOUT_BINDING_METADATA_KEY,
} from "@/lib/checkout-binding";

const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export async function POST(req: NextRequest) {
  try {
    // Guard: STRIPE_AUDIT_PRICE_ID must be configured
    if (!process.env.STRIPE_AUDIT_PRICE_ID) {
      console.error("[audit-purchase/checkout] STRIPE_AUDIT_PRICE_ID env var is not set");
      return NextResponse.json({ error: "misconfigured" }, { status: 500 });
    }

    // C4 (2026-05-27 audit): adversarial follow-up caught this route still
    // had the legacy `req.ip ?? x-forwarded-for` fallback. getClientIp()
    // refuses raw x-forwarded-for in favor of trusted infra-set headers.
    const ip = getClientIp(req);
    const rl = await checkRateLimit(`audit-checkout:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
    if (!rl.allowed) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }

    const body = await req.json().catch(() => ({})) as { websiteUrl?: string };

    // Validate websiteUrl + full SSRF guard before creating Stripe session
    const validation = validatePublicUrl(body.websiteUrl ?? "");
    if (!validation.ok) {
      return NextResponse.json({ error: "invalid_url" }, { status: 400 });
    }
    // Use the canonicalized URL href — never the raw input
    const canonicalUrl = validation.url.href;

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
    const websiteBase = process.env.WEBSITE_URL ?? "https://www.flowblinq.com";

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      allow_promotion_codes: true,
      line_items: [{ price: process.env.STRIPE_AUDIT_PRICE_ID, quantity: 1 }],
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true },
      customer_creation: "always",
      billing_address_collection: "required",
      // invoice_creation intentionally omitted — Stripe's invoice email for
      // one-time Checkout sessions uses collection_method: send_invoice by
      // default, which makes the email header show "CA$0.00 Due April 29"
      // (the already-paid balance) and triggers "Reminder: due in 0 days"
      // spam. The customer already receives:
      //   1. Stripe's automatic receipt (correctly shows "$10 charged")
      //   2. Our sendAuditPurchaseConfirmationEmail (domain + amount + ETA)
      // For tax records, the Stripe receipt and charge object carry full line
      // items. Re-enabling invoice_creation requires a post-creation webhook
      // to flip collection_method → charge_automatically, but that field is
      // immutable on finalized invoices. Approach C (drop invoice_creation)
      // is the cleanest, fully-tested path.
      metadata: {
        type: "audit_purchase",
        websiteUrl: canonicalUrl,
        // H4 (2026-05-27 audit): bind metadata.websiteUrl to a server-side
        // HMAC keyed on CRON_SECRET. Webhook rejects sessions whose binding
        // doesn't match — closes the Stripe-metadata-tamper window.
        [CHECKOUT_BINDING_METADATA_KEY]: signCheckoutBinding(
          canonicalUrl,
          process.env.STRIPE_AUDIT_PRICE_ID!,
        ),
      },
      success_url: `${websiteBase}/ai-audit-report/thank-you?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${websiteBase}/ai-audit-report`,
    });

    console.log(
      JSON.stringify({
        event: "audit_purchase_checkout_created",
        sessionId: session.id,
        websiteUrl: canonicalUrl,
        ip,
      }),
    );

    return NextResponse.json({ checkoutUrl: session.url }, { status: 201 });
  } catch (err) {
    console.error("POST /api/audit-purchase/checkout error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
