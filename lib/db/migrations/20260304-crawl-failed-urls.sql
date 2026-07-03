-- ES-023 hotfix: track URLs that failed to crawl for future async retry
-- Populated at two points:
--   1. crawl-fanout: chunk submission failures (URLs never sent to Firecrawl)
--   2. poll-chunk fan-in: page-level failures (submitted to Firecrawl but not returned usable)
-- Reset to NULL at the start of each new crawl-fanout run.

ALTER TABLE geo_sites ADD COLUMN crawl_failed_urls jsonb;
