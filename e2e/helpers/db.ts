import { createHash, randomBytes } from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";
import postgres from "postgres";

// Load .env.local since Playwright doesn't auto-load it
try {
  const envFile = readFileSync(resolve(__dirname, "../../.env.local"), "utf8");
  for (const line of envFile.split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) {
      process.env[m[1].trim()] = m[2].trim().replace(/^"|"$/g, "");
    }
  }
} catch { /* .env.local not found — use existing env */ }

const DATABASE_URL = process.env.DATABASE_URL ?? process.env.SUPABASE_DATABASE_URL ?? "";

let _sql: ReturnType<typeof postgres> | null = null;

function getDb() {
  if (!_sql) {
    // Use direct URL if available (no pgbouncer issues), otherwise pooler with prepare: false
    const url = process.env.DATABASE_URL_DIRECT ?? DATABASE_URL;
    _sql = postgres(url, { max: 1, prepare: false });
  }
  return _sql;
}

/**
 * Create a geo_site with a known OTP code for E2E testing.
 * Returns the siteId and the raw code to enter.
 */
export async function createSiteWithKnownOtp(email: string, domain: string) {
  const sql = getDb();
  const siteId = randomBytes(11).toString("base64url");
  const slug = domain.replace(/\./g, "-");
  const rawCode = "999888";
  const hashedCode = createHash("sha256").update(rawCode).digest("hex");

  // Set pipeline_status='complete' and a non-null geo_scorecard so that verify
  // skips the enqueueStage call (which fails on localhost due to QStash loopback block).
  await sql`
    INSERT INTO geo_sites (id, domain, slug, owner_email, verification_code, code_expires_at, pipeline_status, geo_scorecard, email_verified, token_expires_at, created_at, updated_at)
    VALUES (
      ${siteId},
      ${domain},
      ${slug + "-" + siteId.slice(0, 6)},
      ${email},
      ${hashedCode},
      ${new Date(Date.now() + 10 * 60_000)},
      'complete',
      '{"overall":50}'::jsonb,
      false,
      NOW() + INTERVAL '90 days',
      NOW(),
      NOW()
    )
  `;

  return { siteId, code: rawCode, email, domain };
}

/**
 * Clean up a test site and its related rows.
 */
export async function cleanupSite(siteId: string) {
  const sql = getDb();
  await sql`DELETE FROM team_domains WHERE site_id = ${siteId}`;
  await sql`DELETE FROM credit_transactions WHERE site_id = ${siteId}`;
  await sql`DELETE FROM geo_sites WHERE id = ${siteId}`;
}

/**
 * Get site info from DB.
 */
export async function getSite(siteId: string) {
  const sql = getDb();
  const [row] = await sql`SELECT * FROM geo_sites WHERE id = ${siteId}`;
  return row ?? null;
}

export async function closeDb() {
  if (_sql) {
    await _sql.end();
    _sql = null;
  }
}
