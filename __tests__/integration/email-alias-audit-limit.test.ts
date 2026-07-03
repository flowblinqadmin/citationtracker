/**
 * Integration Test — Email-alias free-audit-limit bypass (NEW-A-02)
 *
 * Verifies that the owner_email_canonical indexed column closes the Gmail
 * dot/plus aliasing bypass that let a single user accumulate unlimited free
 * audits.
 *
 * Column approach: at insert time the route sets
 *   owner_email_canonical = canonicalizeEmail(ownerEmail)
 * so "u.ser+promo@gmail.com" and "user@gmail.com" both write "user@gmail.com"
 * into the column. The FREE_AUDIT_LIMIT count queries:
 *   WHERE owner_email_canonical = canonicalizeEmail(incomingEmail)
 * — an indexed equality scan, not a full-table scan.
 *
 * Scenario:
 *   1. Seed 2 geo_sites for "user@gmail.com" WITH owner_email_canonical set
 *      to canonicalizeEmail("user@gmail.com") = "user@gmail.com".
 *   2. Attempt a 3rd as "u.ser+promo@gmail.com":
 *      canonicalizeEmail("u.ser+promo@gmail.com") = "user@gmail.com"
 *      → WHERE owner_email_canonical = 'user@gmail.com' → 2 rows → BLOCKED.
 *   3. Verify non-Gmail alias stays distinct: "a.b+c@outlook.com" vs
 *      "a.b@outlook.com" have DIFFERENT canonical forms → NOT merged.
 *
 * On the BASE branch (exact-match only):
 *   - WHERE owner_email = 'u.ser+promo@gmail.com' finds 0 rows → bypass.
 *   - The canonical-column count assertion FAILS (column absent or 0 rows).
 *
 * After this fix:
 *   - WHERE owner_email_canonical = 'user@gmail.com' finds 2 rows → blocks.
 *
 * Requires local Postgres at :54322 (local Supabase) or DATABASE_URL_LOCAL.
 * Auto-skips if unreachable (safe for Docker Vitest CI unit pass).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { canonicalizeEmail } from "@/lib/email-canonical";
import { FREE_AUDIT_LIMIT } from "@/lib/config";

// ── Connection config ─────────────────────────────────────────────────────────

const LOCAL_DB =
  process.env.DATABASE_URL_LOCAL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function isLocalDbReachable(): Promise<boolean> {
  let sql: ReturnType<typeof postgres> | undefined;
  try {
    sql = postgres(LOCAL_DB, { max: 1, prepare: false, connect_timeout: 3 });
    await sql`SELECT 1 AS ping`;
    return true;
  } catch {
    return false;
  } finally {
    await sql?.end();
  }
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("email-alias free-audit-limit bypass (NEW-A-02) — column approach", () => {
  let sql: ReturnType<typeof postgres>;
  let skip = false;

  // Unique IDs per run so parallel test runs don't collide.
  const RUN_ID = `test-${Date.now()}`;
  const SITE_ID_1 = `${RUN_ID}-s1`;
  const SITE_ID_2 = `${RUN_ID}-s2`;
  const BASE_EMAIL = "user@gmail.com";
  const ALIAS_EMAIL = "u.ser+promo@gmail.com";

  beforeAll(async () => {
    skip = !(await isLocalDbReachable());
    if (skip) return;

    sql = postgres(LOCAL_DB, { max: 1, prepare: false });

    // Seed two free-audit sites for the base email WITH owner_email_canonical
    // populated — mirrors what the fixed route now does at insert time.
    const canonBase = canonicalizeEmail(BASE_EMAIL); // "user@gmail.com"
    await sql`
      INSERT INTO geo_sites
        (id, domain, slug, owner_email, owner_email_canonical,
         pipeline_status, payment_status,
         email_verified, audit_mode, current_run_number, current_run_kind, crawl_frequency,
         token_expires_at)
      VALUES
        (${SITE_ID_1},
         ${"site1-" + RUN_ID + ".example.com"},
         ${"site1-" + RUN_ID + "-" + SITE_ID_1.slice(0, 6)},
         ${BASE_EMAIL}, ${canonBase},
         'pending', 'pending', false, 'single', 1, 'initial', 'manual',
         NOW() + interval '1 day'),
        (${SITE_ID_2},
         ${"site2-" + RUN_ID + ".example.com"},
         ${"site2-" + RUN_ID + "-" + SITE_ID_2.slice(0, 6)},
         ${BASE_EMAIL}, ${canonBase},
         'pending', 'pending', false, 'single', 1, 'initial', 'manual',
         NOW() + interval '1 day')
    `;
  });

  afterAll(async () => {
    if (sql) {
      await sql`DELETE FROM geo_sites WHERE id IN (${SITE_ID_1}, ${SITE_ID_2})`;
      await sql.end();
    }
  });

  it("skips automatically when local DB is unreachable", () => {
    if (!skip) return;
    expect(skip).toBe(true);
  });

  // ── Core canonical-column leakage test ───────────────────────────────────

  it("OLD EXACT-MATCH (baseline): alias email finds 0 rows with owner_email exact match", async () => {
    if (skip) return;

    // Confirm the bypass was real: exact match on raw owner_email finds nothing
    // for the alias — the rows were seeded with BASE_EMAIL, not ALIAS_EMAIL.
    const rows = await sql`
      SELECT id FROM geo_sites WHERE owner_email = ${ALIAS_EMAIL}
    `;
    expect(rows.length).toBe(0);
  });

  it("NEW CANONICAL-COLUMN (green-after-fix): alias canonical = base canonical → indexed count blocks the 3rd audit", async () => {
    if (skip) return;

    const canonicalIncoming = canonicalizeEmail(ALIAS_EMAIL); // "user@gmail.com"

    // This is the EXACT query the fixed route issues — indexed equality on the column.
    const rows = await sql`
      SELECT id FROM geo_sites
      WHERE owner_email_canonical = ${canonicalIncoming}
        AND id IN (${SITE_ID_1}, ${SITE_ID_2})
    `;

    // Canonical form of alias must equal canonical form of base
    expect(canonicalizeEmail(BASE_EMAIL)).toBe(canonicalizeEmail(ALIAS_EMAIL));

    // Count must meet/exceed FREE_AUDIT_LIMIT → limit fires
    expect(rows.length).toBeGreaterThanOrEqual(FREE_AUDIT_LIMIT);
  });

  // ── Sanity: base email itself is still blocked ────────────────────────────

  it("base email 'user@gmail.com' is also blocked (canonical column count >= FREE_AUDIT_LIMIT)", async () => {
    if (skip) return;

    const canonicalIncoming = canonicalizeEmail(BASE_EMAIL);
    const rows = await sql`
      SELECT id FROM geo_sites
      WHERE owner_email_canonical = ${canonicalIncoming}
        AND id IN (${SITE_ID_1}, ${SITE_ID_2})
    `;
    expect(rows.length).toBeGreaterThanOrEqual(FREE_AUDIT_LIMIT);
  });

  // ── Non-Gmail alias is NOT merged (regression guard) ─────────────────────

  it("non-gmail alias 'a.b+c@outlook.com' is NOT merged with 'a.b@outlook.com'", () => {
    // Regression: other providers must NOT be over-normalised.
    expect(canonicalizeEmail("a.b+c@outlook.com")).not.toBe(
      canonicalizeEmail("a.b@outlook.com")
    );
  });

  // ── Column existence guard ────────────────────────────────────────────────

  it("owner_email_canonical column exists on geo_sites and is indexed", async () => {
    if (skip) return;

    // Verify the column exists
    const colRows = await sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'geo_sites'
        AND column_name = 'owner_email_canonical'
    `;
    expect(colRows.length).toBe(1);

    // Verify the index exists
    const idxRows = await sql`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'geo_sites'
        AND indexname = 'idx_geo_sites_owner_email_canonical'
    `;
    expect(idxRows.length).toBe(1);
  });
});
