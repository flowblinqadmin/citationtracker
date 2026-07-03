// GET /api/audit-purchase/status — poll pipeline progress for thank-you page
// Pattern from: WP plugin fqgeo_poll_audit + TS client pollAudit()

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { auditPurchases, geoSiteView } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/client-ip";

// Fix #8: session_id is visible in browser history / success_url / proxy logs.
// Once the audit is delivered, anyone with the session_id can poll its status.
// Tighten: session_id lookup only works for pre-delivery statuses.
// purchase_token lookup works for all statuses.
const SESSION_ID_ALLOWED_STATUSES = ["paid", "intake_complete"] as const;
type SessionIdAllowedStatus = (typeof SESSION_ID_ALLOWED_STATUSES)[number];

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const sessionId = url.searchParams.get("session_id");
    const purchaseToken = url.searchParams.get("purchase_token");

    if (!sessionId && !purchaseToken) {
      return NextResponse.json(
        { error: "session_id or purchase_token required" },
        { status: 400 },
      );
    }

    const ip = getClientIp(req);
    const rlKey = `audit-status:${sessionId ?? purchaseToken ?? ip}`;
    const rl = await checkRateLimit(rlKey, 30, 60_000);
    if (!rl.allowed) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }

    // Look up the purchase — explicit projection: NEVER return magicLink, userId, teamId,
    // purchaseToken, customerEmail, or stripeSessionId (Blocker A: session_id visible in
    // browser history / proxy logs → any observer could fetch the row).
    const purchaseProjection = {
      status: auditPurchases.status,
      domain: auditPurchases.domain,
      siteId: auditPurchases.siteId,
    };
    let purchase: { status: string; domain: string | null; siteId: string | null } | undefined;
    if (sessionId) {
      // Fix #8: session_id lookup only returns rows in pre-delivery statuses.
      // Once delivered, return 404 — force purchase_token usage.
      // This prevents observers with the session_id from polling post-delivery.
      const [row] = await db
        .select(purchaseProjection)
        .from(auditPurchases)
        .where(eq(auditPurchases.stripeSessionId, sessionId));
      if (row && SESSION_ID_ALLOWED_STATUSES.includes(row.status as SessionIdAllowedStatus)) {
        purchase = row;
      } else if (row) {
        // Row exists but status is post-delivery — return 404 to force purchase_token
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
    } else {
      [purchase] = await db
        .select(purchaseProjection)
        .from(auditPurchases)
        .where(eq(auditPurchases.purchaseToken, purchaseToken!));
    }

    if (!purchase) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    // If no site yet (paid but intake not submitted), return early
    if (!purchase.siteId) {
      return NextResponse.json({
        purchaseStatus: purchase.status,
        pipelineStatus: null,
        domain: null,
        score: null,
      });
    }

    // Get pipeline status from geoSiteView (denormalized — surfaces overallScore
    // extracted from geoScorecard jsonb; pipelineStatus/Error are mirrored).
    const [site] = await db
      .select({
        pipelineStatus: geoSiteView.pipelineStatus,
        domain: geoSiteView.domain,
        overallScore: geoSiteView.overallScore,
        pipelineError: geoSiteView.pipelineError,
      })
      .from(geoSiteView)
      .where(eq(geoSiteView.siteId, purchase.siteId));

    if (!site) {
      return NextResponse.json({
        purchaseStatus: purchase.status,
        pipelineStatus: "pending",
        domain: purchase.domain,
        score: null,
      });
    }

    return NextResponse.json({
      purchaseStatus: purchase.status,
      pipelineStatus: site.pipelineStatus,
      domain: site.domain,
      score: site.overallScore ?? null,
      error: site.pipelineError ?? null,
    });
  } catch (err) {
    console.error("GET /api/audit-purchase/status error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
