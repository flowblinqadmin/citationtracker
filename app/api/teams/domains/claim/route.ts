import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { teamMembers, teamDomains, geoSites } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getAuthenticatedUser } from "@/lib/supabase/authenticated-client";

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { siteId, accessToken } = await req.json() as { siteId?: string; accessToken?: string };
  if (!siteId?.trim() || !accessToken?.trim()) {
    return NextResponse.json({ error: "siteId and accessToken required" }, { status: 400 });
  }

  const [site] = await db
    .select()
    .from(geoSites)
    .where(and(eq(geoSites.id, siteId), eq(geoSites.accessToken, accessToken)));

  if (!site) {
    return NextResponse.json({ error: "Site not found or token invalid" }, { status: 404 });
  }

  if (site.teamId) {
    return NextResponse.json({ error: "Site already claimed by a team" }, { status: 409 });
  }

  const [membership] = await db
    .select()
    .from(teamMembers)
    .where(eq(teamMembers.userId, user.id));

  if (!membership) {
    return NextResponse.json({ error: "No team found — sign in first" }, { status: 404 });
  }

  await db
    .update(geoSites)
    .set({ teamId: membership.teamId, userId: user.id })
    .where(eq(geoSites.id, site.id));

  await db.insert(teamDomains).values({
    id: nanoid(),
    teamId: membership.teamId,
    siteId: site.id,
    domain: site.domain,
    addedByUserId: user.id,
    createdAt: new Date(),
  });

  return NextResponse.json({ message: "Site claimed", domain: site.domain });
}
