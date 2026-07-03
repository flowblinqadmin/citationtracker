// GET /api/teams/:teamId/api-clients — list API clients (dashboard, session auth)
// POST /api/teams/:teamId/api-clients — create new API client (dashboard, session auth)

import { NextRequest, NextResponse } from "next/server";
import { createApiClient, listApiClientsForTeam } from "@/lib/db/api-clients";
import { getAuthenticatedUser } from "@/lib/supabase/authenticated-client";
import { db } from "@/lib/db";
import { teamMembers } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

async function authorizeTeam(userId: string, teamId: string): Promise<boolean> {
  const [membership] = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.userId, userId), eq(teamMembers.teamId, teamId)));
  return !!membership;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ teamId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const { teamId } = await params;

    if (!(await authorizeTeam(user.id, teamId))) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const clients = await listApiClientsForTeam(teamId);

    return NextResponse.json(
      clients.map((c) => ({
        client_id:          c.clientId,
        name:               c.name,
        scopes:             c.scopes,
        created_by_user_id: c.createdByUserId,
        created_at:         c.createdAt,
        last_used_at:       c.lastUsedAt,
        revoked_at:         c.revokedAt,
      }))
    );

  } catch (err) {
    console.error("[teams/api-clients GET] error:", err);
    return NextResponse.json({ error: "internal_server_error" }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ teamId: string }> }
) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const { teamId } = await params;

    if (!(await authorizeTeam(user.id, teamId))) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const body = await req.json() as { name?: string; scopes?: string[] };
    const { name, scopes } = body;

    if (!name || typeof name !== "string") {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    const allowedScopes = ["audit:read", "audit:write", "account:read", "pageviews:read"];
    const resolvedScopes = Array.isArray(scopes)
      ? scopes.filter((s) => allowedScopes.includes(s))
      : allowedScopes;

    const { client_id, client_secret } = await createApiClient({
      teamId,
      name,
      scopes: resolvedScopes,
      createdByUserId: user.id,
    });

    console.log(JSON.stringify({
      event: "api_client_created",
      teamId,
      clientId: client_id,
      name,
      scopes: resolvedScopes,
    }));

    return NextResponse.json({ client_id, client_secret }, { status: 201 });

  } catch (err) {
    console.error("[teams/api-clients POST] error:", err);
    return NextResponse.json({ error: "internal_server_error" }, { status: 500 });
  }
}
