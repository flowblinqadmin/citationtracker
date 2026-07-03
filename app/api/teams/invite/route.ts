import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { teamMembers, teams } from "@/lib/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { getAuthenticatedUser } from "@/lib/supabase/authenticated-client";
import { checkRateLimit } from "@/lib/rate-limit";
import { sendTeamInviteEmail } from "@/lib/email";

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rateLimit = await checkRateLimit("invite:" + user.id, 10, 60 * 60 * 1000);
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Too many invites. Try again later." }, { status: 429 });
  }

  const { email } = await req.json() as { email?: string };
  if (!email?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return NextResponse.json({ error: "Valid email required" }, { status: 400 });
  }

  const inviteEmail = email.trim().toLowerCase();

  // Verify caller is an owner
  const [callerMembership] = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.userId, user.id), eq(teamMembers.role, "owner")));

  if (!callerMembership) {
    return NextResponse.json({ error: "Only team owners can send invites" }, { status: 403 });
  }

  // Check for existing pending invite
  const [existingInvite] = await db
    .select()
    .from(teamMembers)
    .where(and(
      eq(teamMembers.teamId, callerMembership.teamId),
      eq(teamMembers.email, inviteEmail),
      isNull(teamMembers.inviteAcceptedAt)
    ));

  if (existingInvite) {
    return NextResponse.json({ message: "Invite already sent" }, { status: 200 });
  }

  // Get team name for the invite email
  const [team] = await db.select().from(teams).where(eq(teams.id, callerMembership.teamId));
  const teamName = team?.name ?? "a team";

  // Record pending membership — callback auto-accepts by email match on login
  const { nanoid } = await import("nanoid");
  await db.insert(teamMembers).values({
    id: nanoid(),
    teamId: callerMembership.teamId,
    userId: null,
    email: inviteEmail,
    role: "member",
    inviteToken: null,
    createdAt: new Date(),
  });

  // Send invite email via Resend (OTP login, no magic link)
  try {
    await sendTeamInviteEmail(inviteEmail, teamName, user.email ?? "a team member");
  } catch (err) {
    console.error("[teams/invite] Email send error:", err);
    return NextResponse.json({ error: "Failed to send invite email" }, { status: 500 });
  }

  return NextResponse.json({ message: "Invite sent" });
}
