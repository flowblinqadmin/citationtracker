import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { geoSiteView } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

interface RouteContext {
  params: Promise<{ shareToken: string }>;
}

/**
 * Public marketing report — accessible via /api/report/[shareToken]
 * Always uses free-tier gating regardless of payment status.
 */
export async function GET(req: NextRequest, { params }: RouteContext) {
  try {
    const { shareToken } = await params;

    const [site] = await db
      .select()
      .from(geoSiteView)
      .where(eq(geoSiteView.shareToken, shareToken));

    if (!site) {
      return NextResponse.json({ error: "Report not found" }, { status: 404 });
    }

    if (site.pipelineStatus !== "complete") {
      return NextResponse.json({
        error: "Report not ready yet",
        status: site.pipelineStatus,
      }, { status: 202 });
    }

    const allRankedRecs = (site.rankedRecommendations ?? []) as Array<Record<string, unknown>>;
    const pillars = (site.pillars ?? []) as Array<Record<string, unknown>>;

    // Scorecard: scores visible, findings stripped (free-tier gating)
    const gatedScorecard = site.overallScore != null ? {
      overallScore: site.overallScore,
      pillars: pillars.map(p => ({
        pillar: p.pillar,
        pillarName: p.pillarName,
        score: p.score,
        weight: p.weight,
        priority: p.priority,
      })),
    } : null;

    // Executive summary: first paragraph only
    const fullSummary = site.executiveSummary ?? "";
    const gatedSummary = fullSummary.split("\n\n")[0] ?? fullSummary;

    // Recommendations: first 3, titles + pillar + priority only
    const gatedRecs = allRankedRecs.slice(0, 3).map(r => ({
      title: r.title,
      pillar: r.pillar,
      priority: r.priority,
    }));

    return NextResponse.json({
      domain: site.domain,
      reportGeneratedAt: site.lastCrawlAt?.toISOString() ?? null,
      pipelineStatus: site.pipelineStatus,
      geoScorecard: gatedScorecard,
      executiveSummary: gatedSummary,
      rankedRecommendations: gatedRecs,
      projectedScore: site.projectedScore ?? null,
      projectedBoost: site.projectedBoost ?? null,
      crawlCount: site.crawlCount,
      nextCrawlAt: site.nextCrawlAt?.toISOString() ?? null,
      cta: {
        message: "The generated llms.txt, UCP manifest, and Schema.org blocks are managed by FlowBlinq GEO.",
        url: `${process.env.NEXT_PUBLIC_APP_URL ?? "https://geo.flowblinq.com"}/sites/${site.siteId}`,
        label: "Get your AI profile →",
      },
    });
  } catch (err) {
    console.error("GET /api/report/[shareToken] error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
