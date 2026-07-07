-- TEST FIXTURE ONLY — recreates the shared tables this service touches, with
-- column shapes verified against geo prod information_schema (2026-07-03).
-- Used by the local/Docker test database and the schema-drift test. This is
-- NOT a migration: geo owns these tables in real environments.

CREATE TABLE IF NOT EXISTS teams (
  id text PRIMARY KEY,
  name text NOT NULL,
  owner_user_id text NOT NULL,
  credit_balance integer NOT NULL DEFAULT 20,
  stripe_customer_id text,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now(),
  frozen boolean NOT NULL DEFAULT false,
  subscription_tier text NOT NULL DEFAULT 'free',
  stripe_subscription_id text,
  subscription_status text NOT NULL DEFAULT 'inactive',
  monthly_page_allowance integer NOT NULL DEFAULT 20,
  monthly_pages_used integer NOT NULL DEFAULT 0,
  current_period_end timestamp,
  billing_model text NOT NULL DEFAULT 'free'
);

CREATE TABLE IF NOT EXISTS team_members (
  id text PRIMARY KEY,
  team_id text NOT NULL REFERENCES teams(id),
  user_id text,
  email text NOT NULL,
  role text NOT NULL DEFAULT 'member',
  invite_token text,
  invite_accepted_at timestamp,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credit_transactions (
  id text PRIMARY KEY,
  team_id text NOT NULL REFERENCES teams(id),
  site_id text,
  parent_site_id text,
  type text NOT NULL,
  description text,
  pages_consumed integer DEFAULT 0,
  credits_changed integer NOT NULL,
  balance_before integer NOT NULL,
  balance_after integer NOT NULL,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key text PRIMARY KEY,
  count integer NOT NULL DEFAULT 0,
  reset_at timestamp NOT NULL
);

CREATE SCHEMA IF NOT EXISTS tracker;

CREATE TABLE IF NOT EXISTS tracker.orgs (
  id text PRIMARY KEY,
  name text NOT NULL,
  share_defaults jsonb DEFAULT '{}',
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tracker.members (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES tracker.orgs(id) ON DELETE CASCADE,
  user_id text,
  email text NOT NULL,
  role text NOT NULL DEFAULT 'account_member',
  invite_token text,
  invite_accepted_at timestamp,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tracker.clients (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES tracker.orgs(id) ON DELETE CASCADE,
  name text NOT NULL,
  domain text,
  brand_keywords jsonb,
  competitors jsonb DEFAULT '[]',
  status text NOT NULL DEFAULT 'active',
  run_frequency text NOT NULL DEFAULT 'monthly',
  share_token text,
  next_run_at timestamp,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tracker.prompts (
  id text PRIMARY KEY,
  client_id text NOT NULL REFERENCES tracker.clients(id) ON DELETE CASCADE,
  name text NOT NULL,
  category text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamp DEFAULT now()
);

-- R22 (geo PR194, applied by CE migration 20260707-tracker-members-org-user-uniq
-- at go-live): one accepted membership per (org, user).
CREATE UNIQUE INDEX IF NOT EXISTS tracker_members_org_user_uniq
  ON tracker.members(org_id, user_id)
  WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS tracker.prompt_versions (
  id text PRIMARY KEY,
  prompt_id text NOT NULL REFERENCES tracker.prompts(id) ON DELETE CASCADE,
  version integer NOT NULL,
  text text NOT NULL,
  created_by text,
  created_at timestamp DEFAULT now()
);

-- geo migration 20260612 (in prod): immutable versioning key
CREATE UNIQUE INDEX IF NOT EXISTS tracker_prompt_versions_prompt_version_uniq
  ON tracker.prompt_versions (prompt_id, version);

CREATE TABLE IF NOT EXISTS tracker.articles (
  id text PRIMARY KEY,
  client_id text NOT NULL REFERENCES tracker.clients(id) ON DELETE CASCADE,
  url text NOT NULL,
  normalized_url text NOT NULL,
  outlet text,
  headline text,
  published_at timestamp,
  source text NOT NULL DEFAULT 'manual',
  batch_id text,
  created_at timestamp DEFAULT now()
);

-- geo migration 20260612 (in prod): one article per normalized URL per client
CREATE UNIQUE INDEX IF NOT EXISTS tracker_articles_client_norm_uniq
  ON tracker.articles (client_id, normalized_url);

CREATE TABLE IF NOT EXISTS tracker.runs (
  id text PRIMARY KEY,
  client_id text NOT NULL REFERENCES tracker.clients(id) ON DELETE CASCADE,
  org_id text NOT NULL,
  period text NOT NULL,
  kind text NOT NULL DEFAULT 'scheduled',
  status text NOT NULL DEFAULT 'pending',
  cursor integer NOT NULL DEFAULT 0,
  prompts_total integer,
  started_at timestamp,
  completed_at timestamp,
  error text,
  metrics jsonb,
  prompt_versions_changed jsonb DEFAULT '[]',
  models_used jsonb DEFAULT '{}',
  scope jsonb,
  created_at timestamp DEFAULT now()
);

-- geo's scheduled-run idempotency (one auto-run per client per period)
CREATE UNIQUE INDEX IF NOT EXISTS tracker_runs_scheduled_period_uniq
  ON tracker.runs (client_id, period) WHERE kind = 'scheduled';

CREATE TABLE IF NOT EXISTS tracker.responses (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES tracker.runs(id) ON DELETE CASCADE,
  client_id text NOT NULL,
  prompt_version_id text NOT NULL REFERENCES tracker.prompt_versions(id),
  -- prod enforces this CHECK (geo migration 20260704) — mirror it so a new
  -- platform that misses the prod constraint fails tests too
  platform text NOT NULL CHECK (platform IN ('perplexity', 'openai', 'google', 'anthropic')),
  model text,
  attempt integer NOT NULL DEFAULT 1,
  response_text text,
  cited_urls jsonb DEFAULT '[]',
  brand_mentioned boolean NOT NULL DEFAULT false,
  sentiment text,
  response_time_ms integer,
  error text,
  created_at timestamp DEFAULT now()
);

-- geo migration 20260612 (in prod): the engine's chunked-worker idempotency key.
-- onConflictDoNothing on this index is what makes resume/re-delivery safe — the
-- fixture MUST carry it or the runner-db tests would pass while prod dedupes.
CREATE UNIQUE INDEX IF NOT EXISTS tracker_responses_run_pv_platform_attempt_uniq
  ON tracker.responses (run_id, prompt_version_id, platform, attempt);

-- Owned by the citation service (see lib/db/migrations/20260703-citation-checks.sql)
CREATE TABLE IF NOT EXISTS citation_checks (
  citation_id   text PRIMARY KEY,
  run_id        text NOT NULL,
  client_id     text NOT NULL,
  url           text NOT NULL,
  status        text NOT NULL,
  http_status   integer,
  brand_matched boolean,
  via           text,
  checked_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS citation_checks_run_id_idx ON citation_checks (run_id);

CREATE TABLE IF NOT EXISTS ai_search_snapshots (
  id              text PRIMARY KEY,
  client_id       text NOT NULL,
  prompt_id       text NOT NULL,
  engine          text NOT NULL DEFAULT 'google_aio',
  query           text NOT NULL,
  present         boolean NOT NULL,
  brand_mentioned boolean,
  overview_text   text,
  cited_urls      jsonb DEFAULT '[]',
  checked_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_search_snapshots_client_idx ON ai_search_snapshots (client_id);
CREATE INDEX IF NOT EXISTS ai_search_snapshots_prompt_idx ON ai_search_snapshots (prompt_id, checked_at DESC);

-- run_id/client_id CASCADE FKs: R27 (geo PR194, applied by CE migration
-- 20260707-tracker-citations-fk-cascade at go-live).
CREATE TABLE IF NOT EXISTS tracker.citations (
  id text PRIMARY KEY,
  response_id text REFERENCES tracker.responses(id) ON DELETE SET NULL,
  run_id text NOT NULL REFERENCES tracker.runs(id) ON DELETE CASCADE,
  client_id text NOT NULL REFERENCES tracker.clients(id) ON DELETE CASCADE,
  prompt_version_id text,
  platform text,
  raw_url text NOT NULL,
  resolved_url text,
  normalized_url text NOT NULL,
  domain text NOT NULL,
  match_type text NOT NULL,
  article_id text,
  competitor_domain text,
  review_status text,
  created_at timestamp DEFAULT now()
);
