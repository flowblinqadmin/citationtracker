-- ES-059: Brand keyword extraction + LLM category extraction columns
-- Both nullable, no defaults. Populated lazily via citation-check route.
ALTER TABLE geo_sites
  ADD COLUMN IF NOT EXISTS brand_keywords jsonb,
  ADD COLUMN IF NOT EXISTS extracted_categories jsonb;
