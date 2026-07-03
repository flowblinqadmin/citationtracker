-- ES-B9 §credit / AC-B9-10 — γ free-retry policy.
--
-- Adds parent_site_id to credit_transactions so the new
-- 'bulk_retry_failed_free' ledger row can reference the failed parent
-- audit it derives from. Existing rows leave the column NULL.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS is a no-op when re-applied.

ALTER TABLE credit_transactions
  ADD COLUMN IF NOT EXISTS parent_site_id text;

CREATE INDEX IF NOT EXISTS credit_transactions_parent_site_idx
  ON credit_transactions (parent_site_id)
  WHERE parent_site_id IS NOT NULL;
