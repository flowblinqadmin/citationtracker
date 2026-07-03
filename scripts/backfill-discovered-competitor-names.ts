/**
 * T227 / HP-156 — Backfill geo_sites.discovered_competitors[].name with
 * humanized brand names.
 *
 * Pre-HP-146 the competitor discovery path stored raw domain stems
 * ("apollohospitals", "fortishealthcare") in the `name` field whenever the
 * discovery LLM gave up. This script walks every geo_sites row, finds
 * discovered_competitors entries whose `name` looks like a domain stem
 * (per `looksLikeDomainStem`), runs them through the post-HP-146 Haiku-backed
 * `humanizeDomainToBrand`, and rewrites `name` with the canonical brand.
 *
 * Idempotent: rows whose names are already humanized are skipped.
 * Dry-run by default: prints a CSV delta to stdout. Pass `--commit` to
 * actually persist the rewritten rows.
 *
 * Usage:
 *   ~/.nvm/versions/node/v22.12.0/bin/node --env-file=.env.local \
 *     ./node_modules/.bin/tsx scripts/backfill-discovered-competitor-names.ts
 *   ... add --commit to write
 *   ... add --site-id=<id> to scope to a single site
 *   ... add --limit=<N> to cap rows processed (dry-run sanity check)
 *
 * Acceptance (HP-156 re-review):
 *   1. Dry-run mode exists and produces a delta CSV  ← stdout
 *   2. Idempotency: re-running on already-fresh rows is a no-op
 *   3. After backfill against staging Manipal, row QH1EepHTOpK6hsh80VPJ1
 *      has discovered_competitors[].name humanized
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { geoSites } from "../lib/db/schema";
import {
  humanizeDomainToBrand,
  looksLikeDomainStem,
} from "../lib/services/brand-detector";
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

type DeltaRow = {
  siteId: string;
  domain: string;
  oldName: string;
  newName: string;
};

async function main() {
  console.error(
    `[backfill-names] mode=${COMMIT ? "COMMIT" : "DRY-RUN"} ` +
    `${SITE_ID ? `site=${SITE_ID}` : "site=ALL"} ` +
    `limit=${LIMIT === Number.POSITIVE_INFINITY ? "∞" : LIMIT}`,
  );

  const rows = await db
    .select({ id: geoSites.id, domain: geoSites.domain, discoveredCompetitors: geoSites.discoveredCompetitors })
    .from(geoSites);

  const filtered = SITE_ID ? rows.filter(r => r.id === SITE_ID) : rows;

  // Stable CSV header on stdout — easy to | tee delta.csv
  process.stdout.write("site_id,domain,old_name,new_name\n");

  const deltas: DeltaRow[] = [];
  let scanned = 0;
  let rowsTouched = 0;

  for (const row of filtered) {
    if (scanned >= LIMIT) break;
    scanned++;

    const competitors = row.discoveredCompetitors as DiscoveredCompetitor[] | null | undefined;
    if (!competitors || competitors.length === 0) continue;

    // Per-row in-place rewrite. Skip rows where every name is already humanized.
    let touched = false;
    const rewritten: DiscoveredCompetitor[] = [];
    for (const comp of competitors) {
      const oldName = comp.name ?? "";
      if (!looksLikeDomainStem(oldName) && oldName.trim() !== "") {
        // Already humanized — leave as-is
        rewritten.push(comp);
        continue;
      }

      // Stem-like name OR empty: humanize from the domain
      const sourceDomain = comp.domain ?? oldName;
      if (!sourceDomain) {
        rewritten.push(comp);
        continue;
      }

      let newName: string;
      try {
        newName = await humanizeDomainToBrand(sourceDomain);
      } catch (err) {
        // humanizeDomainToBrand never throws by contract, but defend anyway
        console.error(`[backfill-names] WARN unexpected throw for ${sourceDomain}: ${err}`);
        rewritten.push(comp);
        continue;
      }

      if (!newName || newName === oldName) {
        rewritten.push(comp);
        continue;
      }

      const delta: DeltaRow = {
        siteId: row.id,
        domain: sourceDomain,
        oldName,
        newName,
      };
      deltas.push(delta);
      // CSV: escape any internal commas defensively
      process.stdout.write(
        [
          delta.siteId,
          delta.domain,
          JSON.stringify(delta.oldName),
          JSON.stringify(delta.newName),
        ].join(",") + "\n",
      );

      rewritten.push({ ...comp, name: newName });
      touched = true;
    }

    if (!touched) continue;
    rowsTouched++;

    if (COMMIT) {
      await db
        .update(geoSites)
        .set({ discoveredCompetitors: rewritten })
        .where(eq(geoSites.id, row.id));
    }
  }

  console.error(
    `[backfill-names] done. scanned=${scanned} rowsTouched=${rowsTouched} ` +
    `entriesRewritten=${deltas.length} mode=${COMMIT ? "COMMIT" : "DRY-RUN"}`,
  );

  await client.end();
}

main().catch(err => {
  console.error("[backfill-names] FATAL:", err);
  process.exit(1);
});
