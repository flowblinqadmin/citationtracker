import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { geoSiteView, teams } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const token = req.headers.get("authorization")?.replace("Bearer ", "") ??
      req.nextUrl.searchParams.get("token");

    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [site] = await db.select().from(geoSiteView).where(eq(geoSiteView.siteId, id));

    if (!site) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (site.accessToken !== token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // ES-090 §b.2 CRIT-1: HP-197 — NULL tokenExpiresAt treated as expired.
    // Belt-and-suspenders with the NOT NULL column default on geo_sites.
    if (!site.tokenExpiresAt || site.tokenExpiresAt < new Date()) {
      return NextResponse.json(
        { error: "Unauthorized", code: "TOKEN_EXPIRED" },
        { status: 401 },
      );
    }

    // --- Tier derivation ---
    let tier: "free" | "paid" = "free";
    let credits = 0;

    if (site.teamId) {
      try {
        const [team] = await db.select().from(teams).where(eq(teams.id, site.teamId));
        if (team && team.creditBalance > 0) {
          tier = "paid";
          credits = team.creditBalance;
        } else if (team) {
          credits = team.creditBalance;
        }
      } catch (teamErr) {
        console.warn(JSON.stringify({ event: "tier_derivation_error", siteId: id, teamId: site.teamId, error: String(teamErr) }));
      }
    }

    const allRankedRecs = (site.rankedRecommendations ?? []) as Array<Record<string, unknown>>;
    const pillars = (site.pillars ?? []) as Array<Record<string, unknown>>;
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://geo.flowblinq.com";

    // Build diff summary if previous score exists
    let diff: Record<string, unknown> | null = null;
    if (site.previousScore != null && site.overallScore != null) {
      diff = {
        scoreDelta: site.overallScore - site.previousScore,
        previousScore: site.previousScore,
        currentScore: site.overallScore,
        currentLlmsTxtLength: site.generatedLlmsTxt?.length ?? 0,
      };
    }

    // --- Always-included fields ---
    const response: Record<string, unknown> = {
      id: site.siteId,
      domain: site.domain,
      slug: site.slug,
      tier,
      credits,
      pipelineStatus: site.pipelineStatus,
      pipelineError: site.pipelineError,
      discoveryData: site.discoveryData,
      platformDetected: site.platformDetected,
      projectedScore: site.projectedScore ?? null,
      projectedBoost: site.projectedBoost ?? null,
      shareToken: site.shareToken,
      shareUrl: site.shareToken ? `${appUrl}/report/${site.shareToken}` : null,
      domainVerified: site.domainVerified ?? false,
      verifyToken: site.verifyToken ?? null,
      changeLog: site.changeLog ?? [],
      manualRunsThisMonth: site.manualRunsMonth,
      crawlCount: site.crawlCount,
      // Issue O (2026-04-10): pageCount was missing from the API response,
      // causing SitePageClient's client-side refetch to overwrite the SSR
      // pageCount=N with undefined. The fallback chain at SitePageClient.tsx:494
      // (site.pageCount ?? crawlData.pages.length ?? 0) then resolved to 0
      // because neither field was present. Header stats row now gets the
      // correct "N pages crawled" display after client refetch.
      pageCount: site.pageCount ?? 0,
      lastCrawlAt: site.lastCrawlAt?.toISOString() ?? null,
      nextCrawlAt: site.nextCrawlAt?.toISOString() ?? null,
      createdAt: site.createdAt?.toISOString() ?? null,
      diff,
    };

    // --- Baseline scoring ---
    const baseline = site.baselineScorecard as { overallScore?: number; pillars?: Array<{ pillar: string; score: number }> } | null;
    response.baselineScore = site.baselineScore ?? null;
    response.improvementDelta =
      site.baselineScore != null && site.overallScore != null
        ? site.overallScore - site.baselineScore
        : null;

    // --- Tier-gated fields ---
    if (tier === "paid") {
      // Reconstruct geoScorecard shape the client expects
      response.geoScorecard = site.overallScore != null ? { overallScore: site.overallScore, pillars } : null;
      response.executiveSummary = site.executiveSummary;
      response.rankedRecommendations = allRankedRecs;
      response.generatedLlmsTxt = site.generatedLlmsTxt;
      response.generatedLlmsFullTxt = site.generatedLlmsFullTxt;
      response.generatedBusinessJson = site.generatedBusinessJson;
      response.generatedSchemaBlocks = site.generatedSchemaBlocks;
      response.perPageResults = site.perPageResults ?? null;
      response.perPageFixes = site.perPageFixes ?? null;
      response.implementationStatus = site.implementationStatus ?? null;

      if (baseline) {
        response.baselineScorecard = baseline;
        const baselinePillars = baseline.pillars ?? [];
        response.pillarDeltas = pillars.map((cp) => {
          const bp = baselinePillars.find((b) => b.pillar === (cp as { pillar: string }).pillar);
          return {
            pillar: cp.pillar,
            before: bp?.score ?? null,
            after: cp.score,
            delta: bp ? (cp.score as number) - bp.score : null,
          };
        });
      }
    } else {
      // Free tier: scores visible, findings stripped
      if (site.overallScore != null) {
        response.geoScorecard = {
          overallScore: site.overallScore,
          pillars: pillars.map(p => ({
            pillar: p.pillar,
            pillarName: p.pillarName,
            score: p.score,
            weight: p.weight,
            priority: p.priority,
          })),
        };
      } else {
        response.geoScorecard = null;
      }

      const fullSummary = site.executiveSummary ?? "";
      response.executiveSummary = fullSummary.split("\n\n")[0] ?? fullSummary;

      // Free tier gets the DIAGNOSIS (title + problem description + estimated boost)
      // so the Action Plan is a real showcase — but NOT specificAction (the exact
      // deploy-ready fix), which is the paid value. Must match the server-render
      // projection in app/sites/[id]/page.tsx, or a client refetch would drop the
      // description and the Action Plan would go empty (conversion audit 2026-06-10).
      response.rankedRecommendations = allRankedRecs.slice(0, 3).map(r => ({
        title: r.title,
        pillar: r.pillar,
        priority: r.priority,
        description: r.description,
        estimatedBoost: r.estimatedBoost,
      }));

      response.generatedLlmsTxt = null;
      response.generatedLlmsFullTxt = null;
      response.generatedBusinessJson = null;
      response.generatedSchemaBlocks = null;
    }

    return NextResponse.json(response);
  } catch (err) {
    console.error("GET /api/sites/[id] error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
