-- ES-054: Tier 2 Measurement Depth — new columns
-- Run: npx drizzle-kit push

ALTER TABLE citation_check_scores
  ADD COLUMN IF NOT EXISTS geo_visibility jsonb DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS category_visibility jsonb DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS tier_visibility jsonb DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS avg_impression_share integer,
  ADD COLUMN IF NOT EXISTS visibility_gap_analysis jsonb DEFAULT '[]';

ALTER TABLE citation_check_responses
  ADD COLUMN IF NOT EXISTS impression_share integer;

ALTER TABLE geo_sites
  ADD COLUMN IF NOT EXISTS crawl_coverage_report jsonb;
