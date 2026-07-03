-- ES-B9.3 AC-4 — geoSites.parent_site_id for retry/regenerate spawn lineage.
--
-- Records the original site this row was spawned from. NULL on every site
-- not produced by /regenerate-bulk-aware or /retry-failed.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.

ALTER TABLE geo_sites
  ADD COLUMN IF NOT EXISTS parent_site_id text;

CREATE INDEX IF NOT EXISTS geo_sites_parent_site_idx
  ON geo_sites(parent_site_id)
  WHERE parent_site_id IS NOT NULL;
