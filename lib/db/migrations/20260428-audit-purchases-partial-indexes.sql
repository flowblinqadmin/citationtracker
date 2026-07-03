-- Fix L — Declare partial indexes on auditPurchases for drizzle parity.
-- schema.ts now uses index().where(IS NOT NULL) so drizzle-kit generate sees
-- partial indexes and does not produce a duplicate non-partial migration.
-- This migration makes existing DBs match.
-- Idempotent: CREATE INDEX IF NOT EXISTS.

-- Drop non-partial versions if they exist (from earlier drizzle push)
DROP INDEX IF EXISTS audit_purchases_site_id_idx;
DROP INDEX IF EXISTS audit_purchases_purchase_token_idx;

-- Re-create as partial indexes
CREATE INDEX IF NOT EXISTS audit_purchases_site_id_idx
  ON audit_purchases (site_id)
  WHERE site_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS audit_purchases_purchase_token_idx
  ON audit_purchases (purchase_token)
  WHERE purchase_token IS NOT NULL;

-- Rollback:
-- DROP INDEX IF EXISTS audit_purchases_site_id_idx;
-- DROP INDEX IF EXISTS audit_purchases_purchase_token_idx;
-- CREATE INDEX audit_purchases_site_id_idx ON audit_purchases (site_id);
-- CREATE INDEX audit_purchases_purchase_token_idx ON audit_purchases (purchase_token);
