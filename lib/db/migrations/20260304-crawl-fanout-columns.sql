-- ES-023: Crawl fan-out/fan-in coordination columns
-- These 4 columns track the parallel chunk execution state for the new
-- crawl-fanout → poll-chunk → merge-crawl QStash pipeline.

ALTER TABLE geo_sites ADD COLUMN crawl_chunks_total  integer;
ALTER TABLE geo_sites ADD COLUMN crawl_chunks_done   integer;
ALTER TABLE geo_sites ADD COLUMN crawl_chunk_results jsonb;
ALTER TABLE geo_sites ADD COLUMN crawl_started_at    timestamp;
