-- collect_pageview(p_rate_key, p_rate_limit, p_window_ms, p_row) RETURNS jsonb
--
-- Combined atomic rate-limit + geo_page_views insert for the Edge beacon
-- hot path (app/api/t/collect). Replaces two HTTPS round-trips per beacon
-- (check_rate_limit RPC + .from(...).insert(...)) with a single RPC.
--
-- Semantics:
--   - Atomic rate-limit increment with the same windowed-bucket logic as
--     check_rate_limit (kept for non-beacon callers).
--   - If allowed, insert the supplied row into geo_page_views.
--   - On insert PK collision (vanishingly rare with nanoid), ON CONFLICT
--     DO NOTHING — the beacon route does NOT retry; collisions are
--     statistically impossible at our volume and a missed pageview is
--     append-only telemetry, not a security boundary.
--
-- Apply path (idempotent CREATE OR REPLACE):
--   SUPABASE_DATABASE_URL=postgres://... node scripts/apply-rpcs.mjs

CREATE OR REPLACE FUNCTION public.collect_pageview(
  p_rate_key   text,
  p_rate_limit int,
  p_window_ms  int,
  p_row        jsonb
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_now      timestamptz := now();
  v_reset    timestamptz := v_now + make_interval(secs => p_window_ms / 1000.0);
  v_count    integer;
  v_reset_at timestamptz;
  v_allowed  boolean;
  v_inserted boolean := false;
BEGIN
  INSERT INTO public.rate_limits (key, count, reset_at)
  VALUES (p_rate_key, 1, v_reset)
  ON CONFLICT (key) DO UPDATE
  SET
    count    = CASE WHEN public.rate_limits.reset_at < v_now
                    THEN 1
                    ELSE public.rate_limits.count + 1
               END,
    reset_at = CASE WHEN public.rate_limits.reset_at < v_now
                    THEN v_reset
                    ELSE public.rate_limits.reset_at
               END
  RETURNING count, reset_at INTO v_count, v_reset_at;

  v_allowed := v_count <= p_rate_limit;

  IF v_allowed THEN
    BEGIN
      INSERT INTO public.geo_page_views (
        id, slug, page_url, referrer, visitor_id, user_agent, bot_name,
        ip, ip_hash, country, screen_width, website_deploy_id, viewed_at,
        utm_source, utm_medium, utm_campaign, city, region,
        session_id, time_on_page_ms, type, event_name, event_props
      )
      VALUES (
        p_row->>'id',
        p_row->>'slug',
        p_row->>'page_url',
        p_row->>'referrer',
        p_row->>'visitor_id',
        p_row->>'user_agent',
        p_row->>'bot_name',
        p_row->>'ip',
        p_row->>'ip_hash',
        p_row->>'country',
        NULLIF(p_row->>'screen_width', '')::int,
        p_row->>'website_deploy_id',
        COALESCE((p_row->>'viewed_at')::timestamptz, v_now),
        p_row->>'utm_source',
        p_row->>'utm_medium',
        p_row->>'utm_campaign',
        p_row->>'city',
        p_row->>'region',
        p_row->>'session_id',
        NULLIF(p_row->>'time_on_page_ms', '')::int,
        COALESCE(p_row->>'type', 'pageview'),
        p_row->>'event_name',
        p_row->'event_props'
      )
      ON CONFLICT (id) DO NOTHING;
      v_inserted := true;
    EXCEPTION WHEN OTHERS THEN
      v_inserted := false;
    END;
  END IF;

  RETURN jsonb_build_object(
    'allowed',   v_allowed,
    'remaining', GREATEST(0, p_rate_limit - v_count),
    'resetAt',   v_reset_at,
    'inserted',  v_inserted
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.collect_pageview(text, int, int, jsonb)
  TO anon, authenticated, service_role;
