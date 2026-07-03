-- Add pre_analyze_done fan-in counter column to geo_sites.
-- extract-trees and research stages increment this; analyze reads it to
-- decide when both upstream stages have completed (HP perf Fix 1).
-- See app/api/pipeline/stage/route.ts:597,611-618 for the use case.
ALTER TABLE geo_sites
  ADD COLUMN IF NOT EXISTS pre_analyze_done integer NOT NULL DEFAULT 0;
