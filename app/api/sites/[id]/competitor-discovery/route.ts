import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { geoSites, teams, creditTransactions, auditPurchases } from "@/lib/db/schema";
import { eq, sql, gte, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { discoverCompetitors } from "@/lib/services/competitor-discovery";
import type { UserCompetitor, DiscoveredCompetitor } from "@/lib/types/citation";
import { ACTION_CREDITS } from "@/lib/config";
// sync to geo_site_view handled by Postgres trigger

export const runtime = "nodejs";
export const maxDuration = 120;

const DISCOVERY_COST = ACTION_CREDITS.competitorMapping;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  const { id: siteId } = await params;

  const token = req.headers.get("authorization")?.replace("Bearer ", "") ?? req.nextUrl.searchParams.get("token");
  // Fix #5: read purchaseToken from dedicated X-Purchase-Token header to avoid ambiguity with
  // the Authorization header (which carries the regular user accessToken). Falls back to
  // ?purchaseToken= query param for back-compat during the deploy window.
  const purchaseToken =
    req.headers.get("x-purchase-token") ??
    req.nextUrl.searchParams.get("purchaseToken");

  // GMC audit-purchase auth bypass (mirrors download-report/pdf-report pattern):
  // a valid purchaseToken bound to this siteId skips accessToken + credit gating.
  // Used by the audit-purchase-finalize pipeline stage to run discovery
  // server-internally without HTTP credit deduction or auth prompts.
  let isPurchaseAuth = false;
  if (purchaseToken) {
    const [purchase] = await db
      .select({ id: auditPurchases.id, purchaseTokenExpiresAt: auditPurchases.purchaseTokenExpiresAt })
      .from(auditPurchases)
      .where(and(eq(auditPurchases.purchaseToken, purchaseToken), eq(auditPurchases.siteId, siteId)));
    // Fix #32: enforce purchaseToken expiry (30-day TTL). NULL = legacy row, treat as expired.
    if (purchase && purchase.purchaseTokenExpiresAt && purchase.purchaseTokenExpiresAt >= new Date()) {
      isPurchaseAuth = true;
    } else if (purchase) {
      return NextResponse.json({ error: "purchaseToken has expired" }, { status: 401 });
    }
  }

  if (!isPurchaseAuth && !token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [site] = await db.select().from(geoSites).where(eq(geoSites.id, siteId));
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });

  if (!isPurchaseAuth) {
    if (site.accessToken !== token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    // ES-090 §b.2 CRIT-1: HP-197 — NULL tokenExpiresAt treated as expired.
    if (!site.tokenExpiresAt || site.tokenExpiresAt < new Date()) {
      return NextResponse.json(
        { error: "Unauthorized", code: "TOKEN_EXPIRED" },
        { status: 401 },
      );
    }
  }

  // Read slot state with row lock
  const userCompetitors = ((site.userCompetitors ?? []) as UserCompetitor[]);
  const existingDiscovered = ((site.discoveredCompetitors ?? []) as DiscoveredCompetitor[]);
  const blocklist = ((site.competitorBlocklist ?? []) as string[]);
  const effectiveCount = userCompetitors.length + existingDiscovered.length;
  const slotsAvailable = Math.max(0, 6 - effectiveCount);

  if (slotsAvailable <= 0) {
    return NextResponse.json({
      error: "No discovery slots available",
      totalCount: effectiveCount,
      slotsRemaining: 0,
    }, { status: 400 });
  }

  const excludeNames = [
    ...blocklist,
    ...userCompetitors.map((c) => c.name.toLowerCase()),
    ...existingDiscovered.map((c) => c.name.toLowerCase()),
  ];

  if (!isPurchaseAuth) {
    if (!site.teamId) return NextResponse.json({ error: "Competitor discovery requires a Pro account." }, { status: 402 });
    const [team] = await db.select().from(teams).where(eq(teams.id, site.teamId));
    if (!team || team.creditBalance < DISCOVERY_COST) {
      return NextResponse.json({ error: "insufficient_credits" }, { status: 402 });
    }
  }

  const hasAnyProvider = !!(
    process.env.PERPLEXITY_API_KEY || process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY  || process.env.GEMINI_API_KEY
  );
  if (!hasAnyProvider) return NextResponse.json({ error: "No AI providers configured." }, { status: 422 });

  // Deduct credits upfront — skipped for audit_purchase mode (already paid $10).
  if (!isPurchaseAuth && site.teamId) {
    const [team] = await db.select().from(teams).where(eq(teams.id, site.teamId));
    if (team) {
      const teamId      = site.teamId;
      const balanceBefore = team.creditBalance;
      const balanceAfter  = team.creditBalance - DISCOVERY_COST;

      await db
        .update(teams)
        .set({ creditBalance: sql`${teams.creditBalance} - ${DISCOVERY_COST}` })
        .where(and(eq(teams.id, teamId), gte(teams.creditBalance, DISCOVERY_COST)));

      await db.insert(creditTransactions).values({
        id: nanoid(),
        teamId,
        siteId,
        type: "competitor_discovery_debit",
        pagesConsumed: 0,
        creditsChanged: -DISCOVERY_COST,
        balanceBefore,
        balanceAfter,
      });
    }
  }

  // Run discovery and persist with row lock
  const sseEvents: Record<string, unknown>[] = [];
  sseEvents.push({ type: "start", message: `Discovering competitors for ${site.domain}` });
  sseEvents.push({ type: "stage", stage: "querying", progress: 5, message: "Sending discovery prompts to AI" });

  try {
    const competitors = await discoverCompetitors(site, {
      onPromptStart: (index, total, prompt) => {
        const progress = Math.round(5 + (index / total) * 80);
        sseEvents.push({ type: "stage", stage: "querying", progress, message: `Prompt ${index}/${total}` });
        void prompt;
      },
      onPromptComplete: (index, total) => {
        const progress = Math.round(5 + (index / total) * 80);
        sseEvents.push({ type: "prompt-complete", index, total, progress });
      },
    }, { excludeNames, maxResults: slotsAvailable });

    sseEvents.push({ type: "stage", stage: "extracting", progress: 90, message: "Extracting competitor list" });

    // FIX-1: Lock row, re-read, append, persist atomically
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM geo_sites WHERE id = ${siteId} FOR UPDATE`);
      const [fresh] = await tx.select({ discoveredCompetitors: geoSites.discoveredCompetitors, userCompetitors: geoSites.userCompetitors }).from(geoSites).where(eq(geoSites.id, siteId));
      const freshUser = ((fresh.userCompetitors ?? []) as UserCompetitor[]);
      const freshDiscovered = ((fresh.discoveredCompetitors ?? []) as DiscoveredCompetitor[]);
      const updated = [...freshDiscovered, ...competitors].slice(0, 6 - freshUser.length);
      await tx.update(geoSites).set({ discoveredCompetitors: updated }).where(eq(geoSites.id, siteId));

      console.info(`[competitor-discovery] ${site.domain}: ${updated.length} competitors saved`);
      sseEvents.push({ type: "complete", competitors: updated, creditsUsed: DISCOVERY_COST, slotsRemaining: 6 - freshUser.length - updated.length });
    });
  } catch (err) {
    const discoveryError = err instanceof Error ? err.message : "Unknown error";
    sseEvents.push({ type: "error", message: discoveryError });
    console.error("[competitor-discovery] Error:", err);
  }

  const encoder = new TextEncoder();
  const sseMsg = (obj: Record<string, unknown>) =>
    encoder.encode(`data: ${JSON.stringify(obj)}\n\n`);

  const stream = new ReadableStream({
    start(controller) {
      for (const evt of sseEvents) {
        controller.enqueue(sseMsg(evt));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection":    "keep-alive",
    },
  });
}
