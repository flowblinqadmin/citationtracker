-- NEW-P-01: track subscription pages reserved per audit so the assemble stage
-- can reconcile unused pages back to teams.monthly_pages_used on under-crawl.
-- Mirrors the existing credits_reserved pattern.
--
-- Idempotent: IF NOT EXISTS guards allow re-running without error.
ALTER TABLE geo_sites
  ADD COLUMN IF NOT EXISTS subscription_pages_reserved integer DEFAULT 0;
