// Slug → site lookup with re-audit upgrade.
//
// Ported from geo/lib/serve-lookup.ts. Substitutions per plan:
//   - `@/lib/db` → relative `./db.ts`
//   - `@/lib/db/schema` → relative `./schema.ts`
//   - drizzle-orm imports → npm:drizzle-orm@<pin>
//
// Strategy preserved: always serves the LATEST complete audit for the
// domain, regardless of which slug the customer linked. Falls back to slug
// prefix match (covers re-audit slugs like "flowblinq-com-rkjDYU"), then
// exact slug for 404 handling.

import { and, desc, eq, isNotNull, like } from "npm:drizzle-orm@0.45.2";
import { db } from "./db.ts";
import { geoSites } from "./schema.ts";

/** Escape SQL LIKE wildcards to prevent unintended pattern matching */
function escapeLike(value: string): string {
  return value.replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export type AssetField =
  | "generatedLlmsTxt"
  | "generatedLlmsFullTxt"
  | "generatedBusinessJson"
  | "generatedSchemaBlocks";

export async function resolveSiteForServing(
  slug: string,
  assetField: AssetField,
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
          isNotNull(geoSites[assetField]),
        ),
      )
      .orderBy(desc(geoSites.createdAt))
      .limit(1);

    if (latest) return latest;
  }

  // 3. No exact slug match — try prefix matching
  if (!exact) {
    const safeSlug = escapeLike(slug);
    const [latestBySlug] = await db
      .select()
      .from(geoSites)
      .where(
        and(
          like(geoSites.slug, `${safeSlug}%`),
          eq(geoSites.pipelineStatus, "complete"),
          isNotNull(geoSites[assetField]),
        ),
      )
      .orderBy(desc(geoSites.createdAt))
      .limit(1);

    if (latestBySlug) return latestBySlug;
  }

  // 4. Fall back to exact match (even without asset, for 404 handling)
  return exact ?? null;
}
