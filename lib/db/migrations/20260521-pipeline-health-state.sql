-- Pipeline health state — tracks when we last alerted on a given failure
-- condition so the hourly cron doesn't spam hello@flowblinq.com.
-- Keys follow the pattern:
--   provider:<name>           — LLM provider health probe failure
--   audit-stuck:<siteId>      — site with completed crawl but zero citation responses
--   all-quiet                 — global "no scores written recently" detector

CREATE TABLE IF NOT EXISTS pipeline_health_state (
  key text PRIMARY KEY,
  last_alerted_at timestamptz NOT NULL DEFAULT NOW(),
  payload jsonb
);
