import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createHash } from "crypto";
import { db } from "@/lib/db";
import { teams, teamMembers, creditTransactions, auditPurchases, geoSites } from "@/lib/db/schema";
import { and, eq, isNull, or, sql, type InferInsertModel } from "drizzle-orm";
import { nanoid } from "nanoid";
import { CREDITS_PER_PACK, SUBSCRIPTION_TIERS, STRIPE_PRICE_IDS, FREE_MAX_PAGES, type SubscriptionTier } from "@/lib/config";
import {
  sendSubscriptionConfirmationEmail,
  sendCreditsPurchasedEmail,
  sendSubscriptionRenewalEmail,
  sendPaymentFailedEmail,
  sendSubscriptionCancelledEmail,
  sendInternalPaymentAlert,
  sendAuditPurchaseRefundedEmail,
  sendAuditPurchaseConfirmationEmail,
} from "@/lib/email";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { ensureTeamForUser } from "@/lib/services/provision-team";
import { provisionUserAndTeamFromEmail } from "@/lib/services/provision-from-checkout";
import { resolveFirstAuditMaxPages } from "@/lib/services/page-accounting";
import { validatePublicUrl } from "@/lib/ssrf";
import { normalizeDomain, slugify } from "@/lib/utils";
import { enqueueStage } from "@/lib/qstash";
import {
  verifyCheckoutBinding,
  CHECKOUT_BINDING_METADATA_KEY,
} from "@/lib/checkout-binding";
import { TOKEN_TTL_MS } from "@/lib/constants/token-ttl";

// ── Canonical tier-entitlement writer (FIX-001) ──────────────────────────────
// Every subscription-activation path — signup, authenticated upgrade, invoice
// renewal, and customer.subscription.updated (on a real tier change) — writes
// the SAME entitlement columns, so a team's billing state can never diverge by
// which webhook path last touched it. Single credit-pool model:
//   creditBalance        = tier.credits × billing-interval months
//   monthlyPageAllowance = 0   (audits + credit-gated actions draw from credits)
//   monthlyPagesUsed     = 0
// creditBalance is SET (never incremented) so webhook redeliveries can't stack
// credits, and any leftover OAuth signup bonus is overwritten on first
// subscription (BUG-007). The schema-level discriminated union lands in FIX-018.
function tierEntitlementColumns(tier: { credits: number }, months = 1) {
  return {
    creditBalance: tier.credits * months,
    monthlyPageAllowance: 0,
    monthlyPagesUsed: 0,
  };
}

// FIX-003: a billing cycle can pay for more than one month (quarterly = 3,
// annual = 12). tier.credits is denominated per-month, so the per-cycle grant
// must be multiplied by the number of months the cycle covers, or quarterly/
// annual subscribers receive a 3×–12× under-grant of paid value.

/** Months covered by a signup session's metadata.interval (defaults to 1). */
function billingIntervalMonths(interval: string | null | undefined): number {
  if (interval === "quarterly") return 3;
  if (interval === "annual") return 12;
  return 1;
}

/**
 * Months covered by an invoice line's billing period. Returns 1 when the span
 * can't be determined (e.g. period.start absent) so a renewal never wildly
 * over- or under-grants on incomplete data.
 */
function monthsFromInvoicePeriod(
  period: { start?: number | null; end?: number | null } | undefined | null,
): number {
  const start = period?.start;
  const end = period?.end;
  if (typeof start !== "number" || typeof end !== "number" || end <= start) return 1;
  const SECONDS_PER_MONTH = 30.44 * 24 * 3600;
  return Math.max(1, Math.round((end - start) / SECONDS_PER_MONTH));
}

