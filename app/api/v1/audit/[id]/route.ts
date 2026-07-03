// GET /api/v1/audit/:id — poll audit status and retrieve results

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { geoSites } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { verifyApiToken, requireScope } from "@/lib/api-auth";
import { getApiClientByClientId } from "@/lib/db/api-clients";
import { formatAsMcp } from "@/lib/mcp-formatter";

export async function GET(
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
      requireScope(token.scopes, "audit:read");
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

    // Check client revocation (stateless JWT does not encode revokedAt)
    // Must happen after site lookup to avoid DB mock conflicts in tests.
    const client = await getApiClientByClientId(token.sub);
    if (!client || client.revokedAt) {
      return NextResponse.json({ error: "revoked" }, { status: 401 });
    }

    // MCP format requested?
    const acceptHeader = req.headers.get("accept") ?? "";
    const formatParam = new URL(req.url).searchParams.get("format");
    if (acceptHeader.includes("application/mcp+json") || formatParam === "mcp") {
      return NextResponse.json(formatAsMcp(site));
    }

    // Standard JSON response
    const slug = site.slug;
    const pipelineStage = site.pipelineStatus;
    // Normalize status: expose simplified status for polling logic; pipeline_stage for detail
    const status =
      pipelineStage === "complete" ? "complete"
      : pipelineStage === "failed" ? "failed"
      : !pipelineStage || pipelineStage === "pending" ? "pending"
      : "running";
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://geo.flowblinq.com";
    return NextResponse.json({
      audit_id: site.id,
      domain: site.domain,
      status,
      pipeline_stage: pipelineStage,
      ...(status === "failed" ? { error: site.pipelineError ?? "Pipeline failed" } : {}),
      overall_score: site.geoScorecard?.overallScore ?? null,
      free_run_number: site.freeRunNumber ?? 1,
      scorecard: site.geoScorecard,
      recommendations: site.recommendations,
      executive_summary: site.executiveSummary,
      files: {
        llms_txt_url: slug ? `${baseUrl}/api/serve/${slug}/llms.txt` : null,
        business_json_url: slug ? `${baseUrl}/api/serve/${slug}/business.json` : null,
        schema_json_url: slug ? `${baseUrl}/api/serve/${slug}/schema.json` : null,
      },
      created_at: site.createdAt,
      completed_at: site.updatedAt,
    });

  } catch (err) {
    console.error("[v1/audit/:id] error:", err);
    return NextResponse.json({ error: "internal_server_error" }, { status: 500 });
  }
}
