import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { geoSites, teamMembers, teams } from "@/lib/db/schema";
import { getAuthenticatedUser } from "@/lib/supabase/authenticated-client";
import {
  ABSOLUTE_MAX_PAGES,
  CRAWL_FREQUENCIES,
  SUBSCRIPTION_TIERS,
  isFrequencyAllowedForTier,
  type CrawlFrequency,
  type SubscriptionTier,
} from "@/lib/config";

export const runtime = "nodejs";

/**
 * PATCH /api/subscription
 *
 * Persists per-site crawl settings (crawl frequency and/or page selection) for
 * a site owned by the authenticated user's team.
 *
 * FIX-022 (BUG-005/BUG-004): this route did not exist — the dashboard PATCHed
 * it and silently 404'd, so crawl-frequency changes never persisted AND the
 * only frequency gate was the client `<select>` (a trust-boundary gap). The
 * requested frequency is now re-validated server-side against the team's tier
 * ceiling (SUBSCRIPTION_TIERS[tier].maxFrequency) before any write.
 */
const patchSchema = z
  .object({
    siteId: z.string().min(1),
    // z.enum over CRAWL_FREQUENCIES (single source of truth) — the parsed value
    // is statically a CrawlFrequency, so no downstream cast is needed.
    crawlFrequency: z.enum(CRAWL_FREQUENCIES).optional(),
    selectedPages: z.array(z.string().min(1)).max(ABSOLUTE_MAX_PAGES).optional(),
  })
  .refine((b) => b.crawlFrequency !== undefined || b.selectedPages !== undefined, {
    message: "Provide crawlFrequency and/or selectedPages",
  });

export async function PATCH(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { siteId, crawlFrequency, selectedPages } = parsed.data;

  // ── Authorize: the caller must be a member of the site's owning team ──────
  const [site] = await db.select().from(geoSites).where(eq(geoSites.id, siteId));
  if (!site) {
    return NextResponse.json({ error: "Site not found" }, { status: 404 });
  }
  if (!site.teamId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const [membership] = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.userId, user.id), eq(teamMembers.teamId, site.teamId)));
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // ── Build + validate the update set server-side ───────────────────────────
  const updates: { crawlFrequency?: CrawlFrequency; selectedPages?: string[] } = {};

  if (crawlFrequency !== undefined) {
    const [team] = await db.select().from(teams).where(eq(teams.id, site.teamId));
    if (!team) {
      return NextResponse.json({ error: "Team not found" }, { status: 404 });
    }
    // Fail LOUD on an unrecognized tier rather than silently coercing to "free"
    // (which would wrongly deny a paying customer their entitled frequency).
    if (!(team.subscriptionTier in SUBSCRIPTION_TIERS)) {
      console.error(
        `[subscription] team ${site.teamId} has unknown subscriptionTier "${team.subscriptionTier}"`,
      );
      return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
    const tier = team.subscriptionTier as SubscriptionTier;
    if (!isFrequencyAllowedForTier(tier, crawlFrequency)) {
      return NextResponse.json(
        {
          error: `Crawl frequency "${crawlFrequency}" is not available on the ${SUBSCRIPTION_TIERS[tier].name} plan.`,
        },
        { status: 403 },
      );
    }
    updates.crawlFrequency = crawlFrequency;
  }

  if (selectedPages !== undefined) {
    updates.selectedPages = selectedPages;
  }

  await db.update(geoSites).set(updates).where(eq(geoSites.id, siteId));

  return NextResponse.json({ ok: true, ...updates });
}
