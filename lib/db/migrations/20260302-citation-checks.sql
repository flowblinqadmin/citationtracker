-- Migration: Add citation monitoring tables (TS-015 / Issue #104)
-- Run: npx drizzle-kit push

CREATE TABLE IF NOT EXISTS citation_check_responses (
  id                    TEXT PRIMARY KEY,
  check_id              TEXT NOT NULL,
  site_id               TEXT NOT NULL REFERENCES geo_sites(id) ON DELETE CASCADE,
  provider              TEXT NOT NULL,
  model                 TEXT NOT NULL,
  query                 TEXT NOT NULL,
  response              TEXT,
  response_time_ms      INTEGER,
  mentioned             BOOLEAN NOT NULL DEFAULT FALSE,
  position              INTEGER,
  sentiment             TEXT,
  competitors_mentioned JSONB DEFAULT '[]',
  error                 TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS citation_responses_check_id_idx ON citation_check_responses(check_id);
CREATE INDEX IF NOT EXISTS citation_responses_site_id_idx ON citation_check_responses(site_id);

CREATE TABLE IF NOT EXISTS citation_check_scores (
  check_id              TEXT PRIMARY KEY,
  site_id               TEXT NOT NULL REFERENCES geo_sites(id) ON DELETE CASCADE,
  team_id               TEXT NOT NULL,
  domain                TEXT NOT NULL,
  overall_visibility    INTEGER NOT NULL,
  best_provider         TEXT,
  worst_provider        TEXT,
  avg_position          INTEGER,
  sentiment_score       INTEGER NOT NULL,
  provider_results      JSONB NOT NULL,
  competitor_visibility JSONB DEFAULT '{}',
  credits_used          INTEGER NOT NULL DEFAULT 5,
  prompts_used          JSONB NOT NULL,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS citation_scores_site_id_idx ON citation_check_scores(site_id);
CREATE INDEX IF NOT EXISTS citation_scores_team_id_idx ON citation_check_scores(team_id);
