// TEST_DATABASE_URL (when set) is the database for DB-backed tests — it must
// win before any test imports lib/db (module-level singleton).
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  delete process.env.SUPABASE_DATABASE_URL;
  delete process.env.POSTGRES_URL;
} else if (!process.env.SUPABASE_DATABASE_URL && !process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
  // Placeholder so lib/db/index.ts doesn't throw on import in pure tests.
  process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
}
// lib/cron-auth asserts a valid CRON_SECRET at module load (fail-closed).
if (!process.env.CRON_SECRET) {
  process.env.CRON_SECRET = "test-cron-secret-0123456789abcdef";
}
