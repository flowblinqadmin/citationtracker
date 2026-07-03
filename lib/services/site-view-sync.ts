/**
 * Sync helper: upserts geo_site_view from geo_sites after pipeline stage completion.
 * Called at the end of each pipeline stage that changes renderable data.
 */
import { db } from "@/lib/db";
import { geoSites, geoSiteView } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";

/**
 * Full sync: reads geoSites row and upserts all renderable fields into geo_site_view.
 * Called at the end of the assemble stage (all data finalized).
 */
export async function syncSiteView(siteId: string): Promise<void> {
  const [s] = await db.select().from(geoSites).where(eq(geoSites.id, siteId));
  if (!s) return;

  const scorecard = s.geoScorecard as { overallScore?: number; pillars?: unknown[] } | null;
  const recs = s.recommendations as { rankedRecommendations?: unknown[]; projectedScore?: number; projectedBoost?: number } | null;
  const prevSnap = s.previousRunSnapshot as { geoScorecard?: { overallScore?: number } } | null;
  const baseline = s.baselineScorecard as { overallScore?: number } | null;
  const crawlData = s.crawlData as { pages?: unknown[] } | null;

  const values = {
    siteId: s.id,
    domain: s.domain,
    slug: s.slug,
    teamId: s.teamId,
    accessToken: s.accessToken,
    // ES-090 §b.1 CRIT-1: mirror to view so GET /sites/[id] enforcement can
    // read expiry without a join to geo_sites.
    tokenExpiresAt: s.tokenExpiresAt,
    pipelineStatus: s.pipelineStatus,
    pipelineError: s.pipelineError,
    overallScore: scorecard?.overallScore ?? null,
    previousScore: prevSnap?.geoScorecard?.overallScore ?? null,
    projectedScore: recs?.projectedScore ?? null,
    projectedBoost: recs?.projectedBoost ?? null,
    baselineScore: baseline?.overallScore ?? null,
    pillars: scorecard?.pillars ?? null,
    pillarDeltas: null as unknown,
    pageCount: crawlData?.pages?.length ?? 0,
    crawlCount: s.crawlCount,
    manualRunsMonth: s.manualRunsThisMonth,
    executiveSummary: s.executiveSummary as string | null,
    rankedRecommendations: recs?.rankedRecommendations ?? null,
    changeLog: s.changeLog,
    perPageResults: s.perPageResults,
    perPageFixes: s.perPageFixes,
    implementationStatus: s.implementationStatus,
    generatedLlmsTxt: s.generatedLlmsTxt,
    generatedLlmsFullTxt: s.generatedLlmsFullTxt,
    generatedBusinessJson: s.generatedBusinessJson,
    generatedSchemaBlocks: s.generatedSchemaBlocks,
    discoveryData: s.discoveryData,
    platformDetected: s.platformDetected,
    shareToken: s.shareToken,
    domainVerified: s.domainVerified ?? false,
    verifyToken: s.verifyToken,
    citationNarrative: s.citationNarrative,
    discoveredCompetitors: s.discoveredCompetitors,
    brandKeywords: s.brandKeywords,
    extractedCategories: s.extractedCategories,
    baselineScorecard: s.baselineScorecard,
    lastCrawlAt: s.lastCrawlAt,
    nextCrawlAt: s.nextCrawlAt,
    createdAt: s.createdAt,
    updatedAt: new Date(),
  };

  await db.insert(geoSiteView).values(values)
    .onConflictDoUpdate({
      target: geoSiteView.siteId,
      set: { ...values, siteId: undefined } as Record<string, unknown>,
    });
}

/**
 * Lightweight sync: updates only pipeline status + specific fields.
 * Called during intermediate stages (discover, crawl, etc.) to keep status current.
 */
export async function syncSiteViewStatus(
  siteId: string,
  fields: Partial<{
    pipelineStatus: string;
    pipelineError: string | null;
    pageCount: number;
    accessToken: string;
    tokenExpiresAt: Date;
    teamId: string;
    domainVerified: boolean;
    citationRate: number;
    discoveredCompetitors: unknown;
    citationNarrative: string;
  }>
): Promise<void> {
  // Always read accessToken + tokenExpiresAt from geoSites so the view
  // stays in sync after token rotation (regenerate, verify re-login).
  // Without this, lightweight syncs leave these columns stale/NULL.
  if (!fields.accessToken || !fields.tokenExpiresAt) {
    const [src] = await db.select({
      accessToken: geoSites.accessToken,
      tokenExpiresAt: geoSites.tokenExpiresAt,
    }).from(geoSites).where(eq(geoSites.id, siteId));
    if (src) {
      if (!fields.accessToken) fields.accessToken = src.accessToken ?? undefined;
      if (!fields.tokenExpiresAt) fields.tokenExpiresAt = src.tokenExpiresAt ?? undefined;
    }
  }

  const updateFields: Record<string, unknown> = { ...fields, updatedAt: new Date() };

  // Try update first — if row exists. Use returning() to check if any row was affected.
  const updated = await db.update(geoSiteView)
    .set(updateFields)
    .where(eq(geoSiteView.siteId, siteId))
    .returning({ siteId: geoSiteView.siteId });

  // If no row exists yet (site just created), insert a minimal row
  if (updated.length === 0) {
    const [s] = await db.select({
      domain: geoSites.domain,
      slug: geoSites.slug,
      teamId: geoSites.teamId,
      accessToken: geoSites.accessToken,
      tokenExpiresAt: geoSites.tokenExpiresAt,
      createdAt: geoSites.createdAt,
    }).from(geoSites).where(eq(geoSites.id, siteId));
    if (!s) return;

    await db.insert(geoSiteView).values({
      siteId,
      domain: s.domain,
      slug: s.slug,
      teamId: s.teamId ?? fields.teamId,
      accessToken: s.accessToken ?? fields.accessToken,
      // ES-090 §b.1 CRIT-1: mirror expiry on view-row insertion.
      tokenExpiresAt: s.tokenExpiresAt ?? fields.tokenExpiresAt,
      pipelineStatus: fields.pipelineStatus ?? "pending",
      createdAt: s.createdAt,
      updatedAt: new Date(),
      ...fields,
    }).onConflictDoUpdate({
      target: geoSiteView.siteId,
      set: updateFields,
    });
  }
}
