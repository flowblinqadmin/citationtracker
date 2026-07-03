-- Migration: Add missing columns to geo_site_view
-- Columns present in Drizzle schema (lib/db/schema.ts) but absent from the
-- original CREATE TABLE in 001-geo-site-view.sql, causing the SELECT query
-- in app/sites/[id]/page.tsx to fail with a "column does not exist" error.

ALTER TABLE geo_site_view
  ADD COLUMN IF NOT EXISTS token_expires_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS user_competitors    JSONB,
  ADD COLUMN IF NOT EXISTS competitor_blocklist JSONB;

-- Backfill from geo_sites
UPDATE geo_site_view v
SET
  token_expires_at     = s.token_expires_at,
  user_competitors     = s.user_competitors,
  competitor_blocklist = s.competitor_blocklist
FROM geo_sites s
WHERE s.id = v.site_id;
