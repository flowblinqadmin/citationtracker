-- ES-090 §b.1 — Security Production Readiness Remediation (PR #1 schema)
--
-- Scope (per ChangedSpec §b.1, 2026-04-15):
--   1. geo_sites.token_expires_at  (NOT NULL, default NOW()+90d) — CRIT-1 / HP-196 / HP-197
--   2. geo_sites.token_rotated_at  (nullable)                     — CRIT-1 audit
--   3. geo_site_view.token_expires_at (nullable mirror)           — CRIT-1 enforcement @ GET /sites/[id]
--   4. geo_crawl_logs.ip_hash                                     — COMP-2
--   5. geo_page_views.ip_hash                                     — COMP-2
--   6. admin_audit_log (new)                                      — COMP-1 DPDP erasure trail
--   7. exchange_codes  (new)                                      — MED-6 / HP-186 DB-backed one-time redemption
--   8. Backfill existing geo_sites rows with 90-day token_expires_at
--
-- IMPORTANT: DDL in this file has NOT been applied to production.
-- Apply via `npx drizzle-kit push` or psql only after Aditya's explicit approval.
--
-- ── HP-230 precondition — pgcrypto for gen_random_uuid() ─────────────────
-- ES-090 §b.1 `admin_audit_log.id UUID DEFAULT gen_random_uuid()` requires
-- the pgcrypto extension. On Supabase the extension is pre-installed; on
-- self-hosted Postgres this line enables it. Idempotent — no-op if already
-- installed.
--
-- Operator precondition: managed Postgres without CREATEEXT on the app
-- role (rare — e.g. AWS RDS with a locked-down app user) must run this
-- line as a superuser before applying the rest of the migration.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

BEGIN;

-- ── 1. geo_sites.token_expires_at + token_rotated_at ─────────────────────
-- NOT NULL with default so new rows always have expiry. Backfill below
-- populates existing rows before the NOT NULL constraint would fail.

ALTER TABLE geo_sites
  ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS token_rotated_at TIMESTAMP;

-- 8. Backfill: any existing row with an accessToken and a NULL expiry
-- gets a fresh 90-day window and a rotated-at stamp (HP-196/HP-197).
UPDATE geo_sites
  SET token_expires_at = NOW() + INTERVAL '90 days',
      token_rotated_at = COALESCE(token_rotated_at, NOW())
  WHERE access_token IS NOT NULL AND token_expires_at IS NULL;

-- Also backfill rows without an access token (defensive — migration must
-- leave zero NULLs before applying NOT NULL).
UPDATE geo_sites
  SET token_expires_at = NOW() + INTERVAL '90 days'
  WHERE token_expires_at IS NULL;

ALTER TABLE geo_sites
  ALTER COLUMN token_expires_at SET NOT NULL,
  ALTER COLUMN token_expires_at SET DEFAULT NOW() + INTERVAL '90 days';

-- ── 3. geo_site_view.token_expires_at (mirror for read path) ─────────────
-- Nullable on the view — HP-197 code path treats NULL as expired anyway.

ALTER TABLE geo_site_view
  ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMP;

-- ── 4. geo_crawl_logs.ip_hash ────────────────────────────────────────────

ALTER TABLE geo_crawl_logs
  ADD COLUMN IF NOT EXISTS ip_hash TEXT;

-- ── 5. geo_page_views.ip_hash ────────────────────────────────────────────

ALTER TABLE geo_page_views
  ADD COLUMN IF NOT EXISTS ip_hash TEXT;

-- ── 6. admin_audit_log (new) ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  action       TEXT         NOT NULL,
  actor_email  TEXT,
  payload      JSONB,
  created_at   TIMESTAMP    NOT NULL DEFAULT NOW()
);

-- ── 7. exchange_codes (new, HP-186 DB-backed redemption) ────────────────

CREATE TABLE IF NOT EXISTS exchange_codes (
  code                  TEXT          PRIMARY KEY,
  email                 TEXT          NOT NULL,
  site_id               TEXT          REFERENCES geo_sites(id) ON DELETE CASCADE,
  payload               JSONB         NOT NULL,
  created_at            TIMESTAMP     NOT NULL DEFAULT NOW(),
  expires_at            TIMESTAMP     NOT NULL,
  redeemed_at           TIMESTAMP,
  redeemed_by_ip_hash   TEXT
);

CREATE INDEX IF NOT EXISTS exchange_codes_email_idx   ON exchange_codes(email);
CREATE INDEX IF NOT EXISTS exchange_codes_expires_idx ON exchange_codes(expires_at);

-- ── Notes for apply ───────────────────────────────────────────────────────
-- 1. `gen_random_uuid()` requires the pgcrypto extension. If not enabled,
--    run `CREATE EXTENSION IF NOT EXISTS pgcrypto;` before applying.
-- 2. The `raw ip` columns on geo_crawl_logs and geo_page_views are RETAINED
--    in this migration. Drop-column is a follow-up TS after backfill + 1w
--    safety window (TS-090 §5 COMP-2).
-- 3. The NOT NULL promotion on geo_sites.token_expires_at is non-blocking
--    for writers — the DEFAULT covers any INSERT that omits the column.
--    Existing UPDATE paths that write accessToken will also now write
--    token_expires_at (ScriptDev §b.2 step 2 / step 4).

COMMIT;
