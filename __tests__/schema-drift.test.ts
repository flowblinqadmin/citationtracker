/**
 * Schema Drift Detection — Drizzle ORM Column Snapshot Tests
 *
 * ## Why this file exists
 *
 * We had a production outage caused by schema drift: `baseline_scorecard`
 * was added to `lib/db/schema.ts` but the migration was never run against
 * the production database. Drizzle selects ALL defined columns explicitly,
 * so every query against `geo_sites` failed with "column does not exist".
 *
 * All API tests mock `@/lib/db`, so they cannot catch this class of bug.
 *
 * ## How the snapshot approach works
 *
 * This test imports the live Drizzle schema objects and compares their
 * column sets against a HARDCODED snapshot stored in this file. The test
 * does NOT connect to a database — it only inspects the in-memory schema
 * object that Drizzle builds at import time.
 *
 * If you add a column to schema.ts you MUST also add it to the snapshot
 * below (the test will tell you which column is missing). That deliberate
 * friction is the point — it forces you to remember to run the migration.
 *
 * ## Workflow for adding a column
 *
 * 1. Add the column to `lib/db/schema.ts`
 * 2. Run `npm test` → this test fails, naming the new column
 * 3. Run the migration against every environment that needs it
 * 4. Add the column name to the snapshot below
 * 5. `npm test` passes again
 *
 * @vitest-environment node
 */

import { describe, it, expect } from "vitest";
import {
  teams,
  teamMembers,
  teamDomains,
  creditTransactions,
  geoSites,
  geoCrawlLogs,
} from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// Snapshot — the authoritative list of columns per table
//
// BEFORE adding a column here, make sure the migration has been run against
// production. The order of entries within each array does not matter.
// ---------------------------------------------------------------------------

