-- ES-084 AC-3: track tree-extraction failure timestamp for operator monitoring.
-- Set by handleExtractTrees catch block. NO production code path consumes
-- this field — the rescue trigger (ES-086 AC-15) uses treeIsEmpty structure
-- detection, not failure timestamp. Preserved for manual SQL diagnostics.

ALTER TABLE geo_sites
  ADD COLUMN IF NOT EXISTS tree_extraction_failed_at timestamp;
