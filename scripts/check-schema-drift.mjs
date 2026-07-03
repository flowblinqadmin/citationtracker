#!/usr/bin/env node
/**
 * Schema drift detector — compares Drizzle schema definition against live DB.
 *
 * Catches:
 *   • Columns defined in schema but missing from DB  (write will fail at runtime)
 *   • Columns in DB but not in schema               (ORM can't see them)
 *   • Type mismatches between schema and DB
 *
 * Usage:
 *   node scripts/check-schema-drift.mjs
 *   DATABASE_URL=<url> node scripts/check-schema-drift.mjs
 *
 * Exit code 0 = clean, 1 = drift detected.
 */

import postgres from "postgres";

// ── Drizzle type → Postgres data_type mapping ──────────────────────────────
// Each Drizzle column type maps to one or more valid information_schema data_type values.
const TYPE_MAP = {
  PgText:      ["text", "character varying"],  // Postgres treats these as equivalent
  PgVarchar:   ["character varying", "text"],
  PgInteger:   ["integer"],
  PgBoolean:   ["boolean"],
  PgTimestamp: ["timestamp without time zone", "timestamp with time zone"],
  PgJsonb:     ["jsonb"],
  PgReal:      ["real"],
  PgVector:    ["USER-DEFINED"],  // pgvector — custom type
  PgArray:     ["ARRAY"],
};

// ── Expected schema (extracted from lib/db/schema.ts) ─────────────────────
// Maintained manually. Run this script after every schema.ts change to verify sync.
// Format: tableName → { columnName: drizzleTypeName }
// Only list concrete tables (not views — views have their own sync trigger).

