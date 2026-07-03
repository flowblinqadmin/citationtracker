-- TS-017: Persist rate limiters to DB (issue #109)

-- Fix 1: OTP attempts on geoSites row
ALTER TABLE geo_sites
  ADD COLUMN IF NOT EXISTS otp_attempts    integer   NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS otp_locked_until timestamp;

-- Fix 2: IP rate limit table
CREATE TABLE IF NOT EXISTS rate_limits (
  key       text        PRIMARY KEY,
  count     integer     NOT NULL DEFAULT 0,
  reset_at  timestamp   NOT NULL
);
