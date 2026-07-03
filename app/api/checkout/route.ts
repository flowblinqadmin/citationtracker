import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { getAuthenticatedUser } from "@/lib/supabase/authenticated-client";
import { db } from "@/lib/db";
import { teamMembers, teams } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { CREDITS_PER_PACK, CREDITS_PRICE_CENTS, PAGES_PER_CREDIT, STRIPE_PRICE_IDS, SUBSCRIPTION_TIERS, type SubscriptionTier, type BillingInterval } from "@/lib/config";
import { ensureTeamForUser } from "@/lib/services/provision-team";

const SUBSCRIPTION_PLANS = new Set<string>(["starter", "growth", "pro"]);

export async function POST(req: NextRequest) {
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
    const body = await req.json().catch(() => ({})) as {
      returnTo?: string;
      quantity?: number;
      plan?: string;
      interval?: string;
    };
    const appBase = process.env.NEXT_PUBLIC_APP_URL ?? "https://geo.flowblinq.com";
    // Accept only relative paths to prevent open redirects
    const returnTo = typeof body.returnTo === "string" && body.returnTo.startsWith("/")
      ? body.returnTo
      : "/dashboard";

    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json({ error: "Sign in required to purchase credits" }, { status: 401 });
    }

    let [membership] = await db
      .select()
      .from(teamMembers)
      .where(eq(teamMembers.userId, user.id));

    // Auto-provision team if authenticated user has none (OTP verify may have skipped provisioning)
    if (!membership?.teamId) {
      console.warn("[checkout] Auto-provisioning team for user:", user.id, user.email);
      const { teamId } = await ensureTeamForUser(user.id, user.email ?? "", { skipBonus: true });
      [membership] = await db.select().from(teamMembers).where(eq(teamMembers.userId, user.id));
      if (!membership?.teamId) {
        console.error("[checkout] Team provisioning failed for user:", user.id);
        return NextResponse.json(
          { error: "Account setup failed. Please try again." },
          { status: 500 }
        );
      }
    }

    const { plan } = body;

    // ── Subscription checkout ─────────────────────────────────────────────
    if (plan && plan !== "credits") {
      if (plan === "free") {
        return NextResponse.json(
          { error: "Cannot checkout free tier — it requires no payment" },
          { status: 400 },
        );
      }

      if (!SUBSCRIPTION_PLANS.has(plan)) {
        return NextResponse.json(
          { error: `Invalid plan: ${plan}. Valid plans: starter, growth, pro` },
          { status: 400 },
        );
      }

      const interval: BillingInterval =
        body.interval === "annual"      ? "annual"
        : body.interval === "quarterly" ? "quarterly"
        : "monthly";
      const priceId = STRIPE_PRICE_IDS[interval][plan as Exclude<SubscriptionTier, "free">];

      if (!priceId) {
        return NextResponse.json(
          { error: `Plan ${plan} is not available for ${interval} billing` },
          { status: 400 },
        );
      }

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        allow_promotion_codes: true,
        customer_email: user.email ?? undefined,
        line_items: [{ price: priceId, quantity: 1 }],
        subscription_data: {
          metadata: {
            teamId: membership.teamId,
            userId: user.id,
            plan,
          },
        },
        metadata: {
          teamId: membership.teamId,
          userId: user.id,
          plan,
        },
        success_url: `${appBase}${returnTo}${returnTo.includes("?") ? "&" : "?"}payment=success`,
        cancel_url: `${appBase}${returnTo}`,
      });

      return NextResponse.json({ checkoutUrl: session.url });
    }

    // ── One-time credit checkout (existing flow) ──────────────────────────
    // Fix #39: Credit packs require an active subscription. Free-tier teams
    // (OTP signups + audit_purchase auto-teams) must upgrade first.
    const [teamRow] = await db
      .select({ subscriptionTier: teams.subscriptionTier })
      .from(teams)
      .where(eq(teams.id, membership.teamId));
    if (!teamRow || teamRow.subscriptionTier === "free") {
      return NextResponse.json(
        {
          error: "subscription_required",
          message: "Credit packs require an active Starter or higher subscription.",
        },
        { status: 403 },
      );
    }

    const qty = Math.max(1, Math.min(50, Math.floor(Number(body.quantity) || 1)));
    const totalCredits = CREDITS_PER_PACK * qty;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      allow_promotion_codes: true,
      customer_email: user.email ?? undefined,
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: `${totalCredits} GEO Credits`,
              description: `${totalCredits} credits — audit up to ${totalCredits * PAGES_PER_CREDIT} pages`,
            },
            unit_amount: CREDITS_PRICE_CENTS * qty,
          },
          quantity: 1,
        },
      ],
      metadata: {
        teamId: membership.teamId,
        userId: user.id,
        creditPacks: String(qty),
      },
      success_url: `${appBase}${returnTo}${returnTo.includes("?") ? "&" : "?"}payment=success`,
      cancel_url: `${appBase}${returnTo}`,
    });

    return NextResponse.json({ checkoutUrl: session.url });
  } catch (err) {
    console.error("POST /api/checkout error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
