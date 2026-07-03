-- Migration: Auto-sync trigger from geo_sites → geo_site_view
-- Every INSERT/UPDATE on geo_sites automatically upserts into geo_site_view.
-- Replaces all application-level syncSiteView/syncSiteViewStatus calls.

CREATE OR REPLACE FUNCTION sync_geo_site_view() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO geo_site_view (
    site_id, domain, slug, team_id, access_token, token_expires_at,
    pipeline_status, pipeline_error,
    overall_score, previous_score, projected_score, projected_boost, baseline_score,
    pillars, page_count, crawl_count, manual_runs_month,
    executive_summary, ranked_recommendations, change_log,
    per_page_results, per_page_fixes, implementation_status,
    generated_llms_txt, generated_llms_full_txt, generated_business_json, generated_schema_blocks,
    discovery_data, platform_detected, share_token, domain_verified, verify_token,
    citation_narrative, discovered_competitors, brand_keywords, extracted_categories,
    baseline_scorecard, last_crawl_at, next_crawl_at, created_at, updated_at
  ) VALUES (
    NEW.id, NEW.domain, NEW.slug, NEW.team_id, NEW.access_token, NEW.token_expires_at,
    NEW.pipeline_status, NEW.pipeline_error,
    (NEW.geo_scorecard->>'overallScore')::numeric::int,
    (NEW.previous_run_snapshot->'geoScorecard'->>'overallScore')::numeric::int,
    (NEW.recommendations->>'projectedScore')::numeric::int,
    (NEW.recommendations->>'projectedBoost')::numeric::int,
    (NEW.baseline_scorecard->>'overallScore')::numeric::int,
    NEW.geo_scorecard->'pillars',
    coalesce(jsonb_array_length(NEW.crawl_data->'pages'), 0),
    NEW.crawl_count, NEW.manual_runs_this_month,
    NEW.executive_summary,
    NEW.recommendations->'rankedRecommendations',
    NEW.change_log,
    NEW.per_page_results, NEW.per_page_fixes, NEW.implementation_status,
    NEW.generated_llms_txt, NEW.generated_llms_full_txt, NEW.generated_business_json, NEW.generated_schema_blocks,
    NEW.discovery_data, NEW.platform_detected, NEW.share_token,
    coalesce(NEW.domain_verified, false), NEW.verify_token,
    NEW.citation_narrative, NEW.discovered_competitors, NEW.brand_keywords, NEW.extracted_categories,
    NEW.baseline_scorecard, NEW.last_crawl_at, NEW.next_crawl_at, NEW.created_at, NOW()
  )
  ON CONFLICT (site_id) DO UPDATE SET
    domain = EXCLUDED.domain,
    slug = EXCLUDED.slug,
    team_id = EXCLUDED.team_id,
    access_token = EXCLUDED.access_token,
    token_expires_at = EXCLUDED.token_expires_at,
    pipeline_status = EXCLUDED.pipeline_status,
    pipeline_error = EXCLUDED.pipeline_error,
    overall_score = EXCLUDED.overall_score,
    previous_score = EXCLUDED.previous_score,
    projected_score = EXCLUDED.projected_score,
    projected_boost = EXCLUDED.projected_boost,
    baseline_score = EXCLUDED.baseline_score,
    pillars = EXCLUDED.pillars,
    page_count = EXCLUDED.page_count,
    crawl_count = EXCLUDED.crawl_count,
    manual_runs_month = EXCLUDED.manual_runs_month,
    executive_summary = EXCLUDED.executive_summary,
    ranked_recommendations = EXCLUDED.ranked_recommendations,
    change_log = EXCLUDED.change_log,
    per_page_results = EXCLUDED.per_page_results,
    per_page_fixes = EXCLUDED.per_page_fixes,
    implementation_status = EXCLUDED.implementation_status,
    generated_llms_txt = EXCLUDED.generated_llms_txt,
    generated_llms_full_txt = EXCLUDED.generated_llms_full_txt,
    generated_business_json = EXCLUDED.generated_business_json,
    generated_schema_blocks = EXCLUDED.generated_schema_blocks,
    discovery_data = EXCLUDED.discovery_data,
    platform_detected = EXCLUDED.platform_detected,
    share_token = EXCLUDED.share_token,
    domain_verified = EXCLUDED.domain_verified,
    verify_token = EXCLUDED.verify_token,
    citation_narrative = EXCLUDED.citation_narrative,
    discovered_competitors = EXCLUDED.discovered_competitors,
    brand_keywords = EXCLUDED.brand_keywords,
    extracted_categories = EXCLUDED.extracted_categories,
    baseline_scorecard = EXCLUDED.baseline_scorecard,
    last_crawl_at = EXCLUDED.last_crawl_at,
    next_crawl_at = EXCLUDED.next_crawl_at,
    updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop if exists (idempotent)
DROP TRIGGER IF EXISTS geo_sites_to_view ON geo_sites;

CREATE TRIGGER geo_sites_to_view
  AFTER INSERT OR UPDATE ON geo_sites
  FOR EACH ROW EXECUTE FUNCTION sync_geo_site_view();

-- Second trigger: sync citation_rate from citation_check_scores → geo_site_view
CREATE OR REPLACE FUNCTION sync_citation_rate() RETURNS TRIGGER AS $$
BEGIN
  UPDATE geo_site_view
  SET citation_rate = NEW.overall_visibility, updated_at = NOW()
  WHERE site_id = NEW.site_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS citation_scores_to_view ON citation_check_scores;

CREATE TRIGGER citation_scores_to_view
  AFTER INSERT OR UPDATE ON citation_check_scores
  FOR EACH ROW EXECUTE FUNCTION sync_citation_rate();
