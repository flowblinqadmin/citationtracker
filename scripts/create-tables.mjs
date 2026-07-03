/**
 * Direct SQL table creation script — bypasses drizzle-kit interactive prompts.
 * Run with: node scripts/create-tables.mjs
 */
import { neon } from "@neondatabase/serverless";
import { config } from "node:process";

const sql = neon(process.env.DATABASE_URL);

const CREATE_GEO_SITES = `
CREATE TABLE IF NOT EXISTS geo_sites (
  id                      TEXT PRIMARY KEY,
  domain                  TEXT NOT NULL,
  slug                    TEXT UNIQUE NOT NULL,
  owner_email             TEXT NOT NULL,

  -- Email verification
  email_verified          BOOLEAN DEFAULT FALSE,
  verification_code       TEXT,
  code_expires_at         TIMESTAMP,
  access_token            TEXT,

  -- Stripe / payment
  stripe_customer_id           TEXT,
  stripe_checkout_session_id   TEXT,
  stripe_subscription_id       TEXT,
  payment_status               TEXT DEFAULT 'pending',

  -- Pipeline data (jsonb)
  discovery_data          JSONB,
  crawl_data              JSONB,
  research_data           JSONB,
  geo_scorecard           JSONB,

  -- Generated files
  generated_llms_txt      TEXT,
  generated_llms_full_txt TEXT,
  generated_business_json JSONB,
  generated_schema_blocks JSONB,
  recommendations         JSONB,
  executive_summary       TEXT,

  -- Site metadata
  platform_detected       TEXT,
  site_type               TEXT,

  -- Pipeline state
  pipeline_status         TEXT DEFAULT 'pending',
  pipeline_error          TEXT,

  -- Crawl scheduling
  last_crawl_at           TIMESTAMP,
  next_crawl_at           TIMESTAMP,
  crawl_count             INTEGER DEFAULT 0,
  manual_runs_this_month  INTEGER DEFAULT 0,
  manual_runs_reset_at    TIMESTAMP,

  -- Change tracking
  change_log              JSONB,
  last_significant_change TIMESTAMP,

  -- Timestamps
  created_at              TIMESTAMP DEFAULT NOW(),
  updated_at              TIMESTAMP DEFAULT NOW()
);
`;

const CREATE_INDEX_SLUG = `CREATE INDEX IF NOT EXISTS idx_geo_sites_slug ON geo_sites (slug);`;
const CREATE_INDEX_EMAIL = `CREATE INDEX IF NOT EXISTS idx_geo_sites_email ON geo_sites (owner_email);`;
const CREATE_INDEX_NEXT_CRAWL = `CREATE INDEX IF NOT EXISTS idx_geo_sites_next_crawl ON geo_sites (next_crawl_at) WHERE pipeline_status = 'complete';`;

try {
  console.warn("Creating geo_sites table...");
  await sql`CREATE TABLE IF NOT EXISTS geo_sites (
    id                      TEXT PRIMARY KEY,
    domain                  TEXT NOT NULL,
    slug                    TEXT UNIQUE NOT NULL,
    owner_email             TEXT NOT NULL,
    email_verified          BOOLEAN DEFAULT FALSE,
    verification_code       TEXT,
    code_expires_at         TIMESTAMP,
    access_token            TEXT,
    stripe_customer_id           TEXT,
    stripe_checkout_session_id   TEXT,
    stripe_subscription_id       TEXT,
    payment_status               TEXT DEFAULT 'pending',
    discovery_data          JSONB,
    crawl_data              JSONB,
    research_data           JSONB,
    geo_scorecard           JSONB,
    generated_llms_txt      TEXT,
    generated_llms_full_txt TEXT,
    generated_business_json JSONB,
    generated_schema_blocks JSONB,
    recommendations         JSONB,
    executive_summary       TEXT,
    platform_detected       TEXT,
    site_type               TEXT,
    pipeline_status         TEXT DEFAULT 'pending',
    pipeline_error          TEXT,
    last_crawl_at           TIMESTAMP,
    next_crawl_at           TIMESTAMP,
    crawl_count             INTEGER DEFAULT 0,
    manual_runs_this_month  INTEGER DEFAULT 0,
    manual_runs_reset_at    TIMESTAMP,
    change_log              JSONB,
    last_significant_change TIMESTAMP,
    created_at              TIMESTAMP DEFAULT NOW(),
    updated_at              TIMESTAMP DEFAULT NOW()
  )`;
  console.warn("✓ geo_sites table created");

  await sql`CREATE INDEX IF NOT EXISTS idx_geo_sites_slug ON geo_sites (slug)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_geo_sites_email ON geo_sites (owner_email)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_geo_sites_next_crawl ON geo_sites (next_crawl_at) WHERE pipeline_status = 'complete'`;
  console.warn("✓ Indexes created");

  // Verify
  const rows = await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'geo_sites' ORDER BY ordinal_position`;
  console.warn(`✓ Table verified: ${rows.length} columns`);
  console.warn(rows.map(r => r.column_name).join(", "));
} catch (err) {
  console.error("Failed:", err.message);
  process.exit(1);
}
