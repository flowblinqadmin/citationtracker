-- FIND-025 — persist credit-deduction descriptions.
--
-- Adds a nullable description column to credit_transactions so deductCredits
-- can record a human-readable ledger note (e.g. "citation_check for site X")
-- inside the same transaction as the guarded balance update, instead of
-- dropping it on the floor. Existing rows leave the column NULL.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS is a no-op when re-applied.

ALTER TABLE credit_transactions
  ADD COLUMN IF NOT EXISTS description text;