const EXPECTED = {
  teams: {
    id: "PgText",
    name: "PgText",
    owner_user_id: "PgText",
    credit_balance: "PgInteger",
    stripe_customer_id: "PgText",
    subscription_tier: "PgText",
    stripe_subscription_id: "PgText",
    subscription_status: "PgText",
    monthly_page_allowance: "PgInteger",
    monthly_pages_used: "PgInteger",
    current_period_end: "PgTimestamp",
    created_at: "PgTimestamp",
    updated_at: "PgTimestamp",
  },

  team_members: {
    id: "PgText",
    team_id: "PgText",
    user_id: "PgText",
    email: "PgText",
    role: "PgText",
    invite_token: "PgText",
    invite_accepted_at: "PgTimestamp",
    created_at: "PgTimestamp",
  },

  team_domains: {
    id: "PgText",
    team_id: "PgText",
    site_id: "PgText",
    domain: "PgText",
    added_by_user_id: "PgText",
    created_at: "PgTimestamp",
  },

  credit_transactions: {
    id: "PgText",
    team_id: "PgText",
    site_id: "PgText",
    type: "PgText",
    pages_consumed: "PgInteger",
    credits_changed: "PgInteger",
    balance_before: "PgInteger",
    balance_after: "PgInteger",
    created_at: "PgTimestamp",
  },

  geo_sites: {
    id: "PgText",
    domain: "PgText",
    slug: "PgText",
    owner_email: "PgText",
    team_id: "PgText",
    user_id: "PgText",
    email_verified: "PgBoolean",
    verification_code: "PgText",
    code_expires_at: "PgTimestamp",
    access_token: "PgText",
    stripe_customer_id: "PgText",
    stripe_checkout_session_id: "PgText",
    stripe_subscription_id: "PgText",
    payment_status: "PgText",
    discovery_data: "PgJsonb",
    crawl_data: "PgJsonb",
    crawl_job_ids: "PgJsonb",
    research_data: "PgJsonb",
    geo_scorecard: "PgJsonb",
    geo_tree: "PgJsonb",
    category_tree: "PgJsonb",
    geo_category_mapping: "PgJsonb",
    generated_llms_txt: "PgText",
    generated_llms_full_txt: "PgText",
    generated_business_json: "PgJsonb",
    generated_schema_blocks: "PgJsonb",
    recommendations: "PgJsonb",
    executive_summary: "PgText",
    platform_detected: "PgText",
    site_type: "PgText",
    pipeline_status: "PgText",
    pipeline_error: "PgText",
    audit_mode: "PgText",
    bulk_urls: "PgJsonb",
    bulk_url_count: "PgInteger",
    crawl_limit: "PgInteger",
    credits_reserved: "PgInteger",
    per_page_results: "PgJsonb",
    per_page_fixes: "PgJsonb",
    previous_per_page_fixes: "PgJsonb",
    implementation_status: "PgJsonb",
    crawl_coverage_report: "PgJsonb",
    content_strategy_scores: "PgJsonb",
    engine_preferences: "PgJsonb",
    report_zip_url: "PgText",
    batch_id: "PgText",
    free_optimization_used: "PgBoolean",
    free_run_number: "PgInteger",
    api_client_id: "PgText",
    crawl_frequency: "PgText",
    selected_pages: "PgJsonb",
    last_crawl_at: "PgTimestamp",
    next_crawl_at: "PgTimestamp",
    crawl_count: "PgInteger",
    manual_runs_this_month: "PgInteger",
    manual_runs_reset_at: "PgTimestamp",
    share_token: "PgText",
    previous_run_snapshot: "PgJsonb",
    baseline_scorecard: "PgJsonb",
    change_log: "PgJsonb",
    last_significant_change: "PgTimestamp",
    domain_verified: "PgBoolean",
    verify_token: "PgText",
    otp_attempts: "PgInteger",
    otp_locked_until: "PgTimestamp",
    crawl_chunks_total: "PgInteger",
    crawl_chunks_done: "PgInteger",
    crawl_chunk_results: "PgJsonb",
    crawl_started_at: "PgTimestamp",
    crawl_failed_urls: "PgJsonb",
    generate_chunks_total: "PgInteger",
    generate_chunks_done: "PgInteger",
    discovered_competitors: "PgJsonb",
    user_competitors: "PgJsonb",
    competitor_blocklist: "PgJsonb",
    hallucination_risk: "PgInteger",  // KNOWN MISMATCH: DB has jsonb, schema has integer — needs ALTER TABLE
    citation_narrative: "PgText",
    brand_keywords: "PgJsonb",
    extracted_categories: "PgJsonb",
    created_at: "PgTimestamp",
    updated_at: "PgTimestamp",
  },

  rate_limits: {
    key: "PgText",
    count: "PgInteger",
    reset_at: "PgTimestamp",
  },

  consent_records: {
    id: "PgText",
    user_id: "PgText",
    email: "PgText",
    tos_version: "PgText",
    eula_version: "PgText",
    accepted_at: "PgTimestamp",
    ip_address: "PgText",
    user_agent: "PgText",
    created_at: "PgTimestamp",
  },

  api_clients: {
    id: "PgText",
    team_id: "PgText",
    client_id: "PgText",
    client_secret_hash: "PgText",
    name: "PgText",
    scopes: "PgArray",  // text[] — reported as ARRAY in information_schema
    created_by_user_id: "PgText",
    last_used_at: "PgTimestamp",
    revoked_at: "PgTimestamp",
    created_at: "PgTimestamp",
  },

  audit_reports: {
    id: "PgText",
    merchant_url: "PgText",
    merchant_name: "PgText",
    contact_email: "PgText",
    product_category: "PgText",
    revenue_estimate: "PgText",
    verification_code: "PgText",
    code_expires_at: "PgTimestamp",
    email_verified: "PgBoolean",
    status: "PgText",
    intelligence_data: "PgJsonb",
    technical_data: "PgJsonb",
    sov_data: "PgJsonb",
    semantic_data: "PgJsonb",
    commerce_data: "PgJsonb",
    overall_score: "PgInteger",
    platform_detected: "PgText",
    created_at: "PgTimestamp",
    updated_at: "PgTimestamp",
  },

  acp_monitoring: {
    id: "PgText",
    domain: "PgText",
    vertical: "PgText",
    probe_results: "PgJsonb",
    probe_scores: "PgJsonb",
    infrastructure_score: "PgInteger",
    checked_at: "PgTimestamp",
  },

  citation_check_responses: {
    id: "PgText",
    check_id: "PgText",
    site_id: "PgText",
    provider: "PgText",
    model: "PgText",
    query: "PgText",
    response: "PgText",
    response_time_ms: "PgInteger",
    mentioned: "PgBoolean",
    position: "PgInteger",
    sentiment: "PgText",
    competitors_mentioned: "PgJsonb",
    impression_share: "PgInteger",
    error: "PgText",
    created_at: "PgTimestamp",
  },

  citation_check_scores: {
    check_id: "PgText",
    site_id: "PgText",
    team_id: "PgText",
    domain: "PgText",
    overall_visibility: "PgInteger",
    best_provider: "PgText",
    worst_provider: "PgText",
    avg_position: "PgInteger",
    sentiment_score: "PgInteger",
    provider_results: "PgJsonb",
    competitor_visibility: "PgJsonb",
    competitor_data: "PgJsonb",
    pillar_visibility: "PgJsonb",
    pillar_qa: "PgJsonb",
    indirect_visibility: "PgInteger",
    brand_knowledge: "PgInteger",
    citation_quality_score: "PgInteger",
    credits_used: "PgInteger",
    prompts_used: "PgJsonb",
    prompt_metadata: "PgJsonb",
    geo_visibility: "PgJsonb",
    category_visibility: "PgJsonb",
    tier_visibility: "PgJsonb",
    avg_impression_share: "PgInteger",
    visibility_gap_analysis: "PgJsonb",
    location_competitors: "PgJsonb",
    category_competitors: "PgJsonb",
    dominance_map: "PgJsonb",
    real_prompt_discovery: "PgJsonb",
    prompt_architecture_version: "PgInteger",
    created_at: "PgTimestamp",
  },

  firecrawl_jobs: {
    id: "PgText",
    site_id: "PgText",
    firecrawl_job_id: "PgText",
    chunk_index: "PgInteger",
    url_count: "PgInteger",
    status: "PgText",
    urls_submitted: "PgJsonb",
    urls_completed: "PgJsonb",
    created_at: "PgTimestamp",
    updated_at: "PgTimestamp",
  },

  geo_crawl_logs: {
    id: "PgText",
    site_id: "PgText",
    slug: "PgText",
    file_type: "PgText",
    request_path: "PgText",
    user_agent: "PgText",
    bot_name: "PgText",
    ip: "PgText",
    country: "PgText",
    requested_at: "PgTimestamp",
  },

  geo_page_views: {
    id: "PgText",
    site_id: "PgText",
    slug: "PgText",
    page_url: "PgText",
    referrer: "PgText",
    visitor_id: "PgText",
    user_agent: "PgText",
    bot_name: "PgText",
    ip: "PgText",
    country: "PgText",
    screen_width: "PgInteger",
    website_deploy_id: "PgText",
    viewed_at: "PgTimestamp",
  },

  knowledge_embeddings: {
    id: "PgVarchar",
    content: "PgText",
    source: "PgVarchar",
    category: "PgVarchar",
    platform: "PgVarchar",
    embedding: "PgVector",
    created_at: "PgTimestamp",
  },

  chatbot_logs: {
    id: "PgVarchar",
    conversation_id: "PgVarchar",
    site_id: "PgVarchar",
    team_id: "PgVarchar",
    query: "PgText",
    response: "PgText",
    retrieved_chunks: "PgJsonb",
    top_similarity: "PgReal",
    confidence_tier: "PgVarchar",
    view_context: "PgJsonb",
    created_at: "PgTimestamp",
  },
};

