/**
 * Probes live integration state: llms.txt, schema.json, tracking pixel.
 * Caches HEAD probe results for 15 minutes to avoid redundant fetches.
 * Tracking pixel query is always fresh (cheap indexed query).
 */

import { db } from "@/lib/db";
import { geoPageViews, integrationProbeCache } from "@/lib/db/schema";
import { proxyFetch } from "@/lib/proxy-fetch";
import { eq, sql, max } from "drizzle-orm";

export interface IntegrationLive {
  llmsTxt: { ok: boolean; method: string | null; checkedAt: Date };
  schemaJson: { ok: boolean; checkedAt: Date };
  trackingPixel: { lastSeenAt: Date | null };
  generatedArtifactsReady: { llmsTxt: boolean; schemaBlocks: number; businessJson: boolean };
}

export async function probeIntegration(
  site: {
    siteId: string;
    slug: string;
    domain: string;
    generatedLlmsTxt?: string | null;
    generatedSchemaBlocks?: unknown[] | null;
    generatedBusinessJson?: unknown | null;
  },
  opts?: { force?: boolean },
): Promise<IntegrationLive> {
  const now = new Date();
  const cacheWindow = 15 * 60 * 1000; // 15 minutes

  // Try cache hit first (unless forced)
  let cached: typeof integrationProbeCache.$inferSelect | undefined;
  if (!opts?.force) {
    const [row] = await db
      .select()
      .from(integrationProbeCache)
      .where(eq(integrationProbeCache.siteId, site.siteId));
    cached = row;
  }

  let llmsTxtOk = cached?.llmsTxtOk ?? false;
  let llmsTxtMethod = cached?.llmsTxtMethod ?? null;
  let llmsTxtCheckedAt = cached?.llmsTxtCheckedAt ?? now;

  let schemaJsonOk = cached?.schemaJsonOk ?? false;
  let schemaJsonCheckedAt = cached?.schemaJsonCheckedAt ?? now;

  // If cache miss or stale, probe llms.txt
  if (!cached || !cached.llmsTxtCheckedAt || (now.getTime() - cached.llmsTxtCheckedAt.getTime() > cacheWindow)) {
    const result = await proxyFetch(`https://${site.domain}/llms.txt`, { method: "HEAD" });
    llmsTxtOk = result?.ok ?? false;
    llmsTxtMethod = result?.method ?? null;
    llmsTxtCheckedAt = now;
  }

  // If cache miss or stale, probe schema.json
  if (!cached || !cached.schemaJsonCheckedAt || (now.getTime() - cached.schemaJsonCheckedAt.getTime() > cacheWindow)) {
    const result = await proxyFetch(`https://${site.domain}/schema.json`, { method: "HEAD" });
    schemaJsonOk = result?.ok ?? false;
    schemaJsonCheckedAt = now;
  }

  // Tracking pixel: always query fresh (indexed by slug, cheap)
  const [pixelRow] = await db
    .select({ lastSeenAt: max(geoPageViews.viewedAt) })
    .from(geoPageViews)
    .where(eq(geoPageViews.slug, site.slug));

  const trackingPixelLastSeenAt = pixelRow?.lastSeenAt ?? null;

  // Generated artifacts: read from site columns directly, no DB hit
  const generatedArtifactsReady = {
    llmsTxt: !!site.generatedLlmsTxt,
    schemaBlocks: Array.isArray(site.generatedSchemaBlocks) ? site.generatedSchemaBlocks.length : 0,
    businessJson: !!site.generatedBusinessJson,
  };

  // Write to cache (upsert)
  await db
    .insert(integrationProbeCache)
    .values({
      siteId: site.siteId,
      llmsTxtOk,
      llmsTxtMethod,
      llmsTxtCheckedAt,
      schemaJsonOk,
      schemaJsonCheckedAt,
      trackingPixelLastSeenAt,
      refreshedAt: now,
    })
    .onConflictDoUpdate({
      target: integrationProbeCache.siteId,
      set: {
        llmsTxtOk,
        llmsTxtMethod,
        llmsTxtCheckedAt,
        schemaJsonOk,
        schemaJsonCheckedAt,
        trackingPixelLastSeenAt,
        refreshedAt: now,
      },
    })
    .catch(() => {
      // Silently fail cache writes — probe result is still valid
    });

  return {
    llmsTxt: { ok: llmsTxtOk, method: llmsTxtMethod, checkedAt: llmsTxtCheckedAt },
    schemaJson: { ok: schemaJsonOk, checkedAt: schemaJsonCheckedAt },
    trackingPixel: { lastSeenAt: trackingPixelLastSeenAt },
    generatedArtifactsReady,
  };
}
