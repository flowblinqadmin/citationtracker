/**
 * POST /api/pipeline/crawl-webhook
 *
 * Firecrawl webhook callback — replaces the poll-chunk loop.
 * Auth: CRON_SECRET in x-webhook-secret header (set via Firecrawl webhook config).
 *
 * HP perf review Fix 2: Firecrawl webhooks eliminate 15-30s of polling overhead per chunk.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { geoSites, firecrawlJobs } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { enqueueStage } from "@/lib/qstash";
import {
  mapDocumentToPage,
  normalizeUrlForComparison,
  type FcDoc,
  type CrawledPage,
  type DiscoveryData,
} from "@/lib/services/geo-crawler";

export const maxDuration = 30;

async function fanInChunk(
  siteId: string,
  pages: CrawledPage[],
  failedUrls: string[] = []
): Promise<{ done: number; total: number }> {
  const pagesJson = JSON.stringify(pages);
  const failedJson = JSON.stringify(failedUrls);
  const result = await db.execute(sql`
    UPDATE geo_sites
    SET
      crawl_chunk_results = COALESCE(crawl_chunk_results, '[]'::jsonb) || ${pagesJson}::jsonb,
      crawl_chunks_done = crawl_chunks_done + 1,
      crawl_failed_urls = COALESCE(crawl_failed_urls, '[]'::jsonb) || ${failedJson}::jsonb,
      updated_at = NOW()
    WHERE id = ${siteId}
    RETURNING crawl_chunks_done AS done, crawl_chunks_total AS total
  `);
  const row = (result as unknown as Array<{ done: number; total: number }>)[0];
  return { done: row?.done ?? 0, total: row?.total ?? 0 };
}

export async function POST(req: NextRequest) {
  try {
    // Auth: verify webhook secret
    const secret = req.headers.get("x-webhook-secret");
    if (secret !== process.env.CRON_SECRET) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json() as {
      success: boolean;
      id: string; // firecrawl job ID
      status: string;
      data?: unknown[];
      metadata?: Record<string, string>;
    };

    const siteId = body.metadata?.siteId;
    const domain = body.metadata?.domain;
    const chunkIndex = parseInt(body.metadata?.chunkIndex ?? "0", 10);
    const firecrawlJobId = body.id;

    if (!siteId || !domain) {
      console.error("[crawl-webhook] Missing siteId or domain in metadata");
      return NextResponse.json({ error: "Missing metadata" }, { status: 400 });
    }

    console.warn(`[crawl-webhook] ${domain} chunk ${chunkIndex}: status=${body.status}, docs=${(body.data ?? []).length}`);

    // FIX-031 (2026-06-09): Firecrawl v2 webhooks send event-typed payloads
    // (type: "batch_scrape.page" / ".completed", no top-level `status`, data
    // delivered incrementally). This handler was written for the v1 shape
    // (status + full data array). When a v2 event landed here, status was
    // undefined and docs was empty, so the chunk got stamped completed with
    // ZERO pages and every URL marked failed -- destroying chunks before the
    // poll-chunk safety net could fetch the real results (only race-winning
    // chunks survived: 5-10 pages instead of ~45). Until the v2 migration is
    // finished, accept only payloads matching the v1 contract; everything
    // else defers to poll-chunk, which fetches full results via the API.
    const docsArrived = Array.isArray(body.data) && body.data.length > 0;
    if (body.status !== "failed" && !(body.status === "completed" && docsArrived)) {
      console.warn(`[crawl-webhook] ${domain} chunk ${chunkIndex}: unrecognized/incomplete payload (status=${body.status}); deferring to poll-chunk`);
      return NextResponse.json({ ok: true, deferred: true });
    }

    if (body.status === "failed") {
      // Fan-in with empty pages so the pipeline can proceed
      const { done, total } = await fanInChunk(siteId, []);
      if (done === total) {
        // Import handleMergeCrawl would create a circular dep — use enqueueStage
        // (merge-crawl case arm still exists for this path)
        await enqueueStage({ siteId, domain, stage: "merge-crawl" });
      }
      return NextResponse.json({ ok: true });
    }

    // Map Firecrawl docs to CrawledPage objects
    const [site] = await db.select({
      discoveryData: geoSites.discoveryData,
    }).from(geoSites).where(eq(geoSites.id, siteId));

    const pageMap = (site?.discoveryData as DiscoveryData | null)?.pageMap ?? {};
    const docs = (body.data ?? []) as FcDoc[];
    const pages = docs
      .map((d) => mapDocumentToPage(d, pageMap as Record<string, import("@/lib/services/geo-crawler").PageType>))
      .filter((p): p is CrawledPage => p !== null);

    // Compute page-level failures
    const [jobRow] = await db.select({ urlsSubmitted: firecrawlJobs.urlsSubmitted })
      .from(firecrawlJobs).where(eq(firecrawlJobs.firecrawlJobId, firecrawlJobId));
    // FIX-032: compare on normalized URLs -- Firecrawl returns post-redirect
    // forms that never string-match the submitted URLs.
    const successfulUrls = new Set(pages.map((p) => normalizeUrlForComparison(p.url)));
    const pageFailedUrls = ((jobRow?.urlsSubmitted as string[] | null) ?? [])
      .filter((u) => !successfulUrls.has(normalizeUrlForComparison(u)));

    // Update firecrawl_jobs row
    await db.update(firecrawlJobs)
      .set({ status: "completed", urlsCompleted: pages.map((p) => p.url), updatedAt: new Date() })
      .where(eq(firecrawlJobs.firecrawlJobId, firecrawlJobId));

    // Atomic fan-in
    const { done, total } = await fanInChunk(siteId, pages, pageFailedUrls);
    console.warn(`[crawl-webhook] ${domain} chunk ${chunkIndex}: ${pages.length} pages, fan-in ${done}/${total}`);

    if (done === total) {
      await enqueueStage({ siteId, domain, stage: "merge-crawl" });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[crawl-webhook] Error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
