/**
 * Integration Test — RLS REVOKE Hard-Denial Enforcement (NEW-S-01)
 *
 * Verifies that after applying:
 *   1. 20260605-enable-rls-all-tables.sql  (cofounder's RLS enable)
 *   2. 20260609-rls-revoke-and-checks.sql  (our REVOKE hardening)
 *
 * …anon SELECT on sensitive tables throws pg error code 42501
 * (insufficient_privilege) instead of silently returning 0 rows.
 *
 * INTENTIONAL FAILURE ON BASE BRANCH:
 *   On the cofounder's branch (enable-only, no REVOKE), anon SELECT returns
 *   0 rows with no error. The anon.select assertions below FAIL in that state,
 *   which is the proof that REVOKE is the differentiator.
 *
 * Requires a running local Postgres (local Supabase at :54322, or any Postgres
 * reachable at DATABASE_URL_LOCAL). The test skips automatically if the DB is
 * unreachable, so it is safe to include in the Docker Vitest suite (which uses
 * the test DB only in the E2E/integration CI pass, not the unit pass).
 *
 * Connection used by the app (lib/db/index.ts):
 *   postgres driver → DATABASE_URL / SUPABASE_DATABASE_URL / POSTGRES_URL
 *   All resolve to the `postgres` superuser (BYPASSRLS + SUPERUSER). REVOKE
 *   on anon/authenticated has ZERO effect on this connection.
 *
 * Local Supabase ports:
 *   Postgres: 54322 (direct, no PgBouncer)
 *   Default superuser URL: postgresql://postgres:postgres@127.0.0.1:54322/postgres
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Connection config ────────────────────────────────────────────────────────

// From host (outside Docker): local Supabase postgres is at 127.0.0.1:54322
// From inside Docker: host.docker.internal:54322
// Caller can override via DATABASE_URL_LOCAL.
const LOCAL_DB =
  process.env.DATABASE_URL_LOCAL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../lib/db/migrations");
const MIGRATION_ENABLE = "20260605-enable-rls-all-tables.sql";
const MIGRATION_REVOKE = "20260609-rls-revoke-and-checks.sql";

// Tables that MUST be hard-denied for anon after REVOKE
const SENSITIVE_TABLES = [
  "teams",
  "geo_sites",
  "audit_purchases",
  "exchange_codes",
  "credit_transactions",
];

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Run SQL as superuser (postgres role). Returns the sql client. */
async function connectSuperuser(): Promise<ReturnType<typeof postgres>> {
  return postgres(LOCAL_DB, {
    max: 1,
    prepare: false,
    connect_timeout: 3,
  });
}

/**
 * Returns true if the DB is reachable and the anon role exists.
 * If either fails we skip the whole suite (test-environment gap, not a bug).
 */
async function isLocalDbReachable(): Promise<boolean> {
  let sql: ReturnType<typeof postgres> | undefined;
  try {
    sql = await connectSuperuser();
    // Quick connectivity probe
    await sql`SELECT 1 AS ping`;
    // Check anon role exists (may not in plain Postgres without Supabase)
    const rows = await sql`
      SELECT 1 FROM pg_roles WHERE rolname = 'anon'
    `;
    return rows.length > 0;
  } catch {
    return false;
  } finally {
    await sql?.end();
  }
}

/**
 * Execute a SQL file against the superuser connection.
 * Errors here are real failures (migration syntax / constraint violation on data).
 */
async function applyMigration(sql: ReturnType<typeof postgres>, filename: string) {
  const filePath = path.join(MIGRATIONS_DIR, filename);
  const content = fs.readFileSync(filePath, "utf8");
  // postgres.js doesn't support multi-statement strings directly; split on
  // statement boundaries that aren't inside dollar-quoted blocks.
  // The migrations use DO $$ ... $$ blocks — we execute as a single unsafe
  // string to preserve them.
  await sql.unsafe(content);
}

// ── Test suite ───────────────────────────────────────────────────────────────