export async function POST(req: NextRequest) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  const body = await req.text();
  const sig = req.headers.get("stripe-signature");

  if (!sig) {
    return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch (err) {
    console.error("[stripe-webhook] Signature verification failed:", err);
    return NextResponse.json({ error: "Webhook signature verification failed" }, { status: 400 });
  }

  // ── checkout.session.completed ──────────────────────────────────────────
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;

    // ── GMC audit purchase ($10 one-time) ──────────────────────────────────
    if (session.metadata?.type === "audit_purchase") {
      // Blocker B: normalize email — Stripe can deliver mixed-case; lowercase ensures
      // identity deduplication with Google OAuth (which always returns lowercase).
      const customerEmail = (
        session.customer_details?.email ?? session.customer_email ?? ""
      ).trim().toLowerCase();
      const purchaseToken = nanoid(32);

      // Idempotency (FIX-005): short-circuit only when provisioning already
      // SUCCEEDED (teamId stamped). A row still missing teamId means a prior
      // delivery inserted it but provisioning failed and we returned 500 — let
      // Stripe's retry re-attempt provisioning against the SAME row instead of
      // treating the duplicate as done. Re-provisioning is safe: ensureTeamForUser
      // is idempotent and a failed-provisioning row never created a geoSites audit.
      const [existingPurchase] = await db
        .select({ id: auditPurchases.id, teamId: auditPurchases.teamId })
        .from(auditPurchases)
        .where(eq(auditPurchases.stripeSessionId, session.id));

      if (existingPurchase?.teamId) {
        return NextResponse.json({ ok: true, idempotent: true });
      }

      const purchaseId = existingPurchase?.id ?? nanoid();
      const paymentIntentId = typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id ?? null;

      const resolvedAmountCents = session.amount_total ?? session.amount_subtotal ?? 0;
      if (session.amount_total === null || session.amount_total === undefined) {
        console.warn(JSON.stringify({
          event: "audit_purchase_webhook_amount_null",
          sessionId: session.id,
          amount_total: session.amount_total,
          amount_subtotal: session.amount_subtotal,
          resolvedAmountCents,
        }));
      }

      // On a retry the row already exists (status "paid", teamId null); reuse it
      // rather than inserting a duplicate.
      if (!existingPurchase) {
        await db.insert(auditPurchases).values({
          id: purchaseId,
          stripeSessionId: session.id,
          stripePaymentIntentId: paymentIntentId,
          customerEmail,
          purchaseToken,
          purchaseTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
          amountCents: resolvedAmountCents,
          status: "paid",
        });
      }

      // Task 7.2 — Auto-create Supabase user + team, generate magic link.
      // FIX-005: provisioning failure (thrown OR skipped) now returns 500 so Stripe
      // redelivers; only an unrecoverable missing-email skip returns 200 (with an alert).
      // Fix #7: track whether user-provisioning succeeded. If it fails, the pipeline
      // kickoff block below is skipped — creating a team-less geoSites row that the
      // customer can't access from their dashboard is worse than failing loud.
      let userProvisioningSucceeded = false;
      try {
        const supaAdmin = getSupabaseAdmin();
        if (supaAdmin && customerEmail) {
          // Idempotently create the Supabase user.
          let supaUserId: string | undefined;
          const { data: createData, error: createErr } = await supaAdmin.auth.admin.createUser({
            email: customerEmail,
            email_confirm: true,
          });
          if (createErr) {
            if (
              createErr.message?.includes("already been registered") ||
              createErr.message?.includes("already has been registered") ||
              createErr.message?.includes("already registered")
            ) {
              // Blocker D: explicitly look up the existing user before attempting generateLink.
              // If generateLink also fails, supaUserId is still set so team provisioning proceeds.
              // Fix #4: paginate listUsers — the default single call only returns 1000 users.
              // After 1000 Supabase users, a collision lookup would silently miss users on
              // later pages. Paginate until found or all pages exhausted (100 pages = 100k users).
              {
                const PAGE_SIZE = 1000;
                const MAX_PAGES = 100;
                let foundUser: { id: string } | undefined;
                for (let page = 1; page <= MAX_PAGES; page++) {
                  const { data: listData } = await supaAdmin.auth.admin.listUsers({ page, perPage: PAGE_SIZE });
                  const users = listData?.users ?? [];
                  // Case-insensitive match — Supabase stores email in original case,
                  // but customerEmail is already lowercased at the top of this branch.
                  const match = users.find(
                    (u) => typeof u.email === "string" && u.email.toLowerCase() === customerEmail
                  );
                  if (match) {
                    foundUser = match;
                    break;
                  }
                  // Stop early if we've seen all users (last page or empty page)
                  const pagination = (listData as { nextPage?: number | null } | undefined);
                  if (users.length < PAGE_SIZE || pagination?.nextPage == null) break;
                }
                if (foundUser?.id) {
                  supaUserId = foundUser.id;
                } else {
                  // listUsers did not find them — log for ops, fall through to generateLink attempt
                  console.warn("[stripe-webhook] createUser collision but listUsers found no match for email hash");
                }
              }
            } else {
              throw new Error(`createUser failed: ${createErr.message}`);
            }
          } else {
            supaUserId = createData.user.id;
          }

          // Generate magic link. On collision path supaUserId may already be set — generateLink
          // still runs to produce the onboarding link, but a failure no longer blocks team provisioning.
          const appBase = process.env.NEXT_PUBLIC_APP_URL ?? "https://geo.flowblinq.com";
          const { data: linkData, error: linkErr } = await supaAdmin.auth.admin.generateLink({
            type: "magiclink",
            email: customerEmail,
            options: { redirectTo: `${appBase}/dashboard?onboard=install` },
          });
          if (linkErr) {
            // Non-fatal if we already have supaUserId from createUser or listUsers
            console.warn(`[stripe-webhook] generateLink failed (continuing with supaUserId=${supaUserId ?? "undefined"}): ${linkErr.message}`);
          }
          if (!supaUserId && linkData?.user?.id) {
            supaUserId = linkData.user.id;
          }
          const actionLink = linkData?.properties?.action_link ?? null;

          // Provision team with ZERO credits (skipBonus: true).
          // Product decision: $10 buys exactly one audit. After delivery the team
          // has 0 credits so any further action (rerun, regenerate, retry) hits
          // the standard recharge flow — same gating as a free-tier OTP signup.
          // The paid audit itself remains viewable; it doesn't cost credits to read.
          let teamId: string | undefined;
          if (supaUserId) {
            const provision = await ensureTeamForUser(supaUserId, customerEmail, { skipBonus: true });
            teamId = provision.teamId;
          }

          // Stamp userId, teamId, magicLink on the auditPurchases row.
          // magicLinkExpiresAt = now + 1 hour (Supabase default magic link TTL).
          await db.update(auditPurchases).set({
            userId: supaUserId ?? null,
            teamId: teamId ?? null,
            // SECURITY: magicLink is stored but NEVER logged
            magicLink: actionLink ?? null,
            magicLinkExpiresAt: actionLink ? new Date(Date.now() + 60 * 60 * 1000) : null,
            updatedAt: new Date(),
          }).where(eq(auditPurchases.id, purchaseId));
          userProvisioningSucceeded = true;
        }
      } catch (userProvisionErr) {
        // Non-fatal — log + alert ops, but do NOT block the webhook (return 200 to Stripe)
        // Fix #7: userProvisioningSucceeded stays false → pipeline kickoff will be skipped.
        console.error("[stripe-webhook] audit_purchase user provisioning failed:", userProvisionErr);
        sendInternalPaymentAlert({
          customerEmail,
          type: "audit_purchase_pipeline_skipped_due_to_provision_failure",
          domain: "n/a",
          note: `User provision failed at webhook: ${String(userProvisionErr).slice(0, 200)}`,
          timestamp: new Date().toISOString(),
        }).catch((e) => console.warn("[stripe-webhook] provision fail alert failed:", e));
        // FIX-005: return 500 so Stripe redelivers the event with backoff. The paid
        // auditPurchases row is already persisted, and the provisioning-aware
        // idempotency guard above lets the retry re-attempt provisioning against the
        // same row (no duplicate charge — Stripe retries the WEBHOOK, not the charge).
        return NextResponse.json({ error: "provision_failed" }, { status: 500 });
      }

      // Task 18 — kick off the pipeline directly from the webhook so we don't depend
      // on the customer's browser successfully POSTing to /intake. Defensive against
      // marketing-site bugs and customers who close the tab right after paying.
      //
      // Fix #7: only kick off the pipeline if user-provisioning succeeded. If it failed,
      // creating a team-less geoSites row that the customer can't access from their
      // dashboard is worse than failing loud. The ops alert above already notified
      // the team — they can manually re-fire intake after fixing the Supabase issue.
      if (!userProvisioningSucceeded) {
        // FIX-005: provisioning was SKIPPED without throwing — getSupabaseAdmin()
        // returned null (admin misconfigured) or customerEmail was empty. This is the
        // same paid-but-no-account loss as a thrown failure, so signal it loudly
        // instead of falling through to a 200. (A thrown failure already returned 500
        // from the catch above and never reaches here.)
        const skipReason = !customerEmail ? "missing_customer_email" : "supabase_admin_unavailable";
        console.error(JSON.stringify({
          event: "audit_purchase_provisioning_incomplete",
          sessionId: session.id,
          reason: skipReason,
        }));
        sendInternalPaymentAlert({
          customerEmail: customerEmail || "(unknown)",
          type: "audit_purchase_failed",
          domain: "n/a",
          note: `Provisioning skipped (${skipReason}) — paid audit not delivered`,
          timestamp: new Date().toISOString(),
        }).catch((e) => console.warn("[stripe-webhook] provision skip alert failed:", e));
        // A missing email cannot be fixed by retrying; an unavailable admin can. Only
        // ask Stripe to redeliver the event when a retry could actually succeed.
        if (customerEmail) {
          return NextResponse.json({ error: "provision_unavailable" }, { status: 500 });
        }
        return NextResponse.json({ ok: true, skipped: "no_customer_email" });
      } else {
      try {
        const webhookWebsiteUrl = session.metadata?.websiteUrl;
        // H4 (2026-05-27 audit): verify the HMAC binding stamped at checkout
        // creation. Rejects sessions whose websiteUrl was tampered after the
        // session was created (Stripe Connect / publishable-key compromise).
        //
        // The binding is enforced only when STRIPE_AUDIT_PRICE_ID is
        // configured — which is always true in production (the checkout
        // route refuses to create a session without it, see
        // app/api/audit-purchase/checkout/route.ts:14-18). When unset (test
        // / dev), the binding check is bypassed because no real sessions
        // can exist in that state anyway.
        const stripeAuditPriceId = process.env.STRIPE_AUDIT_PRICE_ID;
        const bindingSignature = session.metadata?.[CHECKOUT_BINDING_METADATA_KEY];
        const bindingEnforced = !!stripeAuditPriceId;
        const bindingOk =
          !bindingEnforced ||
          (!!webhookWebsiteUrl &&
            verifyCheckoutBinding(
              webhookWebsiteUrl,
              stripeAuditPriceId!,
              bindingSignature,
            ));
        if (bindingEnforced && webhookWebsiteUrl && !bindingOk) {
          console.error(
            JSON.stringify({
              event: "audit_purchase_binding_rejected",
              sessionId: session.id,
              hasSignature: !!bindingSignature,
            }),
          );
        }
        if (webhookWebsiteUrl && bindingOk) {
          // SSRF-validate the metadata value (defense-in-depth — already validated at
          // checkout time, but Stripe metadata could theoretically be tampered via API).
          const validation = validatePublicUrl(webhookWebsiteUrl);
          if (validation.ok) {
            const domain = normalizeDomain(validation.url.href);
            const siteId = nanoid();
            const slug = slugify(domain) + "-" + nanoid(6);
            // FIX-002: reservation crawl budget and the enqueued crawl budget MUST be
            // the same value so divergence is impossible.
            const auditPurchaseCrawlLimit = 250;

            // Fetch current teamId from auditPurchases (stamped by user-provisioning above).
            const [currentPurchase] = await db
              .select({ teamId: auditPurchases.teamId })
              .from(auditPurchases)
              .where(eq(auditPurchases.id, purchaseId));

            // Create the geoSites row, stamping teamId from the just-provisioned team.
            await db.insert(geoSites).values({
              id: siteId,
              domain,
              slug,
              ownerEmail: customerEmail,
              emailVerified: true,
              accessToken: nanoid(32),
              // H3 (2026-05-27 audit): download-report + pdf-report now
              // enforce tokenExpiresAt; must stamp a future expiry here so
              // post-purchase customers aren't 401'd on first download.
              tokenExpiresAt: new Date(Date.now() + TOKEN_TTL_MS),
              pipelineStatus: "pending",
              crawlLimit: auditPurchaseCrawlLimit,
              freeRunNumber: 1,
              freeOptimizationUsed: false,
              ...(currentPurchase?.teamId ? { teamId: currentPurchase.teamId } : {}),
            });

            // Stamp siteId on auditPurchases — this is what /intake checks for idempotency.
            await db.update(auditPurchases).set({
              siteId,
              domain,
              status: "intake_complete",
              updatedAt: new Date(),
            }).where(eq(auditPurchases.id, purchaseId));

            // Enqueue the pipeline. FIX-002: pass maxPages so handleDiscover does not
            // fall back to FREE_MAX_PAGES (20) and silently crawl 20 of the paid 250.
            await enqueueStage({ siteId, domain, stage: "discover", maxPages: auditPurchaseCrawlLimit });

            // Confirmation email (matches what /intake sends today).
            try {
              await sendAuditPurchaseConfirmationEmail(customerEmail, domain);
            } catch (emailErr) {
              console.error("[stripe-webhook] audit_purchase confirmation email failed:", emailErr);
            }

            const kickoffEmailHash = createHash("sha256").update(customerEmail).digest("hex").slice(0, 16);
            console.log(JSON.stringify({
              event: "audit_purchase_pipeline_kickoff",
              sessionId: session.id,
              siteId,
              domain,
              emailHash: kickoffEmailHash,
            }));
          } else {
            console.error("[stripe-webhook] audit_purchase websiteUrl failed SSRF validation:", validation.error);
          }
        } else {
          console.warn("[stripe-webhook] audit_purchase missing metadata.websiteUrl — pipeline cannot start from webhook");
        }
      } catch (pipelineErr) {
        console.error("[stripe-webhook] audit_purchase pipeline kickoff failed (non-fatal):", pipelineErr);
        // Non-fatal: customer's auditPurchases row exists, magic link works for sign-in.
        // Operator can manually re-fire intake if needed.
      }
      } // end else (userProvisioningSucceeded)

      // Fix I: redact PII from structured logs (PIPEDA) — hash email, never log raw
      const emailHash = createHash("sha256").update(customerEmail).digest("hex").slice(0, 16);
      console.log(
        JSON.stringify({
          event: "audit_purchase_webhook_processed",
          sessionId: session.id,
          emailHash,
        }),
      );

      sendInternalPaymentAlert({
        customerEmail,
        type: "audit_purchase",
        planName: "AI Visibility Audit ($10)",
        timestamp: new Date().toISOString(),
      }).catch((e) =>
        console.warn("[stripe-webhook] audit purchase internal alert failed:", e),
      );

      return NextResponse.json({ ok: true });
    }

    // ── Payment-first subscription signup (unauthenticated) ─────────────────
    // From /api/subscription-signup/checkout: no teamId exists yet. Provision the
    // account here (mirrors the $10 audit-purchase pattern), grant the credit pool,
    // back-fill teamId onto the Stripe subscription so renewals work, and kick off
    // the first audit with proper credit deduction. The authenticated-upgrade path
    // below (teamId already in metadata) is unchanged.
    if (session.mode === "subscription" && session.metadata?.type === "subscription_signup") {
      const appBase = process.env.NEXT_PUBLIC_APP_URL ?? "https://geo.flowblinq.com";
      const plan = session.metadata?.plan as SubscriptionTier | undefined;
      const interval = session.metadata?.interval === "quarterly" ? "quarterly" : "monthly";

      // FIX-006: restrict to the plans the signup checkout actually offers
      // (starter|growth) BEFORE indexing STRIPE_PRICE_IDS[interval][plan] below.
      // The `plan in SUBSCRIPTION_TIERS` check alone would let a tampered "pro" pass
      // and index the price map with an inconsistent id; the `plan as "starter"|"growth"`
      // cast at the priceId lookup hid the missing runtime guard. Matches the checkout
      // route's SIGNUP_PLANS set. Defense-in-depth.
      if (!plan || (plan !== "starter" && plan !== "growth")) {
        console.error("[stripe-webhook] subscription_signup invalid plan:", JSON.stringify(session.metadata));
        return NextResponse.json({ received: true, skipped: "invalid_metadata" }, { status: 200 });
      }

      const subscriptionId = session.subscription as string;
      const customerEmail = (
        session.customer_details?.email ?? session.customer_email ?? ""
      ).trim().toLowerCase();

      // Idempotency: if a team already carries this subscription, we've processed it.
      if (subscriptionId) {
        const [existingTeam] = await db
          .select({ id: teams.id })
          .from(teams)
          .where(eq(teams.stripeSubscriptionId, subscriptionId));
        if (existingTeam) {
          return NextResponse.json({ ok: true, idempotent: true });
        }
      }

      // NEW-W-06: session.id dedup marker — catches concurrent deliveries that race
      // past the subscriptionId guard (both deliveries check before either commits the
      // stripeSubscriptionId write). Reuses the creditTransactions.siteId dedup key
      // established by the topup path (same table, same siteId=session.id pattern).
      // type="topup" with creditsChanged=0 is the minimal existing-type marker;
      // the row is written AFTER activation so a failure before that is naturally
      // retriable via the subscriptionId guard.
      {
        const [existingMarker] = await db
          .select({ id: creditTransactions.id })
          .from(creditTransactions)
          .where(and(eq(creditTransactions.siteId, session.id), eq(creditTransactions.type, "topup")));
        if (existingMarker) {
          return NextResponse.json({ ok: true, idempotent: true });
        }
      }

      // Verify the HMAC binding on websiteUrl against the recomputed price id
      // (defense-in-depth — same scheme as audit-purchase).
      const websiteUrl = session.metadata?.websiteUrl;
      const priceId = STRIPE_PRICE_IDS[interval][plan]; // plan narrowed to "starter"|"growth" by the guard above
      const bindingSig = session.metadata?.[CHECKOUT_BINDING_METADATA_KEY];
      const bindingOk =
        !!priceId && !!websiteUrl && verifyCheckoutBinding(websiteUrl, priceId, bindingSig);

      // Provision Supabase user + team + magic link (never throws).
      const provision = await provisionUserAndTeamFromEmail(customerEmail, {
        redirectTo: `${appBase}/dashboard?welcome=1`,
      });
      if (!provision.succeeded || !provision.teamId) {
        console.error("[stripe-webhook] subscription_signup provisioning failed for session", session.id);
        sendInternalPaymentAlert({
          customerEmail,
          type: "subscription",
          planName: SUBSCRIPTION_TIERS[plan].name,
          note: "subscription_signup_provision_failed — paid subscription but account provisioning failed, manual follow-up needed",
          timestamp: new Date().toISOString(),
        }).catch((e) => console.warn("[stripe-webhook] provision fail alert failed:", e));
        // FIX-005: return 500 so Stripe redelivers the event. provisionUserAndTeamFromEmail
        // never throws and is idempotent, and the subscription-idempotency guard above
        // (keyed on teams.stripeSubscriptionId, only set after successful activation)
        // makes the retry safe — a transient Supabase/DB blip no longer permanently
        // drops a paid subscription.
        return NextResponse.json({ error: "provision_failed" }, { status: 500 });
      }

      const teamId = provision.teamId;
      const tier = SUBSCRIPTION_TIERS[plan];

      // NEW-A-01: reconcile-don't-clobber — before blindly overwriting billing
      // fields, check whether the resolved team already has an ACTIVE subscription
      // with a DIFFERENT stripeSubscriptionId. That would mean provisionUserAndTeamFromEmail
      // returned an existing team (returning customer) whose live sub would be silently
      // overwritten, orphaning their existing subscription and wiping their credit balance.
      // If a conflict is detected: alert ops for manual follow-up and return 200 (so
      // Stripe doesn't retry — the retry would clobber again). Only activate when the
      // team is new/inactive or carries the same subscriptionId (safe re-activation).
      if (subscriptionId) {
        const [existingBilling] = await db
          .select({
            subscriptionStatus: teams.subscriptionStatus,
            stripeSubscriptionId: teams.stripeSubscriptionId,
          })
          .from(teams)
          .where(eq(teams.id, teamId));

        if (
          existingBilling &&
          existingBilling.subscriptionStatus === "active" &&
          existingBilling.stripeSubscriptionId &&
          existingBilling.stripeSubscriptionId !== subscriptionId
        ) {
          // Clobber conflict: team has an active different subscription.
          // Do NOT overwrite — alert ops and let them reconcile manually.
          const emailHashForAlert = customerEmail ? customerEmail.slice(0, 3) + "***" : "(unknown)";
          console.error(JSON.stringify({
            event: "subscription_signup_clobber_conflict",
            sessionId: session.id,
            newSubscriptionId: subscriptionId,
            existingSubscriptionId: existingBilling.stripeSubscriptionId,
            teamId,
          }));
          sendInternalPaymentAlert({
            customerEmail,
            type: "subscription",
            planName: tier.name,
            note: `subscription_signup_clobber_conflict — team ${teamId} already has active sub ${existingBilling.stripeSubscriptionId}; new sub ${subscriptionId} NOT activated. Manual follow-up required.`,
            timestamp: new Date().toISOString(),
          }).catch((e) => console.warn("[stripe-webhook] clobber conflict alert failed:", e));
          void emailHashForAlert; // used only in log above
          return NextResponse.json({ ok: true, skipped: "clobber_conflict" });
        }
      }

      // Activate subscription via the canonical credit-pool writer (FIX-001) so
      // signup, authenticated upgrade, renewal, and subscription.updated all set
      // the identical entitlement columns. creditBalance is SET, never incremented.
      await db.update(teams).set({
        subscriptionTier: plan,
        subscriptionStatus: "active",
        stripeCustomerId: session.customer as string,
        stripeSubscriptionId: subscriptionId,
        ...tierEntitlementColumns(tier, billingIntervalMonths(interval)),
        updatedAt: new Date(),
      }).where(eq(teams.id, teamId));

      // NEW-W-06: write the session.id dedup marker so concurrent/racing redeliveries
      // that reach the NEW-W-06 guard before the stripeSubscriptionId commit is visible
      // are caught and short-circuited. type="topup" with creditsChanged=0 reuses the
      // established creditTransactions.siteId=session.id dedup key without a schema change.
      // Non-fatal: if this insert fails, the stripeSubscriptionId guard still catches retries.
      try {
        await db.insert(creditTransactions).values({
          id: nanoid(),
          teamId,
          siteId: session.id,
          type: "topup",
          pagesConsumed: 0,
          creditsChanged: 0,
          balanceBefore: 0,
          balanceAfter: 0,
          createdAt: new Date(),
        });
      } catch (markerErr) {
        // Duplicate key = another concurrent delivery already inserted it — safe to ignore.
        console.warn("[stripe-webhook] subscription_signup dedup marker insert failed (non-fatal):", markerErr);
      }

      // REQUIRED: back-fill teamId onto the subscription so invoice.paid /
      // customer.subscription.* renewal handlers (which key on
      // subscription.metadata.teamId) refresh the credit pool each cycle.
      if (subscriptionId) {
        try {
          await stripe.subscriptions.update(subscriptionId, {
            metadata: { teamId, plan, type: "subscription_signup" },
          });
        } catch (e) {
          console.error("[stripe-webhook] subscription_signup metadata back-fill failed:", e);
        }
      }

      // Confirmation email — pass the magic link as the CTA so the (not-yet-logged-in)
      // buyer signs in passwordlessly straight from the email.
      if (customerEmail) {
        sendSubscriptionConfirmationEmail(customerEmail, {
          planName: tier.name,
          pageAllowance: tier.pages,
          dashboardUrl: provision.magicLink ?? `${appBase}/dashboard`,
        }).catch((e) => console.warn("[stripe-webhook] subscription confirm email failed:", e));
        sendInternalPaymentAlert({
          customerEmail,
          type: "subscription",
          planName: tier.name,
          timestamp: new Date().toISOString(),
        }).catch((e) => console.warn("[stripe-webhook] internal payment alert failed:", e));
      }

      // Auto-run the first audit — page-capped + credits deducted (NOT the $10
      // path's hardcoded 250 free-pass).
      if (websiteUrl && bindingOk) {
        try {
          const validation = validatePublicUrl(websiteUrl);
          if (validation.ok) {
            const [freshTeam] = await db
              .select({
                monthlyPageAllowance: teams.monthlyPageAllowance,
                monthlyPagesUsed: teams.monthlyPagesUsed,
                creditBalance: teams.creditBalance,
                subscriptionTier: teams.subscriptionTier,
                subscriptionStatus: teams.subscriptionStatus,
              })
              .from(teams)
              .where(eq(teams.id, teamId));

            const budget = resolveFirstAuditMaxPages({
              monthlyPageAllowance: freshTeam.monthlyPageAllowance,
              monthlyPagesUsed: freshTeam.monthlyPagesUsed,
              creditBalance: freshTeam.creditBalance,
              subscriptionTier: freshTeam.subscriptionTier,
              subscriptionStatus: freshTeam.subscriptionStatus,
            });

            if (!budget.denied && budget.maxPages > 0) {
              const domain = normalizeDomain(validation.url.href);
              const siteId = nanoid();
              const slug = slugify(domain) + "-" + nanoid(6);
              const now = new Date();

              await db.transaction(async (tx) => {
                await tx.insert(geoSites).values({
                  id: siteId,
                  domain,
                  slug,
                  ownerEmail: customerEmail,
                  emailVerified: true,
                  accessToken: nanoid(32),
                  tokenExpiresAt: new Date(Date.now() + TOKEN_TTL_MS),
                  pipelineStatus: "pending",
                  crawlLimit: budget.maxPages,
                  freeRunNumber: 1,
                  freeOptimizationUsed: false,
                  teamId,
                  creditsReserved: budget.creditsToReserve,
                });

                if (budget.subscriptionPages > 0) {
                  await tx.update(teams).set({
                    monthlyPagesUsed: sql`${teams.monthlyPagesUsed} + ${budget.subscriptionPages}`,
                    updatedAt: now,
                  }).where(eq(teams.id, teamId));
                }

                if (budget.creditsToReserve > 0) {
                  await tx.update(teams).set({
                    creditBalance: sql`${teams.creditBalance} - ${budget.creditsToReserve}`,
                    updatedAt: now,
                  }).where(eq(teams.id, teamId));

                  await tx.insert(creditTransactions).values({
                    id: nanoid(),
                    teamId,
                    siteId,
                    type: "crawl_reserve",
                    pagesConsumed: budget.maxPages,
                    creditsChanged: -budget.creditsToReserve,
                    balanceBefore: freshTeam.creditBalance,
                    balanceAfter: freshTeam.creditBalance - budget.creditsToReserve,
                    createdAt: now,
                  });
                }
              });

              // FIX-002: pass the SAME budget that was reserved/charged above so the
              // first audit crawls budget.maxPages, not the FREE_MAX_PAGES (20) fallback.
              await enqueueStage({ siteId, domain, stage: "discover", maxPages: budget.maxPages });
              try {
                await sendAuditPurchaseConfirmationEmail(customerEmail, domain);
              } catch (emailErr) {
                console.error("[stripe-webhook] subscription_signup confirmation email failed:", emailErr);
              }
            } else {
              console.warn("[stripe-webhook] subscription_signup first audit denied by budget (no credits) — skipping kickoff");
            }
          } else {
            console.error("[stripe-webhook] subscription_signup websiteUrl failed SSRF validation:", validation.error);
          }
        } catch (kickoffErr) {
          console.error("[stripe-webhook] subscription_signup first audit kickoff failed (non-fatal):", kickoffErr);
        }
      } else if (websiteUrl && !bindingOk) {
        console.error(JSON.stringify({
          event: "subscription_signup_binding_rejected",
          sessionId: session.id,
          hasSignature: !!bindingSig,
        }));
      }

      const signupEmailHash = createHash("sha256").update(customerEmail).digest("hex").slice(0, 16);
      console.log(JSON.stringify({
        event: "subscription_signup_processed",
        sessionId: session.id,
        plan,
        interval,
        emailHash: signupEmailHash,
      }));

      return NextResponse.json({ ok: true });
    }

    // Subscription checkout
    if (session.mode === "subscription") {
      const teamId = session.metadata?.teamId;
      const userId = session.metadata?.userId;
      const plan = session.metadata?.plan as SubscriptionTier | undefined;

      if (!teamId || !plan || !(plan in SUBSCRIPTION_TIERS) || plan === "free") {
        console.error("[stripe-webhook] Invalid subscription metadata:", JSON.stringify(session.metadata));
        return NextResponse.json({ received: true, skipped: "invalid_metadata" }, { status: 200 });
      }

      const subscriptionId = session.subscription as string;

      // FIX-005: idempotency guard — the audit_purchase, subscription_signup, and
      // credit-topup branches all have one; this authenticated-upgrade branch did
      // not. A Stripe redelivery would otherwise re-run the activation SET below and
      // re-zero monthlyPagesUsed mid-cycle, handing the subscriber a full extra page
      // allowance (quota leak). Skip if this subscription is already recorded.
      const [existingSub] = await db
        .select({ stripeSubscriptionId: teams.stripeSubscriptionId })
        .from(teams)
        .where(eq(teams.id, teamId));
      if (existingSub?.stripeSubscriptionId === subscriptionId) {
        return NextResponse.json({ ok: true, idempotent: true });
      }

      // CRIT-1 fix: verify userId is still a member of the team
      if (userId) {
        const [member] = await db
          .select({ id: teamMembers.id })
          .from(teamMembers)
          .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
        if (!member) {
          console.error("[stripe-webhook] User not a member of team:", { userId, teamId });
          return NextResponse.json({ received: true, skipped: "user_not_member" }, { status: 200 });
        }
      }

      const tier = SUBSCRIPTION_TIERS[plan];

      // FIX-001: route through the canonical credit-pool writer. Previously this
      // branch used a divergent page-allowance model (monthlyPageAllowance=tier.pages
      // + ZERO credits), which left every credit-gated action denied and any OAuth
      // signup bonus intact. Now identical to the signup/renewal paths.
      await db.update(teams).set({
        subscriptionTier: plan,
        stripeCustomerId: session.customer as string,
        stripeSubscriptionId: subscriptionId,
        subscriptionStatus: "active",
        ...tierEntitlementColumns(tier),
        updatedAt: new Date(),
      }).where(eq(teams.id, teamId));

      const appBase = process.env.NEXT_PUBLIC_APP_URL ?? "https://geo.flowblinq.com";
      const customerEmail = session.customer_email ?? undefined;
      if (customerEmail) {
        sendSubscriptionConfirmationEmail(customerEmail, {
          planName: tier.name,
          pageAllowance: tier.pages,
          dashboardUrl: `${appBase}/dashboard`,
        }).catch((e) => console.warn("[stripe-webhook] subscription confirm email failed:", e));
        sendInternalPaymentAlert({
          customerEmail,
          type: "subscription",
          planName: tier.name,
          timestamp: new Date().toISOString(),
        }).catch((e) => console.warn("[stripe-webhook] internal payment alert failed:", e));
      }

      return NextResponse.json({ ok: true });
    }

    // One-time payment (existing credit flow)
    const teamId = session.metadata?.teamId;
    const userId = session.metadata?.userId;

    if (!teamId || !userId) {
      console.error("[stripe-webhook] CRITICAL: Missing teamId or userId in metadata. Session:", session.id, "metadata:", JSON.stringify(session.metadata));
      return NextResponse.json({ error: "Missing team or user context" }, { status: 500 });
    }

    try {
      const rawQty = parseInt(session.metadata?.creditPacks ?? "1", 10);
      const quantity = (Number.isFinite(rawQty) && rawQty >= 1 && rawQty <= 50) ? rawQty : 1;
      const creditsAdded = CREDITS_PER_PACK * quantity;

      // MED-2 fix: idempotency — skip if this session was already processed
      const [existing] = await db
        .select({ id: creditTransactions.id })
        .from(creditTransactions)
        .where(and(eq(creditTransactions.siteId, session.id), eq(creditTransactions.type, "topup")));
      if (existing) {
        return NextResponse.json({ ok: true, idempotent: true });
      }

      await db.transaction(async (tx) => {
        // Re-verify userId is still a member of teamId — don't trust metadata alone
        const [member] = await tx
          .select({ id: teamMembers.id })
          .from(teamMembers)
          .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
        if (!member) throw new Error(`User ${userId} is not a member of team ${teamId}`);

        const [team] = await tx
          .select({ creditBalance: teams.creditBalance })
          .from(teams)
          .where(eq(teams.id, teamId));
        if (!team) throw new Error("Team not found: " + teamId);

        const balanceBefore = team.creditBalance;

        // MED-1 fix: atomic increment to prevent lost updates under concurrency
        await tx.update(teams).set({
          creditBalance: sql`${teams.creditBalance} + ${creditsAdded}`,
          updatedAt: new Date(),
        }).where(eq(teams.id, teamId));

        // Read back actual balance for ledger
        const [updated] = await tx
          .select({ creditBalance: teams.creditBalance })
          .from(teams)
          .where(eq(teams.id, teamId));

        await tx.insert(creditTransactions).values({
          id: nanoid(),
          teamId,
          siteId: session.id,
          type: "topup",
          pagesConsumed: 0,
          creditsChanged: creditsAdded,
          balanceBefore,
          balanceAfter: updated?.creditBalance ?? balanceBefore + creditsAdded,
          createdAt: new Date(),
        });
      });
      // Send credits confirmation emails (after DB commit, non-blocking)
      const creditsCustomerEmail = session.customer_email ?? undefined;
      if (creditsCustomerEmail) {
        const appBase2 = process.env.NEXT_PUBLIC_APP_URL ?? "https://geo.flowblinq.com";
        // Read current balance for the confirmation email
        db.select({ creditBalance: teams.creditBalance }).from(teams).where(eq(teams.id, teamId))
          .then(([teamRow]) => {
            sendCreditsPurchasedEmail(creditsCustomerEmail, {
              creditsAdded,
              newBalance: teamRow?.creditBalance ?? creditsAdded,
              dashboardUrl: `${appBase2}/dashboard`,
            }).catch((e) => console.warn("[stripe-webhook] credits confirm email failed:", e));
          })
          .catch(() => {
            sendCreditsPurchasedEmail(creditsCustomerEmail, {
              creditsAdded,
              newBalance: creditsAdded,
              dashboardUrl: `${appBase2}/dashboard`,
            }).catch((e) => console.warn("[stripe-webhook] credits confirm email failed:", e));
          });
        sendInternalPaymentAlert({
          customerEmail: creditsCustomerEmail,
          type: "credits",
          creditsAdded,
          timestamp: new Date().toISOString(),
        }).catch((e) => console.warn("[stripe-webhook] internal payment alert failed:", e));
      }
    } catch (err) {
      console.error("[stripe-webhook] Credit application failed:", err);
      return NextResponse.json({ error: "Internal error" }, { status: 500 });
    }
  }

  // ── invoice.paid (subscription renewal) ─────────────────────────────────
  if (event.type === "invoice.paid") {
    const invoice = event.data.object as Stripe.Invoice;

    if (invoice.billing_reason === "subscription_cycle" || invoice.billing_reason === "subscription_create") {
      // Round 3 TS fix (2026-04-10): Stripe SDK v20 moved `invoice.subscription`
      // and `invoice.subscription_details` under `invoice.parent.subscription_details`.
      // The previous cast `(invoice as unknown as {subscription_details?: ...})
      // .subscription_details?.metadata?.teamId` compiled but returned `undefined`
      // at runtime since Stripe v20, silently killing the "refresh page allowance
      // on renewal" branch. Fixed by reading from the proper v20 location.
      const subDetails = invoice.parent?.subscription_details;
      const teamId = subDetails?.metadata?.teamId;
      const subscriptionRef = subDetails?.subscription;
      const subscriptionId = typeof subscriptionRef === "string"
        ? subscriptionRef
        : subscriptionRef?.id ?? null;

      if (teamId) {
        const periodEnd = invoice.lines?.data?.[0]?.period?.end;
        // Refresh page allowance on renewal so subscribers on old pricing get corrected
        const [team] = await db
          .select({ subscriptionTier: teams.subscriptionTier })
          .from(teams)
          .where(eq(teams.id, teamId));
        const currentTier = team?.subscriptionTier && team.subscriptionTier !== "free"
          ? SUBSCRIPTION_TIERS[team.subscriptionTier as SubscriptionTier]
          : null;
        const whereClause = subscriptionId
          ? and(eq(teams.id, teamId), eq(teams.stripeSubscriptionId, subscriptionId))
          : eq(teams.id, teamId);
        await db.update(teams).set({
          monthlyPagesUsed: 0,
          currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
          // Credit-pool model (FIX-001): refresh the credit balance each cycle via
          // the canonical writer and keep the page allowance at 0 so audits + actions
          // all draw from credits. Without this a renewing subscriber would pay but
          // receive no new credits.
          ...(currentTier && tierEntitlementColumns(currentTier, monthsFromInvoicePeriod(invoice.lines?.data?.[0]?.period))),
          updatedAt: new Date(),
        }).where(whereClause);

        // Renewal confirmation email
        const renewalCustomerEmail = (invoice as unknown as { customer_email?: string }).customer_email ?? undefined;
        if (renewalCustomerEmail) {
          const [teamRow] = await db.select({
            subscriptionTier: teams.subscriptionTier,
            monthlyPageAllowance: teams.monthlyPageAllowance,
          }).from(teams).where(eq(teams.id, teamId));

          const appBase = process.env.NEXT_PUBLIC_APP_URL ?? "https://geo.flowblinq.com";
          const tierInfo = teamRow?.subscriptionTier ? SUBSCRIPTION_TIERS[teamRow.subscriptionTier as SubscriptionTier] : null;
          // NEW-W-05: use periodEnd directly as the next-renewal date. periodEnd IS the end
          // of the just-paid billing period, which is exactly when Stripe will charge next.
          // The prior +2678400 s (+31 days) offset was wrong for quarterly/annual subscribers
          // (would report a month past their actual next charge date).
          const nextDate = periodEnd
            ? new Date(periodEnd * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
            : "next month";

          sendSubscriptionRenewalEmail(renewalCustomerEmail, {
            planName: tierInfo?.name ?? "your plan",
            // FIX-005: report the tier's page allowance, NOT the credit-pool column
            // (which is 0 in this model). Reading monthlyPageAllowance told renewing
            // subscribers they had "0 pages", contradicting the signup email which
            // uses tier.pages. Match it.
            pageAllowance: tierInfo?.pages ?? 0,
            nextRenewalDate: nextDate,
            dashboardUrl: `${appBase}/dashboard`,
          }).catch((e) => console.warn("[stripe-webhook] renewal email failed:", e));
          sendInternalPaymentAlert({
            customerEmail: renewalCustomerEmail,
            type: "subscription",
            planName: tierInfo?.name ?? "unknown",
            timestamp: new Date().toISOString(),
          }).catch((e) => console.warn("[stripe-webhook] internal renewal alert failed:", e));
        }
      }
    }
  }

  // ── invoice.payment_failed — mark subscription as past_due ───────────────
  if (event.type === "invoice.payment_failed") {
    const invoice = event.data.object as Stripe.Invoice;
    // Round 3 TS fix (2026-04-10): Stripe v20 path change — same as above.
    const failedSubscriptionRef = invoice.parent?.subscription_details?.subscription;
    if (failedSubscriptionRef) {
      const subscriptionId = typeof failedSubscriptionRef === "string" ? failedSubscriptionRef : failedSubscriptionRef.id;
      const invoiceTeamId = invoice.parent?.subscription_details?.metadata?.teamId;
      const subscription = invoiceTeamId ? null : await stripe.subscriptions.retrieve(subscriptionId);
      let teamId = invoiceTeamId ?? subscription?.metadata?.teamId;

      // FIX-004: metadata.teamId can be missing on BOTH the invoice and the
      // subscription (e.g. subs created before the teamId back-fill). Fall back to
      // a DB lookup by stripeSubscriptionId — as the renewal/deleted handlers do —
      // so a declined card still moves the team to past_due instead of silently
      // no-opping and leaving the team "active" with full credit access.
      if (!teamId) {
        const [bySub] = await db
          .select({ id: teams.id })
          .from(teams)
          .where(eq(teams.stripeSubscriptionId, subscriptionId));
        teamId = bySub?.id;
      }

      if (teamId) {
        const newStatus = subscription?.status ?? "past_due";
        await db.update(teams).set({
          subscriptionStatus: newStatus,
          updatedAt: new Date(),
        }).where(and(eq(teams.id, teamId), eq(teams.stripeSubscriptionId, subscriptionId)));

        const customerEmail = typeof invoice.customer_email === "string" ? invoice.customer_email : undefined;
        if (customerEmail) {
          const [failedTeam] = await db.select({ subscriptionTier: teams.subscriptionTier }).from(teams).where(eq(teams.id, teamId));
          const appBase = process.env.NEXT_PUBLIC_APP_URL ?? "https://geo.flowblinq.com";
          sendPaymentFailedEmail(customerEmail, {
            planName: SUBSCRIPTION_TIERS[failedTeam?.subscriptionTier as SubscriptionTier]?.name ?? "your plan",
            updatePaymentUrl: `${appBase}/api/checkout/portal`,
          }).catch((e) => console.warn("[stripe-webhook] payment failed email failed:", e));
        }
      } else {
        // FIX-004: could not resolve a team for this payment failure — alert ops
        // instead of silently returning 200, so the declined-card subscription
        // doesn't stay "active" unnoticed.
        console.error(JSON.stringify({ event: "payment_failed_team_unresolved", subscriptionId }));
        sendInternalPaymentAlert({
          customerEmail: typeof invoice.customer_email === "string" ? invoice.customer_email : "(unknown)",
          type: "subscription",
          note: `invoice.payment_failed but no teamId resolvable for subscription ${subscriptionId} — declined card may still be active`,
          timestamp: new Date().toISOString(),
        }).catch((e) => console.warn("[stripe-webhook] payment_failed unresolved alert failed:", e));
      }
    }
  }

  // ── Task 7.4 — checkout.session.expired (audit_purchase only) ───────────
  if (event.type === "checkout.session.expired") {
    const expiredSession = event.data.object as Stripe.Checkout.Session;
    if (expiredSession.metadata?.type === "audit_purchase") {
      // Only update status if a row already exists (webhook fired before intake)
      const [existingExpired] = await db
        .select({ id: auditPurchases.id })
        .from(auditPurchases)
        .where(eq(auditPurchases.stripeSessionId, expiredSession.id));
      if (existingExpired) {
        await db.update(auditPurchases).set({ status: "expired", updatedAt: new Date() })
          .where(eq(auditPurchases.id, existingExpired.id));
      }
      const expiredEmail = expiredSession.customer_details?.email ?? expiredSession.customer_email ?? "";
      sendInternalPaymentAlert({
        customerEmail: expiredEmail || "(unknown)",
        type: "audit_purchase_expired",
        timestamp: new Date().toISOString(),
      }).catch((e) => console.warn("[stripe-webhook] expired alert failed:", e));
    }
  }

  // ── Task 7.4 — payment_intent.payment_failed (audit_purchase) ────────────
  if (event.type === "payment_intent.payment_failed") {
    const failedPi = event.data.object as Stripe.PaymentIntent;
    const [failedPurchase] = await db
      .select({ id: auditPurchases.id, customerEmail: auditPurchases.customerEmail, domain: auditPurchases.domain })
      .from(auditPurchases)
      .where(eq(auditPurchases.stripePaymentIntentId, failedPi.id));
    if (failedPurchase) {
      await db.update(auditPurchases).set({ status: "failed_payment", updatedAt: new Date() })
        .where(eq(auditPurchases.id, failedPurchase.id));
      sendInternalPaymentAlert({
        customerEmail: failedPurchase.customerEmail,
        type: "audit_purchase_failed",
        domain: failedPurchase.domain ?? undefined,
        note: "Stripe decline — payment_intent.payment_failed",
        timestamp: new Date().toISOString(),
      }).catch((e) => console.warn("[stripe-webhook] pi.payment_failed alert failed:", e));
      // Stripe sends the decline notice to the customer — no customer email from us
    }
  }

  // ── Blocker E — payment_intent.succeeded: stamp stripeChargeId so dispute lookup works ──
  // Without this stamp, charge.dispute.created can never match (stripeChargeId column is
  // always NULL). This handler fills the gap by extracting latest_charge at payment time.
  if (event.type === "payment_intent.succeeded") {
    const succeededPi = event.data.object as Stripe.PaymentIntent;
    const latestChargeRef = succeededPi.latest_charge;
    const latestChargeId = typeof latestChargeRef === "string"
      ? latestChargeRef
      : (latestChargeRef as Stripe.Charge | null)?.id ?? null;

    if (latestChargeId) {
      // Only update audit_purchase rows (not subscription payments)
      await db.update(auditPurchases)
        .set({ stripeChargeId: latestChargeId, updatedAt: new Date() })
        .where(and(eq(auditPurchases.stripePaymentIntentId, succeededPi.id), isNull(auditPurchases.stripeChargeId)));
    }
  }

  // ── Task 7.4 — charge.refunded (audit_purchase) ───────────────────────────
  if (event.type === "charge.refunded") {
    const refundedCharge = event.data.object as Stripe.Charge;
    const piId = typeof refundedCharge.payment_intent === "string"
      ? refundedCharge.payment_intent
      : refundedCharge.payment_intent?.id ?? null;
    const chargeId = refundedCharge.id;

    const conditions = piId
      ? or(eq(auditPurchases.stripeChargeId, chargeId), eq(auditPurchases.stripePaymentIntentId, piId))
      : eq(auditPurchases.stripeChargeId, chargeId);

    const [refundedPurchase] = await db
      .select({ id: auditPurchases.id, customerEmail: auditPurchases.customerEmail, domain: auditPurchases.domain, status: auditPurchases.status })
      .from(auditPurchases)
      .where(conditions);

    if (refundedPurchase) {
      // Blocker C: detect whether this refund was triggered by the pipeline failure path.
      // markFailed already sent the customer a "we'll refund you" email — sending a second
      // "your refund is on the way" email within seconds is confusing. Only send for
      // operator-initiated (manual) refunds where status was NOT already failed/refund_pending.
      const wasPipelineRefund = (
        refundedPurchase.status === "failed" || refundedPurchase.status === "refund_pending"
      );

      await db.update(auditPurchases).set({ status: "refunded", updatedAt: new Date() })
        .where(eq(auditPurchases.id, refundedPurchase.id));
      // Operator alert intentionally contains email — they need it to action the refund.
      // Console logs in this branch do NOT include customerEmail (only audit IDs and
      // domains are logged). This is consistent with the Fix I redaction policy:
      // structured logs redact PII, but operator-facing transactional alerts retain it
      // because operators require it to identify and respond to the refund.
      sendInternalPaymentAlert({
        customerEmail: refundedPurchase.customerEmail,
        type: "audit_purchase_refunded",
        domain: refundedPurchase.domain ?? undefined,
        timestamp: new Date().toISOString(),
      }).catch((e) => console.warn("[stripe-webhook] charge.refunded alert failed:", e));
      // Only send customer refund confirmation for manual (operator-initiated) refunds.
      // For pipeline-triggered refunds, markFailed already sent the apology email.
      if (!wasPipelineRefund && refundedPurchase.domain) {
        sendAuditPurchaseRefundedEmail(refundedPurchase.customerEmail, refundedPurchase.domain)
          .catch((e) => console.warn("[stripe-webhook] refunded customer email failed:", e));
      }
    }
  }

  // ── Task 7.4 — charge.dispute.created (audit_purchase) ───────────────────
  if (event.type === "charge.dispute.created") {
    const dispute = event.data.object as Stripe.Dispute;
    const disputeChargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge.id;

    // 12.B fix: try direct lookup by stripeChargeId first — this avoids calling
    // stripe.charges.retrieve for every dispute event on the platform (subscriptions,
    // credit packs, etc.). Only fall back to the API when the direct lookup misses,
    // which handles the Blocker-E case where payment_intent.succeeded ran AFTER the
    // dispute (stripeChargeId column not yet stamped).
    let disputedPurchase = await db
      .select({ id: auditPurchases.id, customerEmail: auditPurchases.customerEmail, domain: auditPurchases.domain })
      .from(auditPurchases)
      .where(eq(auditPurchases.stripeChargeId, disputeChargeId))
      .then(([row]) => row ?? null);

    if (!disputedPurchase) {
      // Direct lookup missed — fall back to stripe.charges.retrieve to get the
      // payment_intent, then look up via stripePaymentIntentId.
      try {
        const disputeCharge = await stripe.charges.retrieve(disputeChargeId);
        const disputePiId = typeof disputeCharge.payment_intent === "string"
          ? disputeCharge.payment_intent
          : disputeCharge.payment_intent?.id ?? null;
        if (disputePiId) {
          disputedPurchase = await db
            .select({ id: auditPurchases.id, customerEmail: auditPurchases.customerEmail, domain: auditPurchases.domain })
            .from(auditPurchases)
            .where(eq(auditPurchases.stripePaymentIntentId, disputePiId))
            .then(([row]) => row ?? null);
        }
      } catch (e) {
        // Stripe API failure — log and continue (no row to update; alert not sent)
        console.warn("[stripe-webhook] charges.retrieve failed for dispute lookup:", e);
      }
    }

    if (disputedPurchase) {
      // Stamp stripeChargeId so future dispute events can match directly
      await db.update(auditPurchases).set({ status: "disputed", stripeChargeId: disputeChargeId, updatedAt: new Date() })
        .where(eq(auditPurchases.id, disputedPurchase.id));
      sendInternalPaymentAlert({
        customerEmail: disputedPurchase.customerEmail,
        type: "audit_purchase_disputed",
        domain: disputedPurchase.domain ?? undefined,
        note: "RESPOND IN STRIPE DASHBOARD WITHIN 7 DAYS",
        timestamp: new Date().toISOString(),
      }).catch((e) => console.warn("[stripe-webhook] dispute alert failed:", e));
      // No customer email — do not engage with disputer in our channel
    }
  }

  // ── customer.subscription.updated ───────────────────────────────────────
  if (event.type === "customer.subscription.updated") {
    const subscription = event.data.object as Stripe.Subscription;
    const teamId = subscription.metadata?.teamId;

    // HIGH-3 fix: also verify stripeSubscriptionId matches to prevent cross-team events
    if (teamId) {
      const priceId = subscription.items.data[0]?.price?.id;
      // Reverse-lookup tier from price ID across both monthly and annual price maps
      let newTier: SubscriptionTier | undefined;
      if (priceId) {
        for (const interval of ["monthly", "quarterly", "annual"] as const) {
          const match = Object.entries(STRIPE_PRICE_IDS[interval]).find(([, id]) => id === priceId);
          if (match) { newTier = match[0] as SubscriptionTier; break; }
        }
      }

      // FIX-001: on an ACTUAL tier change, refresh the credit pool via the
      // canonical writer. Gated on a real change because subscription.updated also
      // fires for status flips, card updates, and our own signup metadata back-fill
      // — re-running the credit SET on those would refill spent credits mid-cycle
      // (revenue leak).
      let entitlement: Partial<InferInsertModel<typeof teams>> = {};
      if (newTier && newTier in SUBSCRIPTION_TIERS && newTier !== "free") {
        const [current] = await db
          .select({ subscriptionTier: teams.subscriptionTier })
          .from(teams)
          .where(and(eq(teams.id, teamId), eq(teams.stripeSubscriptionId, subscription.id)));
        if (current?.subscriptionTier !== newTier) {
          entitlement = {
            subscriptionTier: newTier,
            ...tierEntitlementColumns(SUBSCRIPTION_TIERS[newTier]),
          };
        }
      }

      await db.update(teams).set({
        subscriptionStatus: subscription.status,
        ...entitlement,
        updatedAt: new Date(),
      }).where(and(eq(teams.id, teamId), eq(teams.stripeSubscriptionId, subscription.id)));
    }
  }

  // ── customer.subscription.deleted ───────────────────────────────────────
  if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object as Stripe.Subscription;
    let teamId = subscription.metadata?.teamId;

    // FIX-004: fall back to a DB lookup by stripeSubscriptionId when metadata.teamId
    // is absent (legacy subs created before the back-fill). Without this, the credit
    // revocation below silently skips exactly those subs — the revenue leak persists.
    if (!teamId) {
      const [bySub] = await db
        .select({ id: teams.id })
        .from(teams)
        .where(eq(teams.stripeSubscriptionId, subscription.id));
      teamId = bySub?.id;
    }

    // HIGH-3 fix: verify stripeSubscriptionId matches
    if (teamId) {
      // Grab plan name before downgrading
      const [preCancelTeam] = await db.select({ subscriptionTier: teams.subscriptionTier })
        .from(teams)
        .where(and(eq(teams.id, teamId), eq(teams.stripeSubscriptionId, subscription.id)));

      await db.update(teams).set({
        subscriptionTier: "free",
        stripeSubscriptionId: null,
        subscriptionStatus: "inactive",
        monthlyPageAllowance: FREE_MAX_PAGES,
        monthlyPagesUsed: 0,
        // FIX-004: revoke the paid credit pool on cancellation. In the credit-pool
        // model the pool — NOT the page allowance — is the live audit budget, so
        // leaving it intact let cancelled subscribers keep running paid-tier audits
        // for free (revenue leak). Retention policy: unused credits expire on cancel.
        creditBalance: 0,
        currentPeriodEnd: null,
        updatedAt: new Date(),
      }).where(and(eq(teams.id, teamId), eq(teams.stripeSubscriptionId, subscription.id)));

      const cancelledCustomerEmail = (subscription as unknown as { customer_email?: string }).customer_email
        ?? subscription.metadata?.customerEmail
        ?? undefined;

      if (cancelledCustomerEmail) {
        const cancelledPlanName = preCancelTeam?.subscriptionTier
          ? SUBSCRIPTION_TIERS[preCancelTeam.subscriptionTier as SubscriptionTier]?.name ?? "your plan"
          : "your plan";
        const appBase = process.env.NEXT_PUBLIC_APP_URL ?? "https://geo.flowblinq.com";
        sendSubscriptionCancelledEmail(cancelledCustomerEmail, {
          planName: cancelledPlanName,
          reactivateUrl: `${appBase}/pricing`,
        }).catch((e) => console.warn("[stripe-webhook] cancellation email failed:", e));
      }
    }
  }

  return NextResponse.json({ ok: true });
}
