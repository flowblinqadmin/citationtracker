-- ES-B10 AC-B10-7 — in-place rerun run-tracking columns.
--
-- - currentRunNumber: monotonic 1-indexed counter incremented on every
--   regenerate / retry-failed.
-- - currentRunKind: discriminates 'initial' | 'regenerate' | 'retry-failed'
--   so handleCrawlFanout / UI can branch on intent.
-- - retrySubsetUrls: when currentRunKind='retry-failed', the URL subset to
--   re-crawl. NULL on every other run; cleared at terminal state by
--   handleAssemble.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS for all three.

ALTER TABLE geo_sites
  ADD COLUMN IF NOT EXISTS current_run_number  integer NOT NULL DEFAULT 1;

ALTER TABLE geo_sites
  ADD COLUMN IF NOT EXISTS current_run_kind    text    NOT NULL DEFAULT 'initial';

ALTER TABLE geo_sites
  ADD COLUMN IF NOT EXISTS retry_subset_urls   jsonb;