const COLUMN_SNAPSHOT: Record<string, string[]> = {
  // ── teams ──────────────────────────────────────────────────────────────
  teams: [
    "id",
    "name",
    "owner_user_id",
    "credit_balance",
    "stripe_customer_id",
    // Subscription fields — GEO subscription pricing
    "subscription_tier",
    "stripe_subscription_id",
    "subscription_status",
    "billing_model", // FIX-018 — billing entitlement discriminator (FIND-TYPEDESIGN-001)
    "monthly_page_allowance",
    "monthly_pages_used",
    "current_period_end",
    "created_at",
    "updated_at",
  ],

  // ── team_members ───────────────────────────────────────────────────────
  team_members: [
    "id",
    "team_id",
    "user_id",
    "email",
    "role",
    "invite_token",
    "invite_accepted_at",
    "created_at",
  ],

  // ── team_domains ───────────────────────────────────────────────────────
  team_domains: [
    "id",
    "team_id",
    "site_id",
    "domain",
    "added_by_user_id",
    "created_at",
  ],

  // ── credit_transactions ────────────────────────────────────────────────
  credit_transactions: [
    "id",
    "team_id",
    "site_id",
    "parent_site_id", // ES-B9 §credit AC-B9-10 — γ free-retry parent reference
    "type",
    "description", // FIND-025 — optional human-readable ledger note (persisted by deductCredits)
    "pages_consumed",
    "credits_changed",
    "balance_before",
    "balance_after",
    "created_at",
  ],

  // ── geo_sites ──────────────────────────────────────────────────────────
  // baseline_scorecard was the column that caused the outage — it is here
  // as proof that it has been migrated and is safe to query.
  geo_sites: [
    "id",
    "domain",
    "slug",
    "owner_email",
    // NEW-A-02: canonical email for indexed free-audit-limit enforcement
    "owner_email_canonical",
    "team_id",
    "user_id",
    // Email verification
    "email_verified",
    "verification_code",
    "code_expires_at",
    "access_token",
    // Token expiry + rotation — ES-090 §b.1 CRIT-1 / HP-196 / HP-197
    "token_expires_at",
    "token_rotated_at",
    // Stripe / payment
    "stripe_customer_id",
    "stripe_checkout_session_id",
    "stripe_subscription_id",
    "payment_status",
    // Pipeline data (jsonb)
    "discovery_data",
    "crawl_data",
    "crawl_job_ids",
    "research_data",
    "geo_scorecard",
    // Geographic & Category trees — ES-053
    "geo_tree",
    "category_tree",
    "geo_category_mapping",
    // Generated files
    "generated_llms_txt",
    "generated_llms_full_txt",
    "generated_business_json",
    "generated_schema_blocks",
    "recommendations",
    "executive_summary",
    // Site metadata
    "platform_detected",
    "site_type",
    // Pipeline state
    "pipeline_status",
    "pipeline_error",
    // Crawl scheduling
    "last_crawl_at",
    "next_crawl_at",
    "crawl_count",
    "manual_runs_this_month",
    "manual_runs_reset_at",
    // Marketing report
    "share_token",
    // Previous run snapshot
    "previous_run_snapshot",
    // Baseline scorecard — ADDED after the production outage
    "baseline_scorecard",
    // Bulk CSV audit fields — ADDED in dev-an-m2-extended (must migrate to prod DB)
    "audit_mode",
    "parent_site_id", // ES-B9.3 AC-4 — preserved nullable; B10 reverted to in-place rerun
    "current_run_number", // ES-B10 AC-B10-7
    "current_run_kind",   // ES-B10 AC-B10-7
    "retry_subset_urls",  // ES-B10 AC-B10-7
    "bulk_urls",
    "bulk_url_count",
    "crawl_limit",
    "credits_reserved",
    // NEW-P-01: subscription pages reserved at audit start — reconciled at assemble
    "subscription_pages_reserved",
    "per_page_results",
    "report_zip_url",
    // Bulk batch identifier — ES-018 (issue #110)
    "batch_id",
    // Change tracking
    "change_log",
    "last_significant_change",
    // Domain verification
    "domain_verified",
    "verify_token",
    // OTP brute-force protection — ES-017 (issue #109)
    "otp_attempts",
    "otp_locked_until",
    // Public API / free-tier tracking — ES-019
    "free_optimization_used",
    "free_run_number",
    "api_client_id",
    // Crawl fan-out coordination — ES-023
    "crawl_chunks_total",
    "crawl_chunks_done",
    "crawl_chunk_results",
    "crawl_started_at",
    "crawl_failed_urls",
    // Auto-discovered brand-level pages count — ES-083 (bulk audit)
    "auto_discovered_url_count",
    // Tree extraction failure timestamp — ES-084 (sequencing regression guard)
    "tree_extraction_failed_at",
    // Generate fan-out coordination — TS-034+
    "generate_chunks_total",
    "generate_chunks_done",
    // Pre-analyze fan-in counter — HP perf Fix 1
    "pre_analyze_done",
    // Competitor intelligence — TS-030
    "discovered_competitors",
    // LLM citation narrative — ES-036
    "citation_narrative",
    // Brand detection + category extraction — ES-059
    "brand_keywords",
    "extracted_categories",
    // Subscription crawl settings — GEO subscription pricing
    "crawl_frequency",
    "selected_pages",
    // Per-page fixes and implementation tracking — ES-045
    "per_page_fixes",
    "previous_per_page_fixes",
    "implementation_status",
    // Crawl coverage report — ES-054
    "crawl_coverage_report",
    // Content Intelligence — ES-055
    "content_strategy_scores",
    "engine_preferences",
    // User-defined competitors — ES-069
    "user_competitors",
    "competitor_blocklist",
    // Hallucination risk tracking
    "hallucination_risk",
    // Timestamps
    "created_at",
    "updated_at",
  ],

  // ── geo_crawl_logs ─────────────────────────────────────────────────────
  geo_crawl_logs: [
    "id",
    "site_id",
    "slug",
    "file_type",
    "request_path",
    "user_agent",
    "bot_name",
    "ip",
    // COMP-2 — ES-090 §b.1 — HMAC-SHA256 of raw ip; raw retained until backfill + 1w safety window
    "ip_hash",
    "country",
    "requested_at",
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the SQL column names from a Drizzle table object.
 *
 * Drizzle stores column definitions on the table under a symbol key
 * (`Symbol(drizzle:Columns)`). Each column object exposes `.name` which
 * is the actual SQL column name (snake_case), not the TypeScript property.
 */
function getColumnNames(table: Record<string | symbol, unknown>): string[] {
  // Drizzle ORM stores columns under a well-known symbol.
  const columnsSymbol = Object.getOwnPropertySymbols(table).find(
    (s) => s.toString() === "Symbol(drizzle:Columns)"
  );

  if (!columnsSymbol) {
    // Fall back: iterate own string keys, collect objects with a .name string
    // (works for simple table shapes even without the symbol).
    const cols: string[] = [];
    for (const key of Object.keys(table)) {
      const col = table[key];
      if (col && typeof col === "object" && typeof (col as Record<string, unknown>).name === "string") {
        cols.push((col as Record<string, unknown>).name as string);
      }
    }
    return cols;
  }

  const columns = table[columnsSymbol] as Record<string, { name: string }>;
  return Object.values(columns).map((col) => col.name);
}

/**
 * Returns the SQL table name from a Drizzle table object.
 */
function getTableName(table: Record<string | symbol, unknown>): string {
  // Drizzle stores the table name under Symbol(drizzle:Name)
  const nameSymbol = Object.getOwnPropertySymbols(table).find(
    (s) => s.toString() === "Symbol(drizzle:Name)"
  );
  if (nameSymbol) return table[nameSymbol] as string;

  // Fallback: check ._.name (Drizzle internal config object)
  const internal = (table as Record<string, unknown>)._ as Record<string, unknown> | undefined;
  if (internal?.name && typeof internal.name === "string") return internal.name;

  return "(unknown)";
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Schema drift detection — column snapshot", () => {
  /**
   * The tables we import and the snapshot keys they map to.
   * Extend this list if new tables are added to schema.ts.
   */
  const tableFixtures: Array<{ label: string; table: Record<string | symbol, unknown> }> = [
    { label: "teams", table: teams as unknown as Record<string | symbol, unknown> },
    { label: "team_members", table: teamMembers as unknown as Record<string | symbol, unknown> },
    { label: "team_domains", table: teamDomains as unknown as Record<string | symbol, unknown> },
    { label: "credit_transactions", table: creditTransactions as unknown as Record<string | symbol, unknown> },
    { label: "geo_sites", table: geoSites as unknown as Record<string | symbol, unknown> },
    { label: "geo_crawl_logs", table: geoCrawlLogs as unknown as Record<string | symbol, unknown> },
  ];

  for (const { label, table } of tableFixtures) {
    describe(`table: ${label}`, () => {
      it("snapshot covers every column defined in schema.ts (no undocumented additions)", () => {
        const actualColumns = getColumnNames(table).sort();
        const snapshotColumns = [...(COLUMN_SNAPSHOT[label] ?? [])].sort();

        // Find columns in schema that are NOT in the snapshot.
        // These are new columns that need a migration + snapshot update.
        const missingFromSnapshot = actualColumns.filter(
          (col) => !snapshotColumns.includes(col)
        );

        expect(
          missingFromSnapshot,
          `Column(s) added to "${label}" in schema.ts but NOT recorded in the snapshot: ` +
            `[${missingFromSnapshot.join(", ")}]. ` +
            `Run the DB migration for each new column, then add it to COLUMN_SNAPSHOT["${label}"] ` +
            `in __tests__/schema-drift.test.ts.`
        ).toHaveLength(0);
      });

      it("snapshot has no phantom columns missing from schema.ts (snapshot stays clean)", () => {
        const actualColumns = getColumnNames(table).sort();
        const snapshotColumns = [...(COLUMN_SNAPSHOT[label] ?? [])].sort();

        // Find snapshot entries that no longer exist in the schema.
        // These are stale entries that should be removed from the snapshot.
        const phantomInSnapshot = snapshotColumns.filter(
          (col) => !actualColumns.includes(col)
        );

        expect(
          phantomInSnapshot,
          `Column(s) listed in the snapshot for "${label}" but NOT found in schema.ts: ` +
            `[${phantomInSnapshot.join(", ")}]. ` +
            `Remove them from COLUMN_SNAPSHOT["${label}"] in __tests__/schema-drift.test.ts.`
        ).toHaveLength(0);
      });

      it("snapshot covers the exact expected count of columns (guards against silent drops)", () => {
        const actualCount = getColumnNames(table).length;
        const snapshotCount = (COLUMN_SNAPSHOT[label] ?? []).length;

        expect(
          actualCount,
          `Column count mismatch for "${label}": ` +
            `schema.ts has ${actualCount} columns but the snapshot lists ${snapshotCount}. ` +
            `Update COLUMN_SNAPSHOT["${label}"] in __tests__/schema-drift.test.ts.`
        ).toBe(snapshotCount);
      });
    });
  }

  // ── Specific regression test for the outage column ──────────────────────

  it("geo_sites includes baseline_scorecard (regression: column that caused production outage)", () => {
    const actualColumns = getColumnNames(
      geoSites as unknown as Record<string | symbol, unknown>
    );
    expect(actualColumns).toContain("baseline_scorecard");
  });

  it("geo_sites includes all newer columns added alongside baseline_scorecard", () => {
    const actualColumns = getColumnNames(
      geoSites as unknown as Record<string | symbol, unknown>
    );
    // These columns were added in the same migration window — confirm all present.
    const expectedNewColumns = [
      "baseline_scorecard",
      "change_log",
      "last_significant_change",
      "domain_verified",
      "verify_token",
      "previous_run_snapshot",
      "site_type",
      "manual_runs_reset_at",
    ];
    for (const col of expectedNewColumns) {
      expect(actualColumns, `Expected "${col}" to be defined in geoSites schema`).toContain(col);
    }
  });

  // ── Snapshot completeness guard ──────────────────────────────────────────

  it("COLUMN_SNAPSHOT covers all tables exported from schema.ts", () => {
    const coveredTables = Object.keys(COLUMN_SNAPSHOT).sort();
    const expectedTables = [
      "teams",
      "team_members",
      "team_domains",
      "credit_transactions",
      "geo_sites",
      "geo_crawl_logs",
    ].sort();

    expect(coveredTables).toEqual(expectedTables);
  });
});
