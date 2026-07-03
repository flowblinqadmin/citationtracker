// GET /api/v1/account — credit balance and usage

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { teams, geoSites } from "@/lib/db/schema";
import { eq, and, count } from "drizzle-orm";
import { verifyApiToken, requireScope } from "@/lib/api-auth";

export async function GET(req: NextRequest) {
  try {
    // Auth
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "missing_token" }, { status: 401 });
    }
    let token;
    try {
      token = await verifyApiToken(authHeader.slice(7));
    } catch {
      return NextResponse.json({ error: "invalid_token" }, { status: 401 });
    }

    try {
      requireScope(token.scopes, "account:read");
    } catch {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const [team] = await db
      .select()
      .from(teams)
      .where(eq(teams.id, token.team_id));

    if (!team) {
      return NextResponse.json({ error: "team_not_found" }, { status: 404 });
    }

    // Count domains with free optimization still available (run 1, not yet post-opted)
    const [{ freeOptDomains }] = await db
      .select({ freeOptDomains: count() })
      .from(geoSites)
      .where(
        and(
          eq(geoSites.teamId, token.team_id),
          eq(geoSites.freeOptimizationUsed, false)
        )
      );

    return NextResponse.json({
      team_id: team.id,
      credit_balance: team.creditBalance,
      free_optimization_domains: freeOptDomains,
      credits_purchase_url: "https://geo.flowblinq.com/dashboard",
    });

  } catch (err) {
    console.error("[v1/account] error:", err);
    return NextResponse.json({ error: "internal_server_error" }, { status: 500 });
  }
}
