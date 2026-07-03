/**
 * T226 / HP-156 — Backfill citation_check_responses.competitors_mentioned for
 * historical rows where the per-response extractor returned [].
 *
 * Pre-TS-081 the citation extractor was URL-only, which captured ~3% of the
 * real signal because LLMs mention competitors by brand name, not by domain.
 * Production rows from before the HP-146/HP-148/HP-150 fan-out have empty
 * competitors_mentioned arrays even when the response body literally names
 * the competitors. This script walks every citation_check_responses row,
 * re-runs the post-fix `extractCompetitors` against the response body, and
 * rewrites competitors_mentioned with the recovered signal.
 *
 * Site scoping: a row is only re-run if its parent site has a non-empty
 * `discovered_competitors` array (extractCompetitors needs the keyword map
 * to do brand-name matching).
 *
 * Idempotent: rows whose competitors_mentioned is already non-empty are
 * skipped (we never overwrite work). To force-rebackfill a row, set
 * competitors_mentioned to NULL or [] in psql first.
 *
 * Dry-run by default: prints a CSV delta to stdout. Pass `--commit` to
 * actually persist.
 *
 * Usage:
 *   ~/.nvm/versions/node/v22.12.0/bin/node --env-file=.env.local \
 *     ./node_modules/.bin/tsx scripts/backfill-competitors-mentioned.ts
 *   ... add --commit to write
 *   ... add --site-id=<id> to scope
 *   ... add --limit=<N> to cap rows processed
 *
 * Acceptance (HP-156 re-review):
 *   1. Dry-run mode + delta CSV     ← stdout
 *   2. Idempotency (skip non-empty) ← in-loop guard
 *   3. After backfill against staging Manipal, row QH1EepHTOpK6hsh80VPJ1
 *      has non-empty competitors_mentioned
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, and, sql } from "drizzle-orm";
import { citationCheckResponses, geoSites } from "../lib/db/schema";
import { extractCompetitors } from "../lib/services/citation-checker";
import { extractCompetitorBrandKeywords } from "../lib/services/brand-detector";
import type { DiscoveredCompetitor } from "../lib/types/citation";

// ── CLI args ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const COMMIT = argv.includes("--commit");
const SITE_ID = argv.find(a => a.startsWith("--site-id="))?.split("=")[1];
const LIMIT = (() => {
  const l = argv.find(a => a.startsWith("--limit="))?.split("=")[1];
  return l ? parseInt(l, 10) : Number.POSITIVE_INFINITY;
})();

// ── DB ──────────────────────────────────────────────────────────────────────

const dbUrl = process.env.SUPABASE_DATABASE_URL ?? process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
if (!dbUrl) {
  console.error("ERROR: No DATABASE_URL set");
  process.exit(1);
}

const client = postgres(dbUrl, { max: 3, prepare: false, idle_timeout: 20 });
const db = drizzle(client);

// ── Backfill ────────────────────────────────────────────────────────────────

async function main() {
  console.error(
    `[backfill-mentioned] mode=${COMMIT ? "COMMIT" : "DRY-RUN"} ` +
    `${SITE_ID ? `site=${SITE_ID}` : "site=ALL"} ` +
    `limit=${LIMIT === Number.POSITIVE_INFINITY ? "∞" : LIMIT}`,
  );

  // 1. Find sites with non-empty discovered_competitors (the only sites where
  //    the brand-name extractor can recover anything).
  const sites = await db
    .select({
      id: geoSites.id,
      domain: geoSites.domain,
      discoveredCompetitors: geoSites.discoveredCompetitors,
    })
    .from(geoSites);

  const eligibleSites = sites.filter(s => {
    if (SITE_ID && s.id !== SITE_ID) return false;
    const dc = s.discoveredCompetitors as DiscoveredCompetitor[] | null | undefined;
    return dc && dc.length > 0;
  });

  console.error(`[backfill-mentioned] eligible sites: ${eligibleSites.length}`);

  // CSV header on stdout
  process.stdout.write("response_id,site_id,domain,old_count,new_count,new_competitors\n");

  let scanned = 0;
  let rowsTouched = 0;
  let entriesRecovered = 0;

  for (const site of eligibleSites) {
    if (scanned >= LIMIT) break;

    const competitorKeywords = extractCompetitorBrandKeywords(
      (site.discoveredCompetitors as DiscoveredCompetitor[]).map(c => ({
        name: c.name,
        domain: c.domain,
      })),
    );

    if (competitorKeywords.size === 0) continue;

    // Pull responses for this site whose competitors_mentioned is empty/null
    const rows = await db
      .select({
        id: citationCheckResponses.id,
        siteId: citationCheckResponses.siteId,
        response: citationCheckResponses.response,
        competitorsMentioned: citationCheckResponses.competitorsMentioned,
      })
      .from(citationCheckResponses)
      .where(eq(citationCheckResponses.siteId, site.id));

    for (const row of rows) {
      if (scanned >= LIMIT) break;
      scanned++;

      const existing = (row.competitorsMentioned ?? []) as string[];
      if (existing.length > 0) continue; // idempotent: skip non-empty

      if (!row.response) continue;

      const recovered = extractCompetitors(
        row.response,
        site.domain,
        competitorKeywords,
        // No categoryKeywords here — backfill runs without site categorization
        // context. detectCompetitorMentions will WARN-and-fall-through for
        // ambiguous brands when cats is empty (HP-153 contract).
        [],
      );

      if (recovered.length === 0) continue;

      const csvCompetitors = JSON.stringify(recovered.join(";"));
      process.stdout.write(
        [
          row.id,
          site.id,
          site.domain,
          existing.length.toString(),
          recovered.length.toString(),
          csvCompetitors,
        ].join(",") + "\n",
      );

      rowsTouched++;
      entriesRecovered += recovered.length;

      if (COMMIT) {
        await db
          .update(citationCheckResponses)
          .set({ competitorsMentioned: recovered })
          .where(eq(citationCheckResponses.id, row.id));
      }
    }
  }

  console.error(
    `[backfill-mentioned] done. scanned=${scanned} rowsTouched=${rowsTouched} ` +
    `entriesRecovered=${entriesRecovered} mode=${COMMIT ? "COMMIT" : "DRY-RUN"}`,
  );

  await client.end();
}

main().catch(err => {
  console.error("[backfill-mentioned] FATAL:", err);
  process.exit(1);
});
