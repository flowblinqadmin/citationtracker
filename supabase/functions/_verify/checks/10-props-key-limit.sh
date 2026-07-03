#!/usr/bin/env bash
# 10-props-key-limit.sh — props with 51 keys must coerce event_props to NULL.
# Spec: sec-verify #10. Limit is "≤50 scalar keys".
# Exit: 0 pass, 1 fail, 2 skip
set -u

DESC="Props key limit: 51 scalar keys → event_props = null"

if [ -z "${SUPABASE_URL:-}" ] || [ -z "${SUPABASE_DB_URL:-}" ]; then
  echo "SKIP: $DESC — set SUPABASE_URL and SUPABASE_DB_URL"
  exit 2
fi
if ! command -v psql >/dev/null 2>&1; then
  echo "SKIP: $DESC — psql not on PATH"
  exit 2
fi

URL="$SUPABASE_URL/functions/v1/track-collect"
TEST_TAG="_verify-harness-10-$(date +%s)-$$"

# Build a JSON object with 51 keys (k0..k50).
KEYS=""
for i in $(seq 0 50); do
  if [ "$i" -gt 0 ]; then KEYS="$KEYS,"; fi
  KEYS="$KEYS\"k$i\":$i"
done
PAYLOAD="{\"s\":\"$TEST_TAG\",\"sid\":\"$TEST_TAG\",\"u\":\"https://a.b\",\"props\":{$KEYS}}"

STATUS=$(printf '%s' "$PAYLOAD" | curl -sS -o /dev/null -w "%{http_code}" \
  -X POST "$URL" \
  -H "Origin: https://geo.flowblinq.com" \
  -H "Content-Type: application/json" \
  --data-binary @- || echo "000")

if [ "$STATUS" != "204" ] && [ "$STATUS" != "200" ]; then
  echo "FAIL: $DESC — beacon POST got $STATUS, expected 204/200"
  exit 1
fi

sleep 1

ROW=$(psql "$SUPABASE_DB_URL" -t -A -c \
  "SELECT COALESCE(event_props::text,'NULL') FROM geo_page_views WHERE session_id = '$TEST_TAG' ORDER BY viewed_at DESC LIMIT 1;" 2>/dev/null || echo "")

if [ -z "$ROW" ]; then
  echo "FAIL: $DESC — no row inserted for session_id=$TEST_TAG"
  exit 1
fi

if [ "$ROW" != "NULL" ]; then
  echo "Row event_props (truncated): $(echo "$ROW" | head -c 200)"
  echo "FAIL: $DESC — 51-key props were NOT coerced to NULL"
  exit 1
fi

echo "PASS: $DESC"
exit 0
