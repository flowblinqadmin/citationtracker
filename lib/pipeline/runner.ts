import { db } from "@/lib/db";
import { geoSites } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { classifyPageType } from "@/lib/services/geo-crawler";
import { enqueueStage } from "@/lib/qstash";

/**
 * @deprecated Use /api/pipeline/stage (QStash) instead. Kept for /api/pipeline/run backward compat.
 *
 * Phase 1 — called inside next/server after() so it runs after the HTTP response is sent.
 * Enqueues the discover stage, which owns discovery + snapshot + crawl-fanout.
 */
export async function startCrawl(siteId: string, domain: string, maxPages = 100): Promise<void> {
  try {
    // ES-023: enqueue discover — handleDiscover in /api/pipeline/stage owns the full
    // discovery + snapshot + crawl-fanout chain. Do not duplicate that logic here.
    await enqueueStage({ siteId, domain, stage: "discover", maxPages });
    console.warn(`[pipeline] startCrawl: enqueued discover for ${domain}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`startCrawl failed for site ${siteId}:`, message);
    await db.update(geoSites)
      .set({ pipelineStatus: "failed", pipelineError: message, updatedAt: new Date() })
      .where(eq(geoSites.id, siteId));
    throw error;
  }
}

/**
 * @deprecated Use /api/pipeline/stage (QStash) instead. Kept for /api/pipeline/run backward compat.
 *
 * Bulk Phase 1 — called inside next/server after() from verify route.
 * Skips discovery: builds synthetic discoveryData from CSV URLs,
 * then enqueues crawl-fanout for all URLs.
 */
export async function startBulkCrawl(
  siteId: string,
  domain: string,
  bulkUrls: string[]
): Promise<void> {
  try {
    // Build synthetic discoveryData from provided URLs
    const pageMap: Record<string, ReturnType<typeof classifyPageType>> = {};
    for (const url of bulkUrls) {
      pageMap[url] = classifyPageType(url);
    }

    const discoveryData = {
      urls: bulkUrls,
      pageMap,
      hasLlmsTxt: false,
      hasUcp: false,
      hasSitemap: false,
      hasRobots: false,
      totalPages: bulkUrls.length,
    };

    // Store discoveryData + set status to crawling (skip discovery stage)
    await db.update(geoSites).set({
      discoveryData: discoveryData as unknown as Record<string, unknown>,
      pipelineStatus: "crawling",
      updatedAt: new Date(),
    }).where(eq(geoSites.id, siteId));

    // ES-023: delegate to QStash crawl-fanout pipeline.
    await enqueueStage({ siteId, domain, stage: "crawl-fanout" });
    console.log(JSON.stringify({ event: "bulk_crawl_fanout_enqueued", siteId, urlCount: bulkUrls.length }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`startBulkCrawl failed for site ${siteId}:`, message);
    await db.update(geoSites)
      .set({ pipelineStatus: "failed", pipelineError: message, updatedAt: new Date() })
      .where(eq(geoSites.id, siteId));
    throw error;
  }
}

/**
 * @deprecated Use /api/pipeline/stage (QStash) instead. Kept for /api/pipeline/run backward compat.
 *
 * Phase 2 — called by /api/cron/process-queue every minute.
 * Polls Firecrawl jobs, merges results, runs AI analysis, sets status = "complete".
 * Returns "not-ready" if Firecrawl jobs are still running.
 * Returns "complete" or "failed" when done.
 */
export async function completePipeline(_siteId: string, _domain: string): Promise<"not-ready" | "complete" | "failed"> {
  // @deprecated ES-023: QStash poll-chunk handlers manage crawl completion.
  // This stub is kept so callers compile; it is a no-op at runtime.
  return "not-ready";
}

/**
 * @deprecated Use /api/pipeline/stage (QStash) instead. Kept for /api/pipeline/run backward compat.
 *
 * Legacy monolithic runner — enqueues discover and returns.
 * Full pipeline now runs via /api/pipeline/stage (QStash).
 */
export async function runPipeline(siteId: string, domain: string, maxPages = 100): Promise<void> {
  try {
    // ES-023: delegate entirely to QStash pipeline starting at discover.
    // handleDiscover owns snapshot, discovery, and crawl-fanout enqueue.
    // FIX-017: pass an explicit maxPages (default 100, matching startCrawl) so
    // this deprecated entry point doesn't enqueue discover without a budget and
    // get truncated to FREE_MAX_PAGES (20).
    await enqueueStage({ siteId, domain, stage: "discover", maxPages });
    console.warn(`[pipeline] runPipeline: enqueued discover for ${domain}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Pipeline failed for site ${siteId}:`, message);
    await db.update(geoSites)
      .set({ pipelineStatus: "failed", pipelineError: message, updatedAt: new Date() })
      .where(eq(geoSites.id, siteId));
    throw error;
  }
}
