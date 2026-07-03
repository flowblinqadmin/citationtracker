// POST /api/v1/audit/:id/verify — trigger post-optimization second run

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { geoSites } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { verifyApiToken, requireScope } from "@/lib/api-auth";
import { enqueueStage } from "@/lib/qstash";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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
      requireScope(token.scopes, "audit:write");
    } catch {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const { id } = await params;

    const [site] = await db
      .select()
      .from(geoSites)
      .where(eq(geoSites.id, id));

    if (!site) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    // Ownership check
    if (site.teamId !== token.team_id) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    // Validations
    if (site.freeRunNumber === 2) {
      return NextResponse.json(
        { error: "bad_request", message: "second run already used or in progress" },
        { status: 400 }
      );
    }

    if (site.freeOptimizationUsed) {
      return NextResponse.json(
        { error: "bad_request", message: "free optimization already used" },
        { status: 400 }
      );
    }

    if (site.pipelineStatus !== "complete") {
      return NextResponse.json(
        { error: "bad_request", message: "first audit is not yet complete" },
        { status: 400 }
      );
    }

    // Snapshot current scorecard, flip flags, re-enqueue
    await db
      .update(geoSites)
      .set({
        freeOptimizationUsed: true,
        freeRunNumber: 2,
        pipelineStatus: "pending",
        previousRunSnapshot: site.geoScorecard,
      })
      .where(eq(geoSites.id, id));

    // FIX-017: re-run the second audit on the row's own crawl budget (set at
    // creation, default 50) instead of letting the stage handler truncate to
    // FREE_MAX_PAGES (20).
    await enqueueStage({ siteId: id, domain: site.domain, stage: "discover", maxPages: site.crawlLimit ?? 50 });

    console.log(JSON.stringify({
      event: "v1_verify_enqueued",
      auditId: id,
      domain: site.domain,
      teamId: site.teamId,
      clientId: token.sub,
    }));

    return NextResponse.json({
      audit_id: id,
      status: "pending",
      free_run_number: 2,
    });

  } catch (err) {
    console.error("[v1/audit/:id/verify] error:", err);
    return NextResponse.json({ error: "internal_server_error" }, { status: 500 });
  }
}
