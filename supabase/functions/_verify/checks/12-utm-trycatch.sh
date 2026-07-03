#!/usr/bin/env bash
# 12-utm-trycatch.sh — malformed u: "not a url" must not 500; row inserts with utm_* NULL.
# Spec: sec-verify #12.
# Exit: 0 pass, 1 fail, 2 skip
set -u

DESC="UTM try/catch: malformed u='not a url' → row inserted, no 500, utm_* null"

if [ -z "${SUPABASE_URL:-}" ] || [ -z "${SUPABASE_DB_URL:-}" ]; then
  echo "SKIP: $DESC — set SUPABASE_URL and SUPABASE_DB_URL"
  exit 2
fi
if ! command -v psql >/dev/null 2>&1; then
  echo "SKIP: $DESC — psql not on PATH"
  exit 2
fi

URL="$SUPABASE_URL/functions/v1/track-collect"
TEST_TAG="_verify-harness-12-$(date +%s)-$$"

PAYLOAD="{\"s\":\"$TEST_TAG\",\"sid\":\"$TEST_TAG\",\"u\":\"not a url\"}"

STATUS=$(printf '%s' "$PAYLOAD" | curl -sS -o /dev/null -w "%{http_code}" \
  -X POST "$URL" \
  -H "Origin: https://geo.flowblinq.com" \
  -H "Content-Type: application/json" \
  --data-binary @- || echo "000")

# A 500 means utm parse exploded — fail.
if [ "$STATUS" = "500" ]; then
  echo "FAIL: $DESC — beacon returned 500 (utm parse blew up)"
  exit 1
fi

if [ "$STATUS" != "204" ] && [ "$STATUS" != "200" ]; then
  echo "FAIL: $DESC — beacon got $STATUS, expected 204/200 (graceful)"
  exit 1
fi

sleep 1

# All utm_* columns should be NULL. Schema has only utm_source/medium/campaign.
UTMS=$(psql "$SUPABASE_DB_URL" -t -A -F'|' -c \
  "SELECT COALESCE(utm_source,'NULL'), COALESCE(utm_medium,'NULL'), COALESCE(utm_campaign,'NULL') FROM geo_page_views WHERE session_id = '$TEST_TAG' ORDER BY viewed_at DESC LIMIT 1;" 2>/dev/null || echo "")

if [ -z "$UTMS" ]; then
  echo "FAIL: $DESC — no row inserted for session_id=$TEST_TAG"
  exit 1
fi

# Expected: NULL|NULL|NULL
if [ "$UTMS" != "NULL|NULL|NULL" ]; then
  echo "Row utm_*: $UTMS"
  echo "FAIL: $DESC — utm columns not all NULL"
  exit 1
fi

echo "PASS: $DESC"
exit 0
