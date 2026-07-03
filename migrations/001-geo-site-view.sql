-- Migration: Create geo_site_view table
-- Purpose: Lightweight read-optimized view table for dashboard + report page rendering.
-- geoSites remains the pipeline working table — never read for rendering after this migration.

-- 1. Create the view table
CREATE TABLE IF NOT EXISTS geo_site_view (
  site_id              TEXT PRIMARY KEY,
  domain               TEXT NOT NULL,
  slug                 TEXT,
  team_id              TEXT,
  access_token         TEXT,
  pipeline_status      TEXT,
  pipeline_error       TEXT,
  overall_score        INT,
  previous_score       INT,
  projected_score      INT,
  projected_boost      INT,
  baseline_score       INT,
  pillars              JSONB,
  pillar_deltas        JSONB,
  page_count           INT DEFAULT 0,
  citation_rate        INT,
  crawl_count          INT DEFAULT 0,
  manual_runs_month    INT DEFAULT 0,
  executive_summary    TEXT,
  ranked_recommendations JSONB,
  change_log           JSONB,
  per_page_results     JSONB,
  per_page_fixes       JSONB,
  implementation_status JSONB,
  generated_llms_txt       TEXT,
  generated_llms_full_txt  TEXT,
  generated_business_json  JSONB,
  generated_schema_blocks  JSONB,
  discovery_data       JSONB,
  platform_detected    TEXT,
  share_token          TEXT,
  domain_verified      BOOLEAN DEFAULT FALSE,
  verify_token         TEXT,
  citation_narrative   TEXT,
  discovered_competitors JSONB,
  brand_keywords       JSONB,
  extracted_categories JSONB,
  baseline_scorecard   JSONB,
  last_crawl_at        TIMESTAMPTZ,
  next_crawl_at        TIMESTAMPTZ,
  created_at           TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gsv_team ON geo_site_view(team_id);
CREATE INDEX IF NOT EXISTS idx_gsv_domain ON geo_site_view(domain);

-- 2. Backfill from geo_sites
INSERT INTO geo_site_view (
  site_id, domain, slug, team_id, access_token,
  pipeline_status, pipeline_error,
  overall_score, previous_score, projected_score, projected_boost, baseline_score,
  pillars, pillar_deltas,
  page_count, crawl_count, manual_runs_month,
  executive_summary, ranked_recommendations, change_log,
  per_page_results, per_page_fixes, implementation_status,
  generated_llms_txt, generated_llms_full_txt, generated_business_json, generated_schema_blocks,
  discovery_data, platform_detected, share_token, domain_verified, verify_token,
  citation_narrative, discovered_competitors, brand_keywords, extracted_categories,
  baseline_scorecard,
  last_crawl_at, next_crawl_at, created_at, updated_at
)
SELECT
  s.id,
  s.domain,
  s.slug,
  s.team_id,
  s.access_token,
  s.pipeline_status,
  s.pipeline_error,
  (s.geo_scorecard->>'overallScore')::int,
  (s.previous_run_snapshot->'geoScorecard'->>'overallScore')::int,
  (s.recommendations->>'projectedScore')::int,
  (s.recommendations->>'projectedBoost')::int,
  (s.baseline_scorecard->>'overallScore')::int,
  s.geo_scorecard->'pillars',
  NULL,
  coalesce(jsonb_array_length(s.crawl_data->'pages'), 0),
  s.crawl_count,
  s.manual_runs_this_month,
  s.executive_summary,
  s.recommendations->'rankedRecommendations',
  s.change_log,
  s.per_page_results,
  s.per_page_fixes,
  s.implementation_status,
  s.generated_llms_txt,
  s.generated_llms_full_txt,
  s.generated_business_json,
  s.generated_schema_blocks,
  s.discovery_data,
  s.platform_detected,
  s.share_token,
  coalesce(s.domain_verified, false),
  s.verify_token,
  s.citation_narrative,
  s.discovered_competitors,
  s.brand_keywords,
  s.extracted_categories,
  s.baseline_scorecard,
  s.last_crawl_at,
  s.next_crawl_at,
  s.created_at,
  NOW()
FROM geo_sites s
ON CONFLICT (site_id) DO NOTHING;

-- 3. Backfill citation_rate from latest citation check per site
UPDATE geo_site_view v
SET citation_rate = sub.rate
FROM (
  SELECT DISTINCT ON (site_id)
    site_id,
    overall_visibility AS rate
  FROM citation_check_scores
  ORDER BY site_id, created_at DESC
) sub
WHERE v.site_id = sub.site_id;
