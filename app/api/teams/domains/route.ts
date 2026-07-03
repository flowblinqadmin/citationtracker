import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { teamMembers, teamDomains, geoSites } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { getAuthenticatedUser } from "@/lib/supabase/authenticated-client";

export async function GET(_req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [membership] = await db
    .select()
    .from(teamMembers)
    .where(eq(teamMembers.userId, user.id));

  if (!membership) {
    return NextResponse.json({ error: "No team found" }, { status: 404 });
  }

  const rows = await db
    .select({
      id: teamDomains.id,
      domain: teamDomains.domain,
      siteId: teamDomains.siteId,
      createdAt: teamDomains.createdAt,
      pipelineStatus: geoSites.pipelineStatus,
      lastCrawlAt: geoSites.lastCrawlAt,
      geoScorecard: geoSites.geoScorecard,
    })
    .from(teamDomains)
    .innerJoin(geoSites, eq(teamDomains.siteId, geoSites.id))
    .where(eq(teamDomains.teamId, membership.teamId));

  const domains = rows.map((r) => {
    const scorecard = r.geoScorecard as { overallScore?: number } | null;
    return {
      id: r.id,
      domain: r.domain,
      siteId: r.siteId,
      pipelineStatus: r.pipelineStatus,
      overallScore: scorecard?.overallScore ?? null,
      lastCrawlAt: r.lastCrawlAt,
      createdAt: r.createdAt,
    };
  });

  return NextResponse.json({ domains });
}
