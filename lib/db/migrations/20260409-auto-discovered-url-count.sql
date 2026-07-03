-- ES-083 AC-8: track auto-discovered brand-level URL count for bulk audits.
-- Informational only — does NOT count against bulk_url_count credit budget
-- per AC-6/AC-7. Operator-monitoring + dashboard badge consumer.

ALTER TABLE geo_sites
  ADD COLUMN IF NOT EXISTS auto_discovered_url_count integer;
