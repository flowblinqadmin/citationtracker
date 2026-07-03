#!/usr/bin/env bash
# 18-ip-hash-written.sh — after firing a beacon, the most recent row's ip_hash must be
# non-null and exactly 64 hex chars (HMAC-SHA256). Raw ip column remains populated (additive).
# Spec: sec-verify #18.
# Exit: 0 pass, 1 fail, 2 skip
set -u

DESC="ip_hash written: 64 hex chars, non-null, raw ip preserved"

if [ -z "${SUPABASE_URL:-}" ] || [ -z "${SUPABASE_DB_URL:-}" ]; then
  echo "SKIP: $DESC — set SUPABASE_URL and SUPABASE_DB_URL"
  exit 2
fi
if ! command -v psql >/dev/null 2>&1; then
  echo "SKIP: $DESC — psql not on PATH"
  exit 2
fi

URL="$SUPABASE_URL/functions/v1/track-collect"
TEST_TAG="_verify-harness-18-$(date +%s)-$$"

# Use unique IP so we don't collide with rate limits from earlier checks.
UNIQ_IP="10.$((RANDOM % 250)).$((RANDOM % 250)).$((RANDOM % 250))"

# Both "s" (slug — required by handler validator) and "sid" (session_id —
# what the post-insert SELECT keys on) tagged with $TEST_TAG.
PAYLOAD="{\"s\":\"$TEST_TAG\",\"sid\":\"$TEST_TAG\",\"u\":\"https://a.b\"}"

STATUS=$(printf '%s' "$PAYLOAD" | curl -sS -o /dev/null -w "%{http_code}" \
  -X POST "$URL" \
  -H "Origin: https://geo.flowblinq.com" \
  -H "Content-Type: application/json" \
  -H "X-Forwarded-For: $UNIQ_IP" \
  --data-binary @- || echo "000")

if [ "$STATUS" != "204" ] && [ "$STATUS" != "200" ]; then
  echo "FAIL: $DESC — beacon POST got $STATUS"
  exit 1
fi

sleep 1

ROW=$(psql "$SUPABASE_DB_URL" -t -A -F'|' -c \
  "SELECT COALESCE(ip_hash,'NULL'), COALESCE(ip::text,'NULL') FROM geo_page_views WHERE session_id = '$TEST_TAG' ORDER BY viewed_at DESC LIMIT 1;" 2>/dev/null || echo "")

if [ -z "$ROW" ]; then
  echo "FAIL: $DESC — no row inserted for session_id=$TEST_TAG"
  exit 1
fi

IP_HASH="${ROW%%|*}"
IP_RAW="${ROW##*|}"

if [ "$IP_HASH" = "NULL" ]; then
  echo "FAIL: $DESC — ip_hash is NULL (HMAC not being written)"
  exit 1
fi

# Match exactly 64 lowercase hex chars.
if ! echo "$IP_HASH" | grep -qE '^[0-9a-f]{64}$'; then
  echo "ip_hash value: $IP_HASH"
  echo "FAIL: $DESC — ip_hash not 64 lowercase hex chars"
  exit 1
fi

# Raw IP must still be present (additive column).
if [ "$IP_RAW" = "NULL" ] || [ -z "$IP_RAW" ]; then
  echo "FAIL: $DESC — raw ip column was emptied (should remain populated)"
  exit 1
fi

echo "PASS: $DESC"
exit 0
