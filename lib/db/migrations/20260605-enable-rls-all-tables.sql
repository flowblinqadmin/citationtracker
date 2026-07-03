-- Migration: Enable Row-Level Security on every public table
--
-- Fixes the recurring Supabase security advisor alert `rls_disabled_in_public`
-- (project mkwjqntnlmogwjqxezqw): tables in the `public` schema without RLS are
-- world-readable/writable through Supabase's PostgREST anon API.
--
-- Why this is safe for the app:
--   * App runtime connects with the `postgres` driver (DATABASE_URL) — the
--     postgres/owner role has BYPASSRLS, so direct SQL is unaffected.
--   * The only Supabase-JS data access (lib/supabase-edge.ts → supabaseEdge,
--     used by app/api/t/[slug]/route.ts) uses the SERVICE_ROLE key, which also
--     bypasses RLS.
--   * No code path reads these tables via the anon/authenticated PostgREST roles.
--
-- Enabling RLS with NO policies => anon/authenticated PostgREST access is denied
-- (the vulnerability), while bypassing roles keep working. This is the minimal
-- correct fix. Idempotent: ENABLE ROW LEVEL SECURITY is a no-op if already on.
--
-- Durability: re-run this migration after adding any new table to
-- lib/db/schema.ts (the DO block auto-covers every public table lacking RLS).

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'            -- ordinary tables only (not views/matviews)
      AND c.relrowsecurity = false   -- skip tables that already have RLS on
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', r.relname);
    RAISE NOTICE 'RLS enabled on public.%', r.relname;
  END LOOP;
END $$;
