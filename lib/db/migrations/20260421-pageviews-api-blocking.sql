-- ES-087 §1 module layout: api_clients blocking columns + composite index for page_views query.

ALTER TABLE api_clients
  ADD COLUMN IF NOT EXISTS consecutive_bad_requests INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ NULL;

-- Composite covering index for the hot page_views query path.
-- Pattern: WHERE slug = ? AND bot_name = 'visitor' ORDER BY viewed_at, id
CREATE INDEX IF NOT EXISTS geo_page_views_slug_bot_viewed_id_idx
  ON geo_page_views (slug, bot_name, viewed_at, id);
