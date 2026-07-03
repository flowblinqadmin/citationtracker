-- TS-058: Add prompt_architecture_version to citation_check_scores
-- V1 = legacy Sonnet tree-based generator
-- V2 = programmatic seed + Haiku rephrasing (new)

ALTER TABLE citation_check_scores
  ADD COLUMN IF NOT EXISTS prompt_architecture_version integer DEFAULT 1;

-- FIX-6: index for version filtering in history queries
CREATE INDEX IF NOT EXISTS idx_ccs_prompt_arch_version
  ON citation_check_scores(prompt_architecture_version);
