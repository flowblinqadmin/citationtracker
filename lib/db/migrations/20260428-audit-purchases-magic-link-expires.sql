-- Fix G — Add magic_link_expires_at to audit_purchases.
-- Supabase magic links expire after 1 hour by default. Stamping the expiry at
-- webhook time lets delivery code reject stale links before attempting use.
-- Additive only — nullable, existing rows left NULL.
-- Idempotent: ADD COLUMN IF NOT EXISTS is a no-op when re-applied.

ALTER TABLE audit_purchases
  ADD COLUMN IF NOT EXISTS magic_link_expires_at timestamptz;

-- Rollback: ALTER TABLE audit_purchases DROP COLUMN IF EXISTS magic_link_expires_at;
