// POST /api/v1/audit — submit a URL for GEO audit (public API, JWT auth)

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { geoSites } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { verifyApiToken, requireScope } from "@/lib/api-auth";
import { normalizeDomain, slugify } from "@/lib/utils";
import { enqueueStage } from "@/lib/qstash";
import { PRIVATE_RANGES } from "@/lib/security/ssrf";

export async function POST(req: NextRequest) {
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

    const body = await req.json() as { url?: string; mode?: string };
    const { url } = body;

    if (!url || typeof url !== "string") {
      return NextResponse.json({ error: "url is required" }, { status: 400 });
    }

    // URL validation + SSRF guard
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return NextResponse.json({ error: "invalid_url" }, { status: 400 });
    }
    if (!parsedUrl.hostname || !parsedUrl.hostname.includes(".")) {
      return NextResponse.json({ error: "invalid_url" }, { status: 400 });
    }
    if (PRIVATE_RANGES.some((r) => r.test(parsedUrl.hostname))) {
      return NextResponse.json({ error: "invalid_url" }, { status: 400 });
    }

    const domain = normalizeDomain(url);
    const teamId = token.team_id;

    // Check for existing site for this team + domain
    const [existing] = await db
      .select()
      .from(geoSites)
      .where(and(eq(geoSites.domain, domain), eq(geoSites.teamId, teamId)));

    if (existing) {
      // Case D — in-progress: return existing audit_id
      if (existing.pipelineStatus === "pending" || existing.pipelineStatus === "running" || existing.pipelineStatus === "crawling" || existing.pipelineStatus === "discovery" || existing.pipelineStatus === "research" || existing.pipelineStatus === "generating") {
        return NextResponse.json({
          audit_id: existing.id,
          status: existing.pipelineStatus,
          free_run_number: existing.freeRunNumber ?? 1,
        });
      }

      // Case C — free tier exhausted
      if (existing.freeRunNumber === 2 && existing.freeOptimizationUsed) {
        console.warn(JSON.stringify({ event: "v1_audit_free_tier_block", domain, teamId, clientId: token.sub }));
        return NextResponse.json(
          { error: "free_tier_exhausted", credits_purchase_url: "https://geo.flowblinq.com/dashboard" },
          { status: 402 }
        );
      }

      // Case B — first run complete, not yet optimized
      if (existing.freeRunNumber === 1 && !existing.freeOptimizationUsed && existing.pipelineStatus === "complete") {
        return NextResponse.json(
          {
            error: "audit_exists",
            message: "Audit complete. Use POST /api/v1/audit/" + existing.id + "/verify to trigger the post-optimization second run.",
            audit_id: existing.id,
          },
          { status: 409 }
        );
      }
    }

    // Case A — create new site
    const siteId = nanoid();
    const slug = slugify(domain) + "-" + nanoid(6);
    // FIX-017: single source for the v1 free-tier crawl budget so the row's
    // crawlLimit and the discover enqueue's maxPages stay in lockstep.
    const crawlLimit = 50; // Free tier cap (spec § Notes #3)

    await db.insert(geoSites).values({
      id: siteId,
      domain,
      slug,
      ownerEmail: `api-client@flowblinq.com`, // placeholder — no email for API-created sites
      teamId,
      emailVerified: true,      // API clients are pre-authenticated via OAuth
      accessToken: nanoid(32),
      pipelineStatus: "pending",
      crawlLimit,
      freeRunNumber: 1,
      freeOptimizationUsed: false,
      apiClientId: token.sub,   // clientId from JWT
    });

    // Kick off pipeline
    // FIX-017: pass maxPages explicitly so the stage handler crawls the row's
    // budget (50) rather than silently falling back to FREE_MAX_PAGES (20).
    await enqueueStage({ siteId, domain, stage: "discover", maxPages: crawlLimit });

    console.log(JSON.stringify({
      event: "v1_audit_submitted",
      auditId: siteId,
      domain,
      teamId,
      clientId: token.sub,
      freeRunNumber: 1,
    }));

    return NextResponse.json(
      {
        audit_id: siteId,
        status: "pending",
        free_tier: true,
        free_run_number: 1,
        estimated_completion_seconds: 120,
      },
      { status: 201 }
    );

  } catch (err) {
    console.error("[v1/audit] error:", err);
    return NextResponse.json({ error: "internal_server_error" }, { status: 500 });
  }
}
