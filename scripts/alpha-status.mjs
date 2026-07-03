#!/usr/bin/env node
/**
 * Alpha Site Status — shows health of all alpha tester domains
 * Usage: node scripts/alpha-status.mjs [--all]
 *
 * Flags:
 *   --all    Show ALL sites (not just alpha tester domains)
 */

import { neon } from "@neondatabase/serverless";

if (!process.env.DATABASE_URL_UNPOOLED) {
  console.error("DATABASE_URL_UNPOOLED env var required");
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL_UNPOOLED);
const showAll = process.argv.includes("--all");

// Alpha domains — keep in sync with lib/config.ts ALPHA_TESTER_DOMAINS
const ALPHA_DOMAINS = [
  // "example.com",
  // "happypathfire.com",
];

const rows = showAll
  ? await sql`
      SELECT domain, pipeline_status, geo_scorecard, last_crawl_at, next_crawl_at, crawl_count
      FROM geo_sites
      ORDER BY last_crawl_at DESC NULLS LAST
      LIMIT 50
    `
  : ALPHA_DOMAINS.length > 0
    ? await sql`
        SELECT domain, pipeline_status, geo_scorecard, last_crawl_at, next_crawl_at, crawl_count
        FROM geo_sites
        WHERE domain = ANY(${ALPHA_DOMAINS})
        ORDER BY domain
      `
    : [];

if (rows.length === 0) {
  console.log("No sites found. Use --all to see all sites, or add domains to ALPHA_DOMAINS.");
  process.exit(0);
}

const now = Date.now();
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

// Format table
console.log(
  "Domain".padEnd(30) +
  "Status".padEnd(12) +
  "Score".padEnd(8) +
  "LastCrawl".padEnd(14) +
  "NextCrawl".padEnd(14) +
  "Runs".padEnd(6) +
  "Issues"
);
console.log("-".repeat(100));

for (const r of rows) {
  const score = r.geo_scorecard?.overallScore ?? "-";
  const lastCrawl = r.last_crawl_at ? new Date(r.last_crawl_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "never";
  const nextCrawl = r.next_crawl_at ? new Date(r.next_crawl_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "-";
  const crawlCount = r.crawl_count ?? 0;

  const issues = [];
  if (r.pipeline_status === "failed") issues.push("ERROR");
  if (crawlCount === 0) issues.push("NEVER_RUN");
  if (r.last_crawl_at && now - new Date(r.last_crawl_at).getTime() > SEVEN_DAYS) issues.push("STALE");

  console.log(
    r.domain.padEnd(30) +
    r.pipeline_status.padEnd(12) +
    String(score).padEnd(8) +
    lastCrawl.padEnd(14) +
    nextCrawl.padEnd(14) +
    String(crawlCount).padEnd(6) +
    (issues.length > 0 ? issues.join(", ") : "OK")
  );
}
