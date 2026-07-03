#!/usr/bin/env bash
# 15-collect-rate-limit-isolation.sh — rate-limit namespaces are independent.
# Concurrently with #14's 110 slug hits, fire 50 POSTs to track-collect from same IP;
# all 50 should succeed (key=beacon:<ip>, not key=slug-serve:<ip>).
# Spec: sec-verify #15.
# Exit: 0 pass, 1 fail, 2 skip
set -u

DESC="Rate-limit isolation: 50 POST to track-collect during slug-serve burst all succeed"

if [ -z "${SUPABASE_URL:-}" ]; then
  echo "SKIP: $DESC — set SUPABASE_URL"
  exit 2
fi

COLLECT_URL="$SUPABASE_URL/functions/v1/track-collect"
SLUG="${TEST_SLUG:-verify-test}"
SLUG_URL="$SUPABASE_URL/functions/v1/track-slug/$SLUG"
TEST_TAG="_verify-harness-15-$(date +%s)-$$"

# Probe slug.
PROBE=$(curl -sS -o /dev/null -w "%{http_code}" "$SLUG_URL" || echo "000")
if [ "$PROBE" = "404" ]; then
  echo "SKIP: $DESC — slug '$SLUG' not in geo_sites"
  exit 2
fi

# Saturate the slug namespace in background.
( for i in $(seq 1 110); do
    curl -sS -o /dev/null -A "Mozilla/5.0 (Verify-Harness/15-slug)" "$SLUG_URL" || true
  done ) &
SLUG_PID=$!

# Wait briefly so slug rate limit is hit, then fire 50 collect POSTs.
sleep 2

status_counts=$(mktemp)
trap 'rm -f "$status_counts"; kill "$SLUG_PID" 2>/dev/null || true; wait 2>/dev/null || true' EXIT

for i in $(seq 1 50); do
  PAYLOAD="{\"s\":\"$TEST_TAG-$i\",\"u\":\"https://a.b\"}"
  printf '%s' "$PAYLOAD" | curl -sS -o /dev/null -w "%{http_code}\n" \
    -X POST "$COLLECT_URL" \
    -H "Origin: https://geo.flowblinq.com" \
    -H "Content-Type: application/json" \
    --data-binary @- >> "$status_counts" || true
done

wait "$SLUG_PID" 2>/dev/null || true

NUM_OK=$(grep -cE '^(200|204)$' "$status_counts" || true)
NUM_429=$(grep -c '^429$' "$status_counts" || true)

if [ "$NUM_429" -gt 0 ]; then
  echo "Status breakdown:"
  sort "$status_counts" | uniq -c
  echo "FAIL: $DESC — collect POST got rate-limited ($NUM_429) while slug burst was active — keys not isolated"
  exit 1
fi

if [ "$NUM_OK" -lt 50 ]; then
  echo "Status breakdown:"
  sort "$status_counts" | uniq -c
  echo "FAIL: $DESC — only $NUM_OK of 50 collect POSTs succeeded"
  exit 1
fi

echo "PASS: $DESC ($NUM_OK of 50 ok, 0 throttled)"
exit 0
