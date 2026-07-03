// Ensure DATABASE_URL is set so lib/db/index.ts doesn't throw on import in
// tests that don't touch the DB.
if (!process.env.SUPABASE_DATABASE_URL && !process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
  process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
}
// lib/cron-auth asserts a valid CRON_SECRET at module load (fail-closed).
if (!process.env.CRON_SECRET) {
  process.env.CRON_SECRET = "test-cron-secret-0123456789abcdef";
}
