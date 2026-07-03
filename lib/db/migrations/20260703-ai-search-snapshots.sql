-- AI Search visibility snapshots — OWNED by the citation service.
-- One row per (prompt, engine) check: was an AI Overview shown for the prompt
-- as a Google query, did it mention the brand, and which sources it cited.
-- Latest row per prompt is what the UI shows; history accumulates.

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
