import { db } from "@/lib/db";
import { geoSites } from "@/lib/db/schema";
import { eq, desc, and, isNotNull, like } from "drizzle-orm";

/**
 * Resolve a slug to the best available site record for serving assets.
 *
 * Always serves the LATEST complete audit for the domain, regardless of
 * which slug the customer linked. This ensures re-audits automatically
 * upgrade what gets served without customers updating their rewrite URLs.
 *
 * Strategy:
 * 1. Find the site by exact slug to get the domain
 * 2. Find the latest complete audit for that domain with the requested asset
 * 3. If no domain match, try slug prefix matching (covers re-audit slugs)
 * 4. Fall back to exact slug match if nothing else works
 */

/** Escape SQL LIKE wildcards to prevent unintended pattern matching */
function escapeLike(value: string): string {
  return value.replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export async function resolveSiteForServing(
  slug: string,
  assetField: "generatedLlmsTxt" | "generatedLlmsFullTxt" | "generatedBusinessJson" | "generatedSchemaBlocks"
) {
  // 1. Look up exact slug to get the domain
  const [exact] = await db
    .select()
    .from(geoSites)
    .where(eq(geoSites.slug, slug));

  const domain = exact?.domain;

  // 2. If we know the domain, find the latest complete audit with this asset
  if (domain) {
    const [latest] = await db
      .select()
      .from(geoSites)
      .where(
        and(
          eq(geoSites.domain, domain),
          eq(geoSites.pipelineStatus, "complete"),
          isNotNull(geoSites[assetField])
        )
      )
      .orderBy(desc(geoSites.createdAt))
      .limit(1);

    if (latest) return latest;
  }

  // 3. No exact slug match — try prefix matching (e.g., "flowblinq-com" matches "flowblinq-com-rkjDYU")
  if (!exact) {
    const safeSlug = escapeLike(slug);
    const [latestBySlug] = await db
      .select()
      .from(geoSites)
      .where(
        and(
          like(geoSites.slug, `${safeSlug}%`),
          eq(geoSites.pipelineStatus, "complete"),
          isNotNull(geoSites[assetField])
        )
      )
      .orderBy(desc(geoSites.createdAt))
      .limit(1);

    if (latestBySlug) return latestBySlug;
  }

  // 4. Fall back to exact match (even without asset, for 404 handling)
  return exact ?? null;
}
