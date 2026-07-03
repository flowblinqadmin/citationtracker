-- ES-053: Geographic & Category trees + prompt metadata
-- All columns nullable. No default values. No indexes needed (read by PK only).

ALTER TABLE geo_sites
  ADD COLUMN IF NOT EXISTS geo_tree jsonb,
  ADD COLUMN IF NOT EXISTS category_tree jsonb,
  ADD COLUMN IF NOT EXISTS geo_category_mapping jsonb;

ALTER TABLE citation_check_scores
  ADD COLUMN IF NOT EXISTS prompt_metadata jsonb;
