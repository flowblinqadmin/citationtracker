-- TS-018: Add batchId to geo_sites for reliable bulk batch sibling lookup (issue #110)

ALTER TABLE geo_sites
  ADD COLUMN IF NOT EXISTS batch_id text;

CREATE INDEX IF NOT EXISTS idx_geo_sites_batch_id
  ON geo_sites(batch_id)
  WHERE batch_id IS NOT NULL;
