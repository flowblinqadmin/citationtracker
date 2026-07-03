-- ES-045: Per-Page Fixes, Re-Audit Tracking, and Implementation Status
ALTER TABLE geo_sites ADD COLUMN IF NOT EXISTS per_page_fixes jsonb;
ALTER TABLE geo_sites ADD COLUMN IF NOT EXISTS previous_per_page_fixes jsonb;
ALTER TABLE geo_sites ADD COLUMN IF NOT EXISTS implementation_status jsonb;
