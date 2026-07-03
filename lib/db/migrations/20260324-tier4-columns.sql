-- ES-056: Tier 4 — Competitive Intelligence columns on citation_check_scores
-- Run: npx drizzle-kit push (or apply manually in production)

ALTER TABLE citation_check_scores
  ADD COLUMN IF NOT EXISTS location_competitors jsonb DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS category_competitors jsonb DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS dominance_map jsonb,
  ADD COLUMN IF NOT EXISTS real_prompt_discovery jsonb;
