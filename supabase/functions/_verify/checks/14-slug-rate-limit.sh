#!/usr/bin/env bash
# 14-slug-rate-limit.sh — 110 GET to /functions/v1/track-slug/<slug> from same IP in 60s.
# Last 10 must return 429. New rate limit added by migration. Spec: sec-verify #14.
# Exit: 0 pass, 1 fail, 2 skip
set -u

DESC="track-slug rate limit: 110 hits/min → last 10 return 429"

if [ -z "${SUPABASE_URL:-}" ]; then
  echo "SKIP: $DESC — set SUPABASE_URL"
  exit 2
fi

SLUG="${TEST_SLUG:-verify-test}"
URL="$SUPABASE_URL/functions/v1/track-slug/$SLUG"

# Probe slug existence first to disambiguate 404 vs 429.
PROBE=$(curl -sS -o /dev/null -w "%{http_code}" "$URL" || echo "000")
if [ "$PROBE" = "404" ]; then
  echo "SKIP: $DESC — slug '$SLUG' not in geo_sites; set TEST_SLUG to a valid slug"
  exit 2
fi

# Fire 110 requests serially (parallelism would muddle the count vs window).
status_counts=$(mktemp)
trap 'rm -f "$status_counts"' EXIT

for i in $(seq 1 110); do
  curl -sS -o /dev/null -w "%{http_code}\n" \
    -A "Mozilla/5.0 (Verify-Harness/14)" \
    "$URL" >> "$status_counts" || true
done

NUM_429=$(grep -c '^429$' "$status_counts" || true)
NUM_2XX=$(grep -cE '^(200|204|301|302|304)$' "$status_counts" || true)

if [ "$NUM_429" -lt 10 ]; then
  echo "Status breakdown:"
  sort "$status_counts" | uniq -c
  echo "FAIL: $DESC — expected ≥10 429s, got $NUM_429"
  exit 1
fi

if [ "$NUM_2XX" -lt 50 ]; then
  echo "Status breakdown:"
  sort "$status_counts" | uniq -c
  echo "FAIL: $DESC — too few successful hits ($NUM_2XX); rate limit may be over-aggressive"
  exit 1
fi

echo "Status breakdown:"
sort "$status_counts" | uniq -c
echo "PASS: $DESC ($NUM_429 of 110 were 429)"
exit 0
