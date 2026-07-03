-- check_rate_limit(p_key text, p_limit int, p_window_ms int) RETURNS jsonb
--
-- Atomic DB-backed rate limiter callable from Vercel Edge (no TCP) via
-- supabase-js .rpc(). Mirrors the CASE-based upsert in lib/rate-limit.ts
-- so the semantics match exactly between Edge and Node call sites:
--   - Insert a new row at count=1 with resetAt = now + window
--   - On conflict on `key`: if existing resetAt is in the past, RESET to
--     count=1 with a fresh window; otherwise increment count and keep the
--     existing window.
--   - Return the post-write count and resetAt.
--
-- Apply path (no Drizzle generator for Postgres functions):
--   psql "$SUPABASE_DATABASE_URL" -f lib/db/rpc/check_rate_limit.sql
-- The function is idempotent (CREATE OR REPLACE), safe to re-run.

CREATE OR REPLACE FUNCTION public.check_rate_limit(
  p_key       text,
  p_limit     int,
  p_window_ms int
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_now      timestamptz := now();
  v_reset    timestamptz := v_now + make_interval(secs => p_window_ms / 1000.0);
  v_count    integer;
  v_reset_at timestamptz;
BEGIN
  INSERT INTO public.rate_limits (key, count, reset_at)
  VALUES (p_key, 1, v_reset)
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

  RETURN jsonb_build_object(
    'allowed',   v_count <= p_limit,
    'remaining', GREATEST(0, p_limit - v_count),
    'resetAt',   v_reset_at
  );
END;
$$;

-- Allow the anon + service_role roles to call this. The beacon Edge function
-- uses the service_role key (bypasses RLS on rate_limits anyway), but anon
-- is granted defensively in case a future caller is non-service.
GRANT EXECUTE ON FUNCTION public.check_rate_limit(text, int, int) TO anon, authenticated, service_role;
