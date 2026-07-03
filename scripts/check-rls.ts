/**
 * check-rls — fail-closed guard against the recurring `rls_disabled_in_public`
 * Supabase advisor alert.
 *
 * Connects to the target DB and lists every table in the `public` schema that
 * does NOT have Row-Level Security enabled. Exits non-zero if any are found, so
 * it can gate a deploy / run in CI against staging before promoting to prod.
 *
 * Why this matters: the app reaches Postgres only through roles that BYPASS RLS
 * (the `postgres` driver role and the `service_role` supabase-js client), so a
 * missing RLS flag never breaks the app — but Supabase's PostgREST anon API
 * still exposes those tables publicly. New Drizzle tables therefore silently
 * reintroduce the hole. Pair with lib/db/migrations/20260605-enable-rls-all-tables.sql
 * (idempotent; re-run after adding tables) and lib/db/rls-migration.test.ts.
 *
 * Usage:
 *   SUPABASE_DATABASE_URL=... npx tsx scripts/check-rls.ts        # check
 *   DATABASE_URL=postgresql://...@127.0.0.1:54322/... npx tsx scripts/check-rls.ts
 */
import postgres from "postgres";

const url =
  process.env.SUPABASE_DATABASE_URL ??
  process.env.DATABASE_URL ??
  process.env.POSTGRES_URL ??
  "";

if (!url) {
  console.error(
    "[check-rls] No DB URL. Set SUPABASE_DATABASE_URL or DATABASE_URL (pooler ok; this is read-only)."
  );
  process.exit(2);
}

async function main() {
  const sql = postgres(url, { max: 1, prepare: false });
  try {
    // relkind='r' = ordinary tables only (skip views/matviews, which can't have RLS).
    const rows = await sql<{ relname: string }[]>`
      SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relrowsecurity = false
      ORDER BY c.relname
    `;

    if (rows.length === 0) {
      console.log("[check-rls] OK — every public table has RLS enabled.");
      await sql.end();
      return 0;
    }

    console.error(
      `[check-rls] FAIL — ${rows.length} public table(s) WITHOUT RLS (publicly exposed via PostgREST):`
    );
    for (const r of rows) console.error(`  - public.${r.relname}`);
    console.error(
      "\nFix: run lib/db/migrations/20260605-enable-rls-all-tables.sql against this DB, then re-check."
    );
    await sql.end();
    return 1;
  } catch (err) {
    console.error("[check-rls] error:", err instanceof Error ? err.message : err);
    await sql.end({ timeout: 5 }).catch(() => {});
    return 2;
  }
}

main().then((code) => process.exit(code));
