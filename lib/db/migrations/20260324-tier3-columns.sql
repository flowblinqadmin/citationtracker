-- ES-055: Tier 3 — Content Intelligence columns
-- Run: npx drizzle-kit push (or apply manually in production)

ALTER TABLE geo_sites
  ADD COLUMN IF NOT EXISTS content_strategy_scores jsonb,
  ADD COLUMN IF NOT EXISTS engine_preferences jsonb;
