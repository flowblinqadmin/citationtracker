-- Migration: RLS hardening — REVOKE anon/authenticated + DB CHECK constraints
--
-- This migration is ADDITIVE to 20260605-enable-rls-all-tables.sql.
-- Do NOT modify that migration — this one layers on top of it.
--
-- Why REVOKE in addition to RLS?
--   Enabling RLS with no policies makes anon/authenticated PostgREST access
--   return 0 rows silently (no error). This is a "defense by silence" posture —
--   the access control is real but the failure mode is invisible, which makes
--   misconfiguration hard to detect. REVOKE converts the failure mode to a hard
--   `42501 insufficient_privilege` error (defense in depth). Any code path that
--   accidentally reaches the DB via the anon role now FAILS LOUDLY instead of
--   silently returning empty results.
--
-- App DB role is unaffected:
--   lib/db/index.ts connects via the postgres driver (DATABASE_URL / SUPABASE_DATABASE_URL
--   / POSTGRES_URL), which resolves to the `postgres` superuser (BYPASSRLS + SUPERUSER).
--   The Supabase service-role key also uses a role that bypasses RLS.
--   Neither role is `anon` or `authenticated`, so REVOKE here has zero impact on
--   the application runtime. (See lib/db/index.ts for the connection priority chain.)
--
-- consent_records is EXCLUDED from REVOKE:
--   This table stores click-wrap consent (TOS/EULA acceptance) and may need to
--   be INSERT-able via an authenticated Supabase client-side call in the future.
--   Keeping it out of the REVOKE block preserves that option without weakening
--   anything material (the table has no PII that isn't already in auth.users).
--
-- Idempotent: REVOKE on a role that already has no privileges is a no-op in
-- PostgreSQL. The DO block + ADD CONSTRAINT IF NOT EXISTS pattern makes the
-- whole migration safe to re-run.

-- ── NEW-S-01: REVOKE ALL from anon + authenticated on every public BASE table
--             EXCEPT consent_records ──────────────────────────────────────────
-- Converts anon SELECT from silent-0-rows (RLS filter) to hard 42501.
-- The postgres / service_role superuser is unaffected (BYPASSRLS + SUPERUSER).

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'            -- ordinary tables only
      AND c.relname <> 'consent_records'
  LOOP
    BEGIN
      EXECUTE format(
        'REVOKE ALL ON public.%I FROM anon, authenticated;',
        r.relname
      );
      RAISE NOTICE 'REVOKE ALL on public.% FROM anon, authenticated', r.relname;
    EXCEPTION WHEN undefined_object THEN
      -- Role doesn't exist in this environment (e.g. plain Postgres without
      -- Supabase role set-up). Skip gracefully.
      RAISE NOTICE 'Role anon or authenticated not found — skipping REVOKE for public.%', r.relname;
    END;
  END LOOP;
END $$;

-- ── NEW-S-02: CHECK constraints — subscription_tier + subscription_status ──
-- These columns are `text` in the schema (Drizzle .$type<> is TypeScript-only).
-- DB CHECK constraints make the domain exhaustive at the storage layer so no
-- code path (raw SQL, admin scripts, migration bugs) can write illegal values.
--
-- Allowed values must match lib/config.ts (SubscriptionTier) and
-- lib/db/schema.ts (SubscriptionStatus). They include all Stripe lifecycle
-- states even if the TS type doesn't enumerate all of them today, so that
-- historical rows from future Stripe webhooks remain valid.

DO $$
BEGIN
  -- subscription_tier CHECK
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'teams_subscription_tier_check'
      AND conrelid = 'public.teams'::regclass
  ) THEN
    ALTER TABLE public.teams
      ADD CONSTRAINT teams_subscription_tier_check
      CHECK (subscription_tier IN ('free', 'starter', 'growth', 'pro'));
    RAISE NOTICE 'Added CHECK constraint teams_subscription_tier_check';
  ELSE
    RAISE NOTICE 'CHECK constraint teams_subscription_tier_check already exists — skipping';
  END IF;

  -- subscription_status CHECK
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'teams_subscription_status_check'
      AND conrelid = 'public.teams'::regclass
  ) THEN
    ALTER TABLE public.teams
      ADD CONSTRAINT teams_subscription_status_check
      CHECK (subscription_status IN (
        'active', 'past_due', 'canceled', 'inactive',
        'trialing', 'unpaid', 'paused'
      ));
    RAISE NOTICE 'Added CHECK constraint teams_subscription_status_check';
  ELSE
    RAISE NOTICE 'CHECK constraint teams_subscription_status_check already exists — skipping';
  END IF;
END $$;

-- ── NEW-S-03: CHECK constraints — credit_balance + monthly_pages_used ≥ 0 ──
-- Negative balances / usage counters indicate a ledger or accounting bug.
-- These constraints catch that at the DB layer rather than letting it silently
-- accumulate. We emit a NOTICE (not an error) for any pre-existing violating
-- rows before adding the constraint — safe to re-run, will not abort the migration.

DO $$
DECLARE
  neg_credits INTEGER;
  neg_pages   INTEGER;
BEGIN
  -- Count pre-existing violations
  SELECT COUNT(*) INTO neg_credits FROM public.teams WHERE credit_balance < 0;
  SELECT COUNT(*) INTO neg_pages   FROM public.teams WHERE monthly_pages_used < 0;

  IF neg_credits > 0 THEN
    RAISE NOTICE 'WARNING: % team row(s) have credit_balance < 0 — fix before constraint will be enforced on those rows', neg_credits;
  END IF;

  IF neg_pages > 0 THEN
    RAISE NOTICE 'WARNING: % team row(s) have monthly_pages_used < 0 — fix before constraint will be enforced on those rows', neg_pages;
  END IF;

  -- credit_balance >= 0 CHECK
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'teams_credit_balance_non_negative'
      AND conrelid = 'public.teams'::regclass
  ) THEN
    IF neg_credits = 0 THEN
      ALTER TABLE public.teams
        ADD CONSTRAINT teams_credit_balance_non_negative
        CHECK (credit_balance >= 0);
      RAISE NOTICE 'Added CHECK constraint teams_credit_balance_non_negative';
    ELSE
      RAISE NOTICE 'SKIPPED teams_credit_balance_non_negative — existing rows violate it (see count above). Fix data first.';
    END IF;
  ELSE
    RAISE NOTICE 'CHECK constraint teams_credit_balance_non_negative already exists — skipping';
  END IF;

  -- monthly_pages_used >= 0 CHECK
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'teams_monthly_pages_used_non_negative'
      AND conrelid = 'public.teams'::regclass
  ) THEN
    IF neg_pages = 0 THEN
      ALTER TABLE public.teams
        ADD CONSTRAINT teams_monthly_pages_used_non_negative
        CHECK (monthly_pages_used >= 0);
      RAISE NOTICE 'Added CHECK constraint teams_monthly_pages_used_non_negative';
    ELSE
      RAISE NOTICE 'SKIPPED teams_monthly_pages_used_non_negative — existing rows violate it (see count above). Fix data first.';
    END IF;
  ELSE
    RAISE NOTICE 'CHECK constraint teams_monthly_pages_used_non_negative already exists — skipping';
  END IF;
END $$;
