// POST /api/audit-purchase/intake — validate Stripe payment, create audit, trigger pipeline
// Pattern from: app/api/v1/audit/route.ts (SSRF, normalizeDomain, geoSites creation, enqueueStage)

import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { createHash } from "crypto";
import { db } from "@/lib/db";
import { geoSites, auditPurchases } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { normalizeDomain, slugify } from "@/lib/utils";
import { enqueueStage } from "@/lib/qstash";
import { sendAuditPurchaseConfirmationEmail } from "@/lib/email";
import { validatePublicUrl } from "@/lib/ssrf";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/client-ip";
import { TOKEN_TTL_MS } from "@/lib/constants/token-ttl";

function emailHash(email: string): string {
  return createHash("sha256").update(email).digest("hex").slice(0, 16);
}

export async function POST(req: NextRequest) {
  try {
    const ip = getClientIp(req);
    const rl = await checkRateLimit(`audit-intake:${ip}`, 10, 60_000);
    if (!rl.allowed) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }

    const body = (await req.json().catch(() => ({}))) as {
      sessionId?: string;
      websiteUrl?: string;
    };

    const { sessionId } = body;

    if (!sessionId || typeof sessionId !== "string") {
      return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
    }

    // Validate Stripe payment
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
    let session: Stripe.Checkout.Session;
    try {
      session = await stripe.checkout.sessions.retrieve(sessionId);
    } catch {
      return NextResponse.json({ error: "invalid_session" }, { status: 400 });
    }

    if (session.payment_status !== "paid") {
      return NextResponse.json({ error: "payment_not_completed" }, { status: 402 });
    }
    if (session.metadata?.type !== "audit_purchase") {
      return NextResponse.json({ error: "invalid_session_type" }, { status: 400 });
    }

    // Resolve websiteUrl — prefer session metadata (validated at checkout-time), fall back to body
    // for in-flight sessions created before Task 6.1 (back-compat)
    const websiteUrl: string | undefined =
      session.metadata?.websiteUrl ?? body.websiteUrl;

    if (!websiteUrl || typeof websiteUrl !== "string") {
      return NextResponse.json({ error: "websiteUrl is required" }, { status: 400 });
    }

    // Full SSRF validation for body fallback (metadata was already validated at checkout-time)
    let resolvedUrl = websiteUrl;
    if (!session.metadata?.websiteUrl) {
      const validation = validatePublicUrl(websiteUrl);
      if (!validation.ok) {
        return NextResponse.json({ error: "invalid_url" }, { status: 400 });
      }
      // Use canonicalized URL downstream
      resolvedUrl = validation.url.href;
    }

    // Blocker B: normalize email — Stripe can deliver mixed-case; lowercase ensures
    // identity deduplication with Google OAuth (which always returns lowercase).
    const customerEmail = (
      session.customer_details?.email ?? session.customer_email ?? ""
    ).trim().toLowerCase();
    if (!customerEmail) {
      return NextResponse.json(
        { error: "No email found on payment session" },
        { status: 400 },
      );
    }

    const domain = normalizeDomain(resolvedUrl);
    const siteId = nanoid();
    const slug = slugify(domain) + "-" + nanoid(6);
    // FIX-017: single source for the paid-audit crawl budget so the geoSites
    // row's crawlLimit and the discover enqueue's maxPages can never diverge.
    const crawlLimit = 250; // paid audit — 5x free tier

    // Fix #6: wrap the race-prone existingPurchase check + geoSites insert + auditPurchases
    // upsert in a transaction to eliminate orphan geoSites rows when two concurrent intake
    // requests race on the same session_id. The unique constraint on stripeSessionId catches
    // the second insert; we catch the violation and return already_submitted.
    let txSiteId = siteId;
    let txDomain = domain;
    let alreadySubmitted = false;
    let alreadySubmittedResult: { auditId: string; domain: string | null } | null = null;

    try {
      await db.transaction(async (tx) => {
        // Re-check inside the transaction for idempotency (SELECT FOR UPDATE equivalent).
        const [existingPurchase] = await tx
          .select({
            id: auditPurchases.id,
            siteId: auditPurchases.siteId,
            domain: auditPurchases.domain,
            teamId: auditPurchases.teamId,
          })
          .from(auditPurchases)
          .where(eq(auditPurchases.stripeSessionId, sessionId));

        if (existingPurchase?.siteId) {
          alreadySubmitted = true;
          alreadySubmittedResult = { auditId: existingPurchase.siteId, domain: existingPurchase.domain };
          return; // exit transaction — no DB writes needed
        }

        // Stamp teamId from existing purchase if webhook already ran (Task 7.3)
        const purchaseTeamId = existingPurchase?.teamId ?? null;

        // Create geoSites row
        await tx.insert(geoSites).values({
          id: siteId,
          domain,
          slug,
          ownerEmail: customerEmail,
          emailVerified: true, // payment = verification
          accessToken: nanoid(32),
          // H3 (2026-05-27 audit): download-report + pdf-report enforce
          // tokenExpiresAt; stamp a future expiry alongside accessToken.
          tokenExpiresAt: new Date(Date.now() + TOKEN_TTL_MS),
          pipelineStatus: "pending",
          crawlLimit,
          freeRunNumber: 1,
          freeOptimizationUsed: false,
          ...(purchaseTeamId ? { teamId: purchaseTeamId } : {}),
        });

        // Update or create auditPurchases row
        if (existingPurchase) {
          // Webhook already created the row — update with intake data
          await tx
            .update(auditPurchases)
            .set({
              domain,
              siteId,
              status: "intake_complete",
              updatedAt: new Date(),
            })
            .where(eq(auditPurchases.id, existingPurchase.id));
        } else {
          // Webhook hasn't fired yet (race condition) — create the row.
          // Defensive fallback chain: prefer amount_total (post-tax total for payment-mode
          // sessions), then amount_subtotal (pre-tax), then 0.
          const resolvedAmountCents = session.amount_total ?? session.amount_subtotal ?? 0;
          if (session.amount_total === null || session.amount_total === undefined) {
            console.warn(
              JSON.stringify({
                event: "audit_purchase_intake_amount_null",
                sessionId,
                amount_total: session.amount_total,
                amount_subtotal: session.amount_subtotal,
                resolvedAmountCents,
              }),
            );
          }
          await tx.insert(auditPurchases).values({
            id: nanoid(),
            stripeSessionId: sessionId,
            stripePaymentIntentId:
              typeof session.payment_intent === "string"
                ? session.payment_intent
                : session.payment_intent?.id ?? null,
            customerEmail,
            domain,
            siteId,
            purchaseToken: nanoid(32),
            purchaseTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
            amountCents: resolvedAmountCents,
            status: "intake_complete",
          });
        }

        txSiteId = siteId;
        txDomain = domain;
      });
    } catch (txErr) {
      // Unique constraint violation on stripeSessionId = concurrent duplicate intake.
      // Return already_submitted without an orphan geoSites row (transaction rolled back).
      const errMsg = String((txErr as { message?: string }).message ?? txErr);
      if (
        errMsg.includes("unique") ||
        errMsg.includes("duplicate key") ||
        errMsg.includes("UniqueConstraintViolation")
      ) {
        const [existing] = await db
          .select({ siteId: auditPurchases.siteId, domain: auditPurchases.domain })
          .from(auditPurchases)
          .where(eq(auditPurchases.stripeSessionId, sessionId));
        return NextResponse.json({
          auditId: existing?.siteId ?? null,
          status: "already_submitted",
          domain: existing?.domain ?? null,
        });
      }
      throw txErr; // re-throw unexpected errors
    }

    if (alreadySubmitted && alreadySubmittedResult) {
      return NextResponse.json({
        auditId: alreadySubmittedResult.auditId,
        status: "already_submitted",
        domain: alreadySubmittedResult.domain,
      });
    }

    // Kick off pipeline (outside transaction — non-transactional)
    // FIX-017: pass the row's crawl budget explicitly — without it the stage
    // handler falls back to FREE_MAX_PAGES (20) and truncates the paid audit.
    await enqueueStage({ siteId: txSiteId, domain: txDomain, stage: "discover", maxPages: crawlLimit });

    // Send confirmation email
    try {
      await sendAuditPurchaseConfirmationEmail(customerEmail, domain);
    } catch (emailErr) {
      console.error("[audit-purchase/intake] confirmation email failed:", emailErr);
    }

    console.log(
      JSON.stringify({
        event: "audit_purchase_intake_complete",
        siteId: txSiteId,
        domain: txDomain,
        sessionId,
        emailHash: emailHash(customerEmail),
      }),
    );

    return NextResponse.json(
      {
        auditId: txSiteId,
        status: "pending",
        domain: txDomain,
        estimatedMinutes: 5,
      },
      { status: 201 },
    );
  } catch (err) {
    console.error("POST /api/audit-purchase/intake error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