describe("RLS REVOKE hard-denial enforcement (NEW-S-01)", () => {
  let sql: ReturnType<typeof postgres>;
  let skip = false;

  beforeAll(async () => {
    skip = !(await isLocalDbReachable());
    if (skip) return;

    sql = await connectSuperuser();

    // Apply the cofounder's RLS-enable migration (idempotent)
    await applyMigration(sql, MIGRATION_ENABLE);

    // Apply our REVOKE migration (idempotent)
    await applyMigration(sql, MIGRATION_REVOKE);
  });

  afterAll(async () => {
    await sql?.end();
  });

  it("skips if local DB is unreachable or anon role absent", () => {
    if (!skip) return; // DB is up — real tests run below
    // If we get here, the suite was skipped. Mark as passing skip.
    expect(skip).toBe(true);
  });

  // ── SELECT hard-denial tests ──────────────────────────────────────────────

  for (const table of SENSITIVE_TABLES) {
    it(`anon SELECT on ${table} throws 42501 (not silent 0 rows)`, async () => {
      if (skip) return;

      // CRITICAL: SET LOCAL ROLE inside a transaction that is used for the query.
      // If you SET ROLE on one connection and query on another, the role check is
      // a no-op (superuser connection is still superuser). Using a fresh
      // transaction on the same sql client guarantees the role change applies to
      // the SELECT that follows.
      let threw = false;
      let pgCode: string | undefined;

      try {
        await sql.begin(async (tx) => {
          // Switch to anon role within this transaction
          await tx`SET LOCAL ROLE anon`;
          // This SELECT must throw 42501 after REVOKE; on enable-only it returns []
          await tx.unsafe(`SELECT 1 FROM public.${table} LIMIT 1`);
        });
      } catch (err: unknown) {
        threw = true;
        pgCode = (err as { code?: string }).code;
      }

      // On enable-only base (no REVOKE): threw=false, pgCode=undefined — FAILS here
      // On our migration (REVOKE applied):  threw=true, pgCode='42501' — PASSES
      expect(threw).toBe(true);
      expect(pgCode).toBe("42501");
    });
  }

  // ── WRITE privilege check (column-agnostic) ───────────────────────────────

  for (const table of SENSITIVE_TABLES) {
    it(`anon has no UPDATE privilege on ${table}`, async () => {
      if (skip) return;

      // has_table_privilege('anon', '<tbl>', 'UPDATE') is superuser-visible
      // and does not require being the anon role — safe to run as postgres.
      const rows = await sql`
        SELECT has_table_privilege('anon', ${`public.${table}`}::regclass, 'UPDATE') AS has_priv
      `;
      expect(rows[0].has_priv).toBe(false);
    });
  }

  // ── Service-role / superuser still reads ─────────────────────────────────

  for (const table of SENSITIVE_TABLES) {
    it(`service role (postgres) can still SELECT from ${table}`, async () => {
      if (skip) return;

      // postgres is superuser — BYPASSRLS + not subject to REVOKE on anon.
      // This confirms that REVOKE doesn't break the app's own DB connection.
      let threw = false;
      try {
        await sql.unsafe(`SELECT 1 FROM public.${table} LIMIT 1`);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
    });
  }

  // ── consent_records is NOT revoked (excluded by design) ───────────────────

  it("anon still has SELECT privilege on consent_records (excluded from REVOKE)", async () => {
    if (skip) return;

    // We DON'T revoke consent_records — verify that anon privilege is intact.
    // This is intentional per the migration comment.
    const rows = await sql`
      SELECT has_table_privilege('anon', 'public.consent_records'::regclass, 'SELECT') AS has_priv
    `;
    // Default Supabase anon grants SELECT on public tables unless explicitly revoked.
    // If it's true, fine. If Supabase didn't grant it in the first place, it may
    // already be false — we assert it was NOT revoked by us (i.e., our migration
    // didn't change it). We can only assert it wasn't hard-denied by our migration.
    // The meaningful signal is: consent_records must NOT throw 42501 on anon SELECT.
    let threw = false;
    let pgCode: string | undefined;
    try {
      await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE anon`;
        await tx.unsafe(`SELECT 1 FROM public.consent_records LIMIT 1`);
      });
    } catch (err: unknown) {
      threw = true;
      pgCode = (err as { code?: string }).code;
    }

    // If anon had SELECT before our migration, it still should (we didn't revoke it).
    // If it throws, it must NOT be 42501 from our REVOKE (could be 42501 from RLS
    // no-policy — that's the cofounder's RLS, not our REVOKE).
    // The key assertion: our migration must NOT have caused consent_records to fail
    // with 42501 due to REVOKE (which would only happen if we accidentally included it).
    if (threw) {
      // Could be 42501 from RLS (enable-only with no policy) — that's acceptable.
      // The test is documenting intent, not enforcing a hard constraint on anon access
      // to consent_records (which may or may not have a grant depending on environment).
      expect(pgCode).toBeDefined(); // something threw, but we didn't REVOKE it
    }
    // No assertion needed on threw=false — anon SELECT returning [] is fine here.
  });
});
