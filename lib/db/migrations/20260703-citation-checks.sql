-- Citation verification verdicts — OWNED by the citation service (not a geo
-- mirror). One row per tracker.citations row we have fetched and classified:
--   verified     the page is live and mentions the brand
--   no_mention   the page is live but never mentions the brand (hallucinated
--                relevance — the AI cited a page about something else)
--   dead         4xx/5xx or unreachable
--   unverifiable non-HTML content or blocked fetch — cannot classify
-- No FK to tracker.citations: geo may purge those rows; verdicts keep history.

CREATE TABLE IF NOT EXISTS citation_checks (
  citation_id   text PRIMARY KEY,
  run_id        text NOT NULL,
  client_id     text NOT NULL,
  url           text NOT NULL,
  status        text NOT NULL,
  http_status   integer,
  brand_matched boolean,
  checked_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS citation_checks_run_id_idx ON citation_checks (run_id);

-- How the verdict was reached ('fetch' | 'crawler'); added with the Firecrawl escalation.
ALTER TABLE citation_checks ADD COLUMN IF NOT EXISTS via text;
