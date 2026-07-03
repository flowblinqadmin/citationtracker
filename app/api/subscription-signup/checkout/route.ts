// POST /api/subscription-signup/checkout — UNAUTHENTICATED, payment-first subscription checkout.
//
// Mirrors the proven unauthenticated pattern of app/api/audit-purchase/checkout/route.ts
// (rate-limit + SSRF + HMAC binding), but creates a RECURRING `mode:"subscription"`
// session. There is no logged-in user yet: the team + account are provisioned by the
// Stripe webhook (`type:"subscription_signup"` branch) after payment, and the buyer
// signs in via the magic-link email the webhook sends.
//
// Pro is intentionally NOT supported here (sales-assisted "Talk to Us" → /contact).

import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { validatePublicUrl } from "@/lib/ssrf";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/client-ip";
import {
  signCheckoutBinding,
  CHECKOUT_BINDING_METADATA_KEY,
} from "@/lib/checkout-binding";
import {
  STRIPE_PRICE_IDS,
  isBillingInterval,
  isSellable,
  type BillingInterval,
  type PaidTier,
} from "@/lib/config";

// Checkout sessions are cheap (no charge until the card is entered) and users
// legitimately retry / share a NAT IP, so allow generous bursts that still cap
// Stripe-session spam. 5/hour (the audit-purchase value) was too strict here.
const RATE_LIMIT = 15;
const RATE_WINDOW_MS = 10 * 60 * 1000; // 15 per 10 minutes per IP

// Per-email limit: prevents one IP (or a rotating botnet) from spamming a
// victim's inbox with unsolicited Stripe checkout/confirmation emails. A real
// user retrying the checkout 3 times in an hour is fine; anything beyond that
// is abuse. Keyed on the lowercased canonical email so it works across IPs.
const EMAIL_RATE_LIMIT = 3;
const EMAIL_RATE_WINDOW_MS = 60 * 60 * 1000; // 3 per hour per email

// Self-serve signup funnel: Starter/Growth only. Pro is sales-assisted
// ("Talk to Us"), so it is excluded here even though Pro is otherwise sellable.
// Allowed intervals are NOT hardcoded — they derive from TIER_SELLABLE in
// lib/config via isSellable() below (the single source of truth).
const SIGNUP_PLANS = new Set<string>(["starter", "growth"]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: NextRequest) {
  try {
    if (!process.env.STRIPE_SECRET_KEY) {
      console.error("[subscription-signup/checkout] STRIPE_SECRET_KEY is not set");
      return NextResponse.json({ error: "misconfigured" }, { status: 500 });
    }

    const ip = getClientIp(req);
    const rl = await checkRateLimit(`sub-signup:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
    if (!rl.allowed) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }

    const body = (await req.json().catch(() => ({}))) as {
      email?: string;
      websiteUrl?: string;
      plan?: string;
      interval?: string;
    };

    const plan = typeof body.plan === "string" ? body.plan : "";
    if (!SIGNUP_PLANS.has(plan)) {
      return NextResponse.json({ error: "invalid_plan" }, { status: 400 });
    }

    // Interval must be a real billing interval AND sellable for this plan per
    // TIER_SELLABLE. No silent coercion of an unsupported interval (e.g. annual)
    // down to monthly — an annual Starter/Growth request is rejected outright.
    const rawInterval = typeof body.interval === "string" ? body.interval : "monthly";
    if (!isBillingInterval(rawInterval) || !isSellable(plan as PaidTier, rawInterval)) {
      return NextResponse.json({ error: "invalid_interval" }, { status: 400 });
    }
    const interval: BillingInterval = rawInterval;

    const email = (body.email ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      return NextResponse.json({ error: "invalid_email" }, { status: 400 });
    }

    // Per-email rate limit — enforced after email validation so we key on the
    // canonical (lowercased) form. DB-persisted so it holds across serverless
    // instances / cold starts. Blocks inbox-spam attacks from rotating IPs.
    const rlEmail = await checkRateLimit(
      `sub-signup-email:${email}`,
      EMAIL_RATE_LIMIT,
      EMAIL_RATE_WINDOW_MS,
    );
    if (!rlEmail.allowed) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }

    // Validate websiteUrl + full SSRF guard before creating the Stripe session.
    const validation = validatePublicUrl(body.websiteUrl ?? "");
    if (!validation.ok) {
      return NextResponse.json({ error: "invalid_url" }, { status: 400 });
    }
    const canonicalUrl = validation.url.href;

    // Recurring price id for the requested plan + interval.
    const priceId = STRIPE_PRICE_IDS[interval][plan as "starter" | "growth"];
    if (!priceId) {
      console.error(
        `[subscription-signup/checkout] no price id for ${plan}/${interval} — check STRIPE_*_PRICE_ID env`,
      );
      return NextResponse.json(
        { error: "plan_unavailable_for_interval" },
        { status: 400 },
      );
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const websiteBase = process.env.WEBSITE_URL ?? "https://www.flowblinq.com";

    // Bind websiteUrl to the resolved price id so the webhook can reject any
    // session whose metadata was tampered with (same HMAC scheme as audit-purchase).
    const binding = signCheckoutBinding(canonicalUrl, priceId);
    const metadata = {
      type: "subscription_signup",
      plan,
      interval,
      websiteUrl: canonicalUrl,
      [CHECKOUT_BINDING_METADATA_KEY]: binding,
    };

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      allow_promotion_codes: true,
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true },
      // Stamp metadata on BOTH the session and the subscription so the webhook
      // reads it consistently and renewal/cancel handlers (which key on the
      // subscription's metadata.teamId, back-filled post-provision) keep working.
      subscription_data: { metadata },
      metadata,
      success_url: `${websiteBase}/ai-audit-report/thank-you?session_id={CHECKOUT_SESSION_ID}&plan=${plan}`,
      cancel_url: `${websiteBase}/pricing`,
    });

    console.log(
      JSON.stringify({
        event: "subscription_signup_checkout_created",
        sessionId: session.id,
        plan,
        interval,
        ip,
      }),
    );

    return NextResponse.json({ checkoutUrl: session.url }, { status: 201 });
  } catch (err) {
    console.error("POST /api/subscription-signup/checkout error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
