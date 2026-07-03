// Resolve the authenticated user (middleware-stamped headers) to their geo team.
import { db } from "@/lib/db";
import { teams, teamMembers } from "@/lib/db/schema";
import { getAuthenticatedUser } from "@/lib/supabase/authenticated-client";
import { asc, eq } from "drizzle-orm";

export interface TeamContext {
  userId: string;
  email: string | null;
  teamId: string;
  teamName: string;
  creditBalance: number;
}

export async function getTeamContext(): Promise<TeamContext | null> {
  const user = await getAuthenticatedUser();
  if (!user) return null;
  // Earliest membership wins (stable for multi-team users — geo's convention).
  const [membership] = await db
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(eq(teamMembers.userId, user.id))
    .orderBy(asc(teamMembers.createdAt))
    .limit(1);
  if (!membership) return null;
  const [team] = await db.select().from(teams).where(eq(teams.id, membership.teamId));
  if (!team) return null;
  return {
    userId: user.id,
    email: user.email,
    teamId: team.id,
    teamName: team.name,
    creditBalance: team.creditBalance,
  };
}
