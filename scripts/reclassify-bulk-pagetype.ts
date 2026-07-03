// OPERATOR-ONLY — do not invoke from application code.
//
// ES-085 §b.3 / AC-8 — re-classify pageTypes on existing geo_sites rows by
// re-running the post-AC-3 classifier against persisted `crawl_data.pages`.
//
// Default mode is DRY-RUN per AC-8/AC-12 — pass `commit: true` to actually
// persist. Does NOT trigger tree extraction or citation check (AC-9).
//
// Usage (CLI):
//   tsx geo/scripts/reclassify-bulk-pagetype.ts                  # dry-run all
//   tsx geo/scripts/reclassify-bulk-pagetype.ts --site <id>      # one site
//   tsx geo/scripts/reclassify-bulk-pagetype.ts --site <id> --commit
//   tsx geo/scripts/reclassify-bulk-pagetype.ts --owner <email>
//   tsx geo/scripts/reclassify-bulk-pagetype.ts --max 10
//
// Programmatic (the unit test contract — same shape as other backfill scripts):
//   import { main } from "./reclassify-bulk-pagetype";
//   const summary = await main({ commit: false });

import { and, eq, isNotNull, desc } from "drizzle-orm";
import { db } from "@/lib/db";
import { geoSites } from "@/lib/db/schema";
import { classifyPageType, type PageType } from "@/lib/services/geo-crawler";

// ── Public types ────────────────────────────────────────────────────────────

export interface ReclassifyOpts {
  commit?: boolean;
  site?: string;
  owner?: string;
  max?: number;
}

export interface ReclassifySummary {
  mode: "dry-run" | "commit";
  eligible: number;
  reclassified: number;
  skipped: number;
  failed: number;
}

interface CrawlPage {
  url: string;
  pageType?: PageType | string;
  [key: string]: unknown;
}

interface CrawlDataShape {
  pages?: CrawlPage[];
  [key: string]: unknown;
}

// ── Selection ───────────────────────────────────────────────────────────────

function buildWhereClause(opts: ReclassifyOpts) {
  const filters = [
    eq(geoSites.auditMode, "bulk"),
    isNotNull(geoSites.crawlData),
  ];
  if (opts.site) filters.push(eq(geoSites.id, opts.site));
  if (opts.owner) filters.push(eq(geoSites.ownerEmail, opts.owner));
  return and(...filters);
}

async function fetchEligible(opts: ReclassifyOpts) {
  const limit = opts.max ?? 1000;
  return db
    .select()
    .from(geoSites)
    .where(buildWhereClause(opts))
    .orderBy(desc(geoSites.updatedAt))
    .limit(limit);
}

// ── Main entry ──────────────────────────────────────────────────────────────

export async function main(opts: ReclassifyOpts): Promise<ReclassifySummary> {
  const commit = opts.commit === true;
  const mode: ReclassifySummary["mode"] = commit ? "commit" : "dry-run";

  const eligible = await fetchEligible(opts);
  console.warn(
    `[reclassify-bulk-pagetype] mode=${mode} eligible=${eligible.length}` +
    `${opts.site ? ` site=${opts.site}` : ""}` +
    `${opts.owner ? ` owner=${opts.owner}` : ""}`,
  );

  let reclassified = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of eligible) {
    try {
      const crawlData = row.crawlData as CrawlDataShape | null;
      if (!crawlData || !Array.isArray(crawlData.pages)) {
        skipped++;
        continue;
      }

      let changedCount = 0;
      const newPages = crawlData.pages.map((page) => {
        const oldType = page.pageType;
        const newType = classifyPageType(page.url);
        if (oldType !== newType) changedCount++;
        return { ...page, pageType: newType };
      });

      if (changedCount === 0) {
        skipped++;
        continue;
      }

      const newCrawlData = { ...crawlData, pages: newPages };

      if (commit) {
        // ES-085 AC-9: only updates crawl_data.pages[*].pageType. Does NOT
        // trigger tree extraction or citation check downstream.
        await db.update(geoSites).set({
          crawlData: newCrawlData as unknown as Record<string, unknown>,
          updatedAt: new Date(),
        }).where(eq(geoSites.id, row.id));
        console.warn(`[ok] ${row.id} ${row.domain} → ${changedCount} pages reclassified`);
      } else {
        console.warn(`[dry-run] ${row.id} ${row.domain} → ${changedCount} pages would be reclassified`);
      }

      reclassified++;
    } catch (err) {
      failed++;
      console.error(`[failed] ${row.id} ${row.domain} — ${(err as Error).message ?? String(err)}`);
    }
  }

  const summary: ReclassifySummary = { mode, eligible: eligible.length, reclassified, skipped, failed };
  console.warn(JSON.stringify({
    event: "reclassify_bulk_pagetype_summary",
    ...summary,
  }));
  return summary;
}

// ── CLI entry ───────────────────────────────────────────────────────────────

function parseCli(argv: string[]): ReclassifyOpts {
  const opts: ReclassifyOpts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--commit") opts.commit = true;
    else if (a === "--site") opts.site = argv[++i];
    else if (a === "--owner") opts.owner = argv[++i];
    else if (a === "--max") opts.max = parseInt(argv[++i] ?? "0", 10);
    else if (a === "--help" || a === "-h") {
      console.warn("Usage: tsx scripts/reclassify-bulk-pagetype.ts [--site <id>] [--owner <email>] [--max <n>] [--commit]");
      process.exit(0);
    }
  }
  return opts;
}

// Only run when invoked directly (not when imported by tests).
if (typeof process !== "undefined" && process.argv[1]?.endsWith("reclassify-bulk-pagetype.ts")) {
  main(parseCli(process.argv.slice(2)))
    .then((s) => {
      console.warn(
        `─── reclassify-bulk-pagetype summary ───\n` +
        `  Eligible:     ${s.eligible}\n` +
        `  Reclassified: ${s.reclassified}\n` +
        `  Skipped:      ${s.skipped}\n` +
        `  Failed:       ${s.failed}\n` +
        `  Mode:         ${s.mode}`,
      );
      process.exit(s.failed > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error("[reclassify-bulk-pagetype] FATAL:", err);
      process.exit(1);
    });
}
