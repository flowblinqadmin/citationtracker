import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { geoSites, teams } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import type { UserCompetitor, DiscoveredCompetitor } from "@/lib/types/citation";
import { SUBSCRIPTION_TIERS, type SubscriptionTier } from "@/lib/config";

/** Falls back to 6 only when the team's tier cannot be resolved (no team, or an
 *  unrecognized tier string); a resolved tier always uses its real per-tier cap. */
const DEFAULT_COMPETITOR_CAP = 6;

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Strip characters that could cause prompt injection or data corruption */
function sanitizeName(raw: string): string {
  return raw
    .trim()
    .replace(/[\n\r]/g, " ")
    .replace(/[\x00-\x1f]/g, "")
    .replace(/[{}]/g, "");
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  const { id: siteId } = await params;

  const token =
    req.headers.get("authorization")?.replace("Bearer ", "") ??
    req.nextUrl.searchParams.get("token");
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // FIX-4: Selective column query
  const [site] = await db
    .select({
      accessToken: geoSites.accessToken,
      teamId: geoSites.teamId,
      userCompetitors: geoSites.userCompetitors,
      discoveredCompetitors: geoSites.discoveredCompetitors,
      competitorBlocklist: geoSites.competitorBlocklist,
    })
    .from(geoSites)
    .where(eq(geoSites.id, siteId));
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });
  if (site.accessToken !== token)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // FIX-020: enforce the per-tier competitor cap (display-only until now — every
  // tier was silently capped at 6). Resolve the team's tier; fall back to 6 only
  // when the tier is unresolvable.
  let maxCompetitors = DEFAULT_COMPETITOR_CAP;
  if (site.teamId) {
    const [team] = await db
      .select({ subscriptionTier: teams.subscriptionTier })
      .from(teams)
      .where(eq(teams.id, site.teamId));
    maxCompetitors =
      SUBSCRIPTION_TIERS[team?.subscriptionTier as SubscriptionTier]?.maxCompetitors ??
      DEFAULT_COMPETITOR_CAP;
  }

  const body = await req.json();
  const { action } = body as { action: string };

  if (action === "add") {
    const rawName = body.name as string | undefined;
    const rawDomain = body.domain as string | undefined;

    if (!rawName || !rawName.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }
    // FIX-2: Sanitize name
    const name = sanitizeName(rawName);
    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }
    if (name.length > 100) {
      return NextResponse.json({ error: "Name must be 100 characters or fewer" }, { status: 400 });
    }

    // FIX-1: Transaction with row lock
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM geo_sites WHERE id = ${siteId} FOR UPDATE`);

      const [locked] = await tx
        .select({
          userCompetitors: geoSites.userCompetitors,
          discoveredCompetitors: geoSites.discoveredCompetitors,
          competitorBlocklist: geoSites.competitorBlocklist,
        })
        .from(geoSites)
        .where(eq(geoSites.id, siteId));

      const userCompetitors = ((locked.userCompetitors ?? []) as UserCompetitor[]).slice();
      const discoveredCompetitors = ((locked.discoveredCompetitors ?? []) as DiscoveredCompetitor[]).slice();
      const blocklist = ((locked.competitorBlocklist ?? []) as string[]).slice();

      const effective = [...userCompetitors, ...discoveredCompetitors];
      if (effective.length >= maxCompetitors) {
        return NextResponse.json({ error: `Maximum ${maxCompetitors} competitors` }, { status: 400 });
      }

      const nameLower = name.toLowerCase();
      if (effective.some((c) => c.name.toLowerCase() === nameLower)) {
        return NextResponse.json({ error: "Competitor already exists" }, { status: 409 });
      }

      // Re-adding removes from blocklist (AC11)
      const updatedBlocklist = blocklist.filter((b) => b !== nameLower);

      userCompetitors.push({
        name,
        domain: rawDomain?.trim() || undefined,
        addedAt: new Date().toISOString(),
      });

      await tx
        .update(geoSites)
        .set({ userCompetitors, competitorBlocklist: updatedBlocklist })
        .where(eq(geoSites.id, siteId));

      const total = userCompetitors.length + discoveredCompetitors.length;
      return NextResponse.json({
        userCompetitors,
        discoveredCompetitors,
        blocklist: updatedBlocklist,
        totalCount: total,
        slotsRemaining: Math.max(0, maxCompetitors - total),
      });
    });
  }

  if (action === "remove") {
    const rawName = body.name as string | undefined;
    if (!rawName) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }
    const nameLower = rawName.toLowerCase();

    // FIX-1: Transaction with row lock
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM geo_sites WHERE id = ${siteId} FOR UPDATE`);

      const [locked] = await tx
        .select({
          userCompetitors: geoSites.userCompetitors,
          discoveredCompetitors: geoSites.discoveredCompetitors,
          competitorBlocklist: geoSites.competitorBlocklist,
        })
        .from(geoSites)
        .where(eq(geoSites.id, siteId));

      const userCompetitors = ((locked.userCompetitors ?? []) as UserCompetitor[]).slice();
      const discoveredCompetitors = ((locked.discoveredCompetitors ?? []) as DiscoveredCompetitor[]).slice();
      const blocklist = ((locked.competitorBlocklist ?? []) as string[]).slice();

      const userIdx = userCompetitors.findIndex((c) => c.name.toLowerCase() === nameLower);
      if (userIdx >= 0) {
        userCompetitors.splice(userIdx, 1);
      } else {
        const discIdx = discoveredCompetitors.findIndex((c) => c.name.toLowerCase() === nameLower);
        if (discIdx >= 0) {
          discoveredCompetitors.splice(discIdx, 1);
        }
      }

      if (!blocklist.includes(nameLower)) {
        blocklist.push(nameLower);
      }
      while (blocklist.length > 20) {
        blocklist.shift();
      }

      await tx
        .update(geoSites)
        .set({ userCompetitors, discoveredCompetitors, competitorBlocklist: blocklist })
        .where(eq(geoSites.id, siteId));

      const total = userCompetitors.length + discoveredCompetitors.length;
      return NextResponse.json({
        userCompetitors,
        discoveredCompetitors,
        blocklist,
        totalCount: total,
        slotsRemaining: Math.max(0, maxCompetitors - total),
      });
    });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
