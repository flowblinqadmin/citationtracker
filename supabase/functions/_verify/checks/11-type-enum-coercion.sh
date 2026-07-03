#!/usr/bin/env bash
# 11-type-enum-coercion.sh — body.type other than "event" must coerce to "pageview".
# Spec: sec-verify #11. Tested with <script> as a hostile value.
# Exit: 0 pass, 1 fail, 2 skip
set -u

DESC="Type enum coercion: type='<script>' → row.type = 'pageview'"

if [ -z "${SUPABASE_URL:-}" ] || [ -z "${SUPABASE_DB_URL:-}" ]; then
  echo "SKIP: $DESC — set SUPABASE_URL and SUPABASE_DB_URL"
  exit 2
fi
if ! command -v psql >/dev/null 2>&1; then
  echo "SKIP: $DESC — psql not on PATH"
  exit 2
fi

URL="$SUPABASE_URL/functions/v1/track-collect"
TEST_TAG="_verify-harness-11-$(date +%s)-$$"

PAYLOAD="{\"s\":\"$TEST_TAG\",\"sid\":\"$TEST_TAG\",\"u\":\"https://a.b\",\"type\":\"<script>\"}"

STATUS=$(printf '%s' "$PAYLOAD" | curl -sS -o /dev/null -w "%{http_code}" \
  -X POST "$URL" \
  -H "Origin: https://geo.flowblinq.com" \
  -H "Content-Type: application/json" \
  --data-binary @- || echo "000")

if [ "$STATUS" != "204" ] && [ "$STATUS" != "200" ]; then
  echo "FAIL: $DESC — beacon POST got $STATUS"
  exit 1
fi

sleep 1

TYPE=$(psql "$SUPABASE_DB_URL" -t -A -c \
  "SELECT type FROM geo_page_views WHERE session_id = '$TEST_TAG' ORDER BY viewed_at DESC LIMIT 1;" 2>/dev/null || echo "")

if [ -z "$TYPE" ]; then
  echo "FAIL: $DESC — no row inserted"
  exit 1
fi

if [ "$TYPE" != "pageview" ]; then
  echo "Row type: $TYPE"
  echo "FAIL: $DESC — got type='$TYPE', expected 'pageview'"
  exit 1
fi

echo "PASS: $DESC"
exit 0
