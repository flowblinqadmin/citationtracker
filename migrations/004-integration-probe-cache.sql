-- Integration Probe Cache table for Phase 4 Cleo overhaul
-- Caches HEAD probe results for llms.txt and schema.json (15-min TTL).
-- Tracking pixel last-seen is queried fresh via indexed query.

CREATE TABLE IF NOT EXISTS integration_probe_cache (
  site_id VARCHAR(191) PRIMARY KEY,
  llms_txt_ok BOOLEAN,
  llms_txt_method VARCHAR(32),
  llms_txt_checked_at TIMESTAMP,
  schema_json_ok BOOLEAN,
  schema_json_checked_at TIMESTAMP,
  tracking_pixel_last_seen_at TIMESTAMP,
  refreshed_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS integration_probe_cache_refreshed_at_idx
  ON integration_probe_cache(refreshed_at);
