import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { teams, teamMembers } from "@/lib/db/schema";
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

  const [team] = await db
    .select()
    .from(teams)
    .where(eq(teams.id, membership.teamId));

  if (!team) {
    return NextResponse.json({ error: "Team not found" }, { status: 404 });
  }

  const members = await db
    .select()
    .from(teamMembers)
    .where(eq(teamMembers.teamId, team.id));

  return NextResponse.json({
    team: {
      id: team.id,
      name: team.name,
      creditBalance: team.creditBalance,
    },
    role: membership.role,
    members: members.map((m) => ({
      email: m.email,
      role: m.role,
      joinedAt: m.inviteAcceptedAt ?? m.createdAt,
      pending: !m.userId,
    })),
  });
}
