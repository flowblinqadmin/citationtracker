-- Hallucination risk tracking for GEO audits
-- Composite score (0-100) based on grounding check failures, LLM corrections needed, entities stripped

ALTER TABLE geo_sites
  ADD COLUMN IF NOT EXISTS hallucination_risk integer;

-- Index for monitoring/filtering high-risk audits
CREATE INDEX IF NOT EXISTS idx_geo_sites_hallucination_risk
  ON geo_sites(hallucination_risk)
  WHERE hallucination_risk IS NOT NULL;