// Tables to skip (views handled by triggers, not direct writes)
const SKIP_TABLES = new Set(["geo_site_view"]);

// Known intentional mismatches — listed here to suppress false positives.
// Remove an entry once the underlying issue is fixed.
const KNOWN_ISSUES = [
  // Remove entries once the underlying issue is fixed.
  {
    table: "teams",
    column: "frozen",
    issue: "IN_DB_NOT_SCHEMA",
    note: "Column exists in DB but not in Drizzle schema. Add `frozen: boolean('frozen').notNull().default(false)` to teams in schema.ts if it's needed, or drop it from DB if it's legacy.",
  },
];

// ── Main ───────────────────────────────────────────────────────────────────

const DB_URL =
  process.env.DATABASE_URL ||
  process.env.SUPABASE_DATABASE_URL ||
  "postgresql://postgres.mkwjqntnlmogwjqxezqw:QZ5Kc3oEcqLnJpI5@aws-1-us-east-1.pooler.supabase.com:6543/postgres";

const sql = postgres(DB_URL, { max: 1 });

async function main() {
  console.log("🔍 Checking schema drift against live DB...\n");

  // Fetch all columns for our tables from information_schema
  const rows = await sql`
    SELECT table_name, column_name, data_type, udt_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ANY(${Object.keys(EXPECTED)})
    ORDER BY table_name, ordinal_position
  `;

  // Build DB map: table → { column → data_type }
  const dbMap = {};
  for (const row of rows) {
    if (!dbMap[row.table_name]) dbMap[row.table_name] = {};
    // For arrays, data_type = 'ARRAY' — use udt_name (e.g. _text → text[])
    dbMap[row.table_name][row.column_name] =
      row.data_type === "ARRAY" ? `ARRAY:${row.udt_name}` : row.data_type;
  }

  const issues = [];
  const knownKeys = new Set(
    KNOWN_ISSUES.map((k) => `${k.table}.${k.column}`)
  );

  for (const [table, expectedCols] of Object.entries(EXPECTED)) {
    if (SKIP_TABLES.has(table)) continue;
    const actualCols = dbMap[table] || {};

    // Schema → DB: missing columns
    for (const [col, drizzleType] of Object.entries(expectedCols)) {
      const key = `${table}.${col}`;
      if (!(col in actualCols)) {
        issues.push({
          severity: "ERROR",
          type: "MISSING_IN_DB",
          table,
          column: col,
          expected: drizzleType,
          actual: "—",
          known: knownKeys.has(key),
        });
        continue;
      }

      // Type check (skip arrays and vectors — handled separately)
      const validTypes = TYPE_MAP[drizzleType];
      // PgArray: DB reports "ARRAY:_text" — just check prefix
      if (drizzleType === "PgArray") {
        if (!actualCols[col].startsWith("ARRAY")) {
          issues.push({
            severity: "WARN",
            type: "TYPE_MISMATCH",
            table,
            column: col,
            expected: "PgArray → ARRAY",
            actual: actualCols[col],
            known: knownKeys.has(key),
          });
        }
        continue;
      }
      if (validTypes && !validTypes.includes(actualCols[col])) {
        issues.push({
          severity: "WARN",
          type: "TYPE_MISMATCH",
          table,
          column: col,
          expected: `${drizzleType} → ${validTypes.join("/")}`,
          actual: actualCols[col],
          known: knownKeys.has(key),
        });
      }
    }

    // DB → Schema: extra columns not in schema
    for (const col of Object.keys(actualCols)) {
      const key = `${table}.${col}`;
      if (!(col in expectedCols)) {
        issues.push({
          severity: "WARN",
          type: "IN_DB_NOT_SCHEMA",
          table,
          column: col,
          expected: "—",
          actual: actualCols[col],
          known: knownKeys.has(key),
        });
      }
    }
  }

  // Separate new issues from known ones
  const newIssues = issues.filter((i) => !i.known);
  const knownIssues = issues.filter((i) => i.known);

  if (knownIssues.length > 0) {
    console.log(`⚠️  Known issues (tracked, fix when possible):`);
    for (const i of knownIssues) {
      const ki = KNOWN_ISSUES.find(
        (k) => k.table === i.table && k.column === i.column
      );
      console.log(`   [${i.type}] ${i.table}.${i.column}`);
      if (ki) console.log(`   → ${ki.note}`);
    }
    console.log();
  }

  if (newIssues.length === 0) {
    console.log("✅ No new schema drift detected.");
    if (knownIssues.length > 0) {
      console.log(`   (${knownIssues.length} known issue(s) tracked above)`);
    }
    await sql.end();
    process.exit(0);
  }

  console.log(`❌ ${newIssues.length} NEW drift issue(s) found:\n`);
  for (const i of newIssues) {
    console.log(
      `[${i.severity}] ${i.type}: ${i.table}.${i.column}`
    );
    if (i.type === "MISSING_IN_DB") {
      console.log(`  Schema has: ${i.expected}`);
      console.log(`  DB missing this column — writes will fail at runtime!`);
      console.log(`  Fix: ALTER TABLE ${i.table} ADD COLUMN ${i.column} <type>;`);
    } else if (i.type === "TYPE_MISMATCH") {
      console.log(`  Schema expects: ${i.expected}`);
      console.log(`  DB has: ${i.actual}`);
    } else if (i.type === "IN_DB_NOT_SCHEMA") {
      console.log(`  DB has: ${i.actual}`);
      console.log(`  Not in Drizzle schema — ORM can't read/write this column`);
    }
    console.log();
  }

  await sql.end();
  process.exit(1);
}

main().catch((err) => {
  console.error("Script error:", err.message);
  process.exit(1);
});
