// DELETE /api/teams/:teamId/api-clients/:clientId — revoke API client (dashboard, session auth)

import { NextRequest, NextResponse } from "next/server";
import { revokeApiClient } from "@/lib/db/api-clients";
import { getAuthenticatedUser } from "@/lib/supabase/authenticated-client";
import { db } from "@/lib/db";
import { teamMembers } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ teamId: string; clientId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const { teamId, clientId } = await params;

    const [membership] = await db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.userId, user.id), eq(teamMembers.teamId, teamId)));

    if (!membership) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    await revokeApiClient(clientId, teamId);

    console.log(JSON.stringify({
      event: "api_client_revoked",
      teamId,
      clientId,
      revokedBy: user.id,
    }));

    return NextResponse.json({ revoked: true });

  } catch (err) {
    console.error("[teams/api-clients DELETE] error:", err);
    return NextResponse.json({ error: "internal_server_error" }, { status: 500 });
  }
}
