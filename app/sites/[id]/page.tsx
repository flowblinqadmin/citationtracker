import { db } from "@/lib/db";
import { geoSiteView, teams, citationCheckScores, geoSites } from "@/lib/db/schema";
import { eq, desc, count } from "drizzle-orm";
import { FREE_AUDIT_LIMIT } from "@/lib/config";
import { notFound } from "next/navigation";
import { type RankedRec, type ChangeLogEntry } from "./types";
import SitePageClient from "./SitePageClient";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ token?: string }>;
}

export default async function SitePage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const { token } = await searchParams;

  const t0 = Date.now();
  const [site] = await db.select().from(geoSiteView).where(eq(geoSiteView.siteId, id));
  const t_site = Date.now();

  if (!site) notFound();

  // Treat expired/NULL tokenExpiresAt as no token — drop into the email gate
  // by clearing `token` here, mirroring API route behavior. We don't render an
  // error page for expiry; the client falls back to the email gate naturally.
  const tokenIsExpired =
    !!token && (!site.tokenExpiresAt || site.tokenExpiresAt < new Date());
  const effectiveToken = tokenIsExpired ? undefined : token;

  // If token provided in URL but doesn't match, deny access
  if (effectiveToken && site.accessToken !== effectiveToken) {
    return (
      <main style={{ minHeight: "100vh", background: "#000", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ textAlign: "center" }}>
          <h1 style={{ fontSize: "24px", fontWeight: 700, marginBottom: "8px" }}>Access denied</h1>
          <p style={{ color: "#666" }}>Invalid access token.</p>
          <a href="/" style={{ color: "#fff", marginTop: "16px", display: "inline-block" }}>Start a new audit</a>
        </div>
      </main>
    );
  }

  // Derive tier from team creditBalance (mirrors API gating logic in GET /api/sites/[id])
  let tier: "free" | "paid" = "free";
  let credits = 0;

  // Run team lookup + citation queries + owner email in parallel
  const [teamResult, lastCitationResult, citationHistory, allTeamDomains, ownerResult] = await Promise.all([
    site.teamId
      ? db.select().from(teams).where(eq(teams.id, site.teamId))
      : Promise.resolve([]),
    db.select().from(citationCheckScores)
      .where(eq(citationCheckScores.siteId, id))
      .orderBy(desc(citationCheckScores.createdAt))
      .limit(1),
    db.select().from(citationCheckScores)
      .where(eq(citationCheckScores.siteId, id))
      .orderBy(desc(citationCheckScores.createdAt))
      .limit(10),
    // Domain switcher: lightweight read from view table
    site.teamId
      ? db.select({
          id: geoSiteView.siteId,
          domain: geoSiteView.domain,
          geoScorecard: geoSiteView.pillars,  // only pillars needed for switcher score
          overallScore: geoSiteView.overallScore,
          pageCount: geoSiteView.pageCount,
        }).from(geoSiteView).where(eq(geoSiteView.teamId, site.teamId))
      : Promise.resolve([]),
    db.select({ ownerEmail: geoSites.ownerEmail }).from(geoSites).where(eq(geoSites.id, id)),
  ]);

  const teamRow = teamResult[0];
  if (teamRow && teamRow.creditBalance > 0) {
    tier = "paid";
    credits = teamRow.creditBalance;
  } else if (teamRow) {
    credits = teamRow.creditBalance;
  }

  const lastCitationCheck = lastCitationResult[0] ?? null;

  // Audit count for free tier remaining display
  const ownerEmail = ownerResult[0]?.ownerEmail;
  let freeAuditsRemaining: number | undefined;
  if (ownerEmail) {
    const [auditCountRow] = await db.select({ count: count() }).from(geoSites).where(eq(geoSites.ownerEmail, ownerEmail));
    const freeAuditsUsed = auditCountRow?.count ?? 0;
    freeAuditsRemaining = Math.max(0, FREE_AUDIT_LIMIT - freeAuditsUsed);
  }

  const t_parallel = Date.now();
  console.info(`[sites/page:timing] siteView=${t_site - t0}ms parallel=${t_parallel - t_site}ms total=${t_parallel - t0}ms siteId=${id}`);

  // Build safe site data for initial render (only if token matches).
  const allRankedRecs = (site.rankedRecommendations ?? []) as Array<Record<string, unknown>>;
  const fullSummary = site.executiveSummary ?? "";
  const pillars = (site.pillars ?? []) as Array<Record<string, unknown>>;

  // Reconstruct geoScorecard shape that SitePageClient expects
  const scorecard = site.overallScore != null ? {
    overallScore: site.overallScore,
    topThreeImprovements: [] as string[],
    pillars,
  } : null;

  const safeSite: import("./types").SiteData | null = effectiveToken && site.accessToken === effectiveToken ? {
    id: site.siteId,
    domain: site.domain,
    slug: site.slug,
    pipelineStatus: site.pipelineStatus,
    pipelineError: site.pipelineError,
    // Scorecard: free tier gets scores only (no findings/recommendations text)
    geoScorecard: tier === "paid" ? scorecard : (scorecard ? {
      overallScore: scorecard.overallScore,
      topThreeImprovements: scorecard.topThreeImprovements,
      pillars: pillars.map(p => ({
        pillar: p.pillar,
        pillarName: p.pillarName,
        score: p.score,
        weight: p.weight,
        priority: p.priority,
      })),
    } : null),
    // Executive summary: free tier gets first paragraph only
    executiveSummary: tier === "paid" ? site.executiveSummary : (fullSummary.split("\n\n")[0] ?? fullSummary),
    // Recommendations: free tier gets the diagnosis (title + problem description +
    // estimated boost) so the Action Plan is a real showcase — but NOT the
    // specificAction (the exact deploy-ready fix), which is the paid value.
    // (Conversion audit 2026-06-10: free was stripped to bare titles → empty/thin
    // expanded rows that did not sell.)
    rankedRecommendations: tier === "paid"
      ? allRankedRecs as unknown as RankedRec[]
      : allRankedRecs.slice(0, 3).map(r => ({
          title: r.title,
          pillar: r.pillar,
          priority: r.priority,
          description: r.description,
          estimatedBoost: r.estimatedBoost,
        })) as unknown as RankedRec[],
    projectedScore: site.projectedScore ?? null,
    projectedBoost: site.projectedBoost ?? null,
    // Generated files: null for free tier
    generatedLlmsTxt: tier === "paid" ? site.generatedLlmsTxt : null,
    generatedLlmsFullTxt: tier === "paid" ? site.generatedLlmsFullTxt : null,
    generatedBusinessJson: tier === "paid" ? site.generatedBusinessJson : null,
    generatedSchemaBlocks: tier === "paid" ? site.generatedSchemaBlocks : null,
    discoveryData: site.discoveryData,
    platformDetected: site.platformDetected,
    changeLog: (site.changeLog ?? []) as ChangeLogEntry[],
    shareToken: site.shareToken ?? null,
    shareUrl: site.shareToken ? `${process.env.NEXT_PUBLIC_APP_URL ?? "https://geo.flowblinq.com"}/report/${site.shareToken}` : null,
    pageCount: site.pageCount ?? 0,
    manualRunsThisMonth: site.manualRunsMonth,
    crawlCount: site.crawlCount,
    lastCrawlAt: site.lastCrawlAt?.toISOString() ?? null,
    nextCrawlAt: site.nextCrawlAt?.toISOString() ?? null,
    createdAt: site.createdAt?.toISOString() ?? null,
    diff: null,
    domainVerified: site.domainVerified ?? false,
    verifyToken: site.verifyToken ?? null,
    // Per-page fixes and implementation tracking: paid tier only
    perPageFixes: tier === "paid" ? (site.perPageFixes ?? null) : null,
    implementationStatus: tier === "paid" ? (site.implementationStatus ?? null) : null,
    perPageResults: tier === "paid" ? (site.perPageResults ?? null) : null,
    tier,
    credits,
    baselineScore: site.baselineScore ?? null,
    improvementDelta: site.baselineScore != null && site.overallScore != null
      ? site.overallScore - site.baselineScore
      : null,
    ...(tier === "paid" && site.baselineScorecard ? {
      baselineScorecard: site.baselineScorecard,
      pillarDeltas: (() => {
        const bl = site.baselineScorecard as { pillars?: Array<{ pillar: string; score: number }> } | null;
        return pillars.map((cp) => {
          const bp = (bl?.pillars ?? []).find((b) => b.pillar === (cp as { pillar: string }).pillar);
          return { pillar: cp.pillar, before: bp?.score ?? null, after: cp.score, delta: bp ? (cp.score as number) - bp.score : null };
        });
      })(),
    } : {}),
    token: effectiveToken ?? "",
    discoveredCompetitors: (site.discoveredCompetitors ?? []) as import("@/lib/types/citation").DiscoveredCompetitor[],
    userCompetitors: (site.userCompetitors ?? []) as import("@/lib/types/citation").UserCompetitor[],
    competitorBlocklist: (site.competitorBlocklist ?? []) as string[],
    brandKeywords: site.brandKeywords ?? null,
    extractedCategories: site.extractedCategories ?? null,
    citationNarrative: site.citationNarrative ?? null,
    subscriptionTier: teamRow?.subscriptionTier ?? "free",
  } as import("./types").SiteData : null;

  // Map allTeamDomains to the shape SitePageClient expects
  const teamDomainsForSwitcher = allTeamDomains.map(d => ({
    id: d.id,
    domain: d.domain,
    geoScorecard: d.overallScore != null ? { overallScore: d.overallScore } : null,
    pageCount: d.pageCount ?? 0,
  }));

  return (
    <SitePageClient
      site={safeSite}
      siteId={id}
      initialToken={effectiveToken}
      allTeamDomains={teamDomainsForSwitcher}
      lastCitationCheck={lastCitationCheck}
      citationHistory={citationHistory}
      credits={credits}
      freeAuditsRemaining={freeAuditsRemaining}
    />
  );
}
