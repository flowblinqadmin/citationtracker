#!/usr/bin/env bash
# 09-flat-object-guard.sh — nested props must coerce event_props to NULL (handler returns 204
# and inserts the row but discards props). Spec: sec-verify #9.
# Exit: 0 pass, 1 fail, 2 skip
set -u

DESC="Flat-object guard: nested props.nested.{a:1} → row.event_props = null"

if [ -z "${SUPABASE_URL:-}" ] || [ -z "${SUPABASE_DB_URL:-}" ]; then
  echo "SKIP: $DESC — set SUPABASE_URL and SUPABASE_DB_URL"
  exit 2
fi
if ! command -v psql >/dev/null 2>&1; then
  echo "SKIP: $DESC — psql not on PATH"
  exit 2
fi

URL="$SUPABASE_URL/functions/v1/track-collect"
TEST_TAG="_verify-harness-09-$(date +%s)-$$"

PAYLOAD=$(cat <<EOF
{"s":"$TEST_TAG","sid":"$TEST_TAG","u":"https://a.b","props":{"nested":{"a":1},"test_run":"_verify-harness"}}
EOF
)

STATUS=$(printf '%s' "$PAYLOAD" | curl -sS -o /dev/null -w "%{http_code}" \
  -X POST "$URL" \
  -H "Origin: https://geo.flowblinq.com" \
  -H "Content-Type: application/json" \
  --data-binary @- || echo "000")

if [ "$STATUS" != "204" ] && [ "$STATUS" != "200" ]; then
  echo "FAIL: $DESC — beacon POST got $STATUS, expected 204/200"
  exit 1
fi

# Allow async insert to settle.
sleep 1

# Query: most recent row for this session_id should have NULL event_props.
ROW=$(psql "$SUPABASE_DB_URL" -t -A -c \
  "SELECT COALESCE(event_props::text,'NULL') FROM geo_page_views WHERE session_id = '$TEST_TAG' ORDER BY viewed_at DESC LIMIT 1;" 2>/dev/null || echo "")

if [ -z "$ROW" ]; then
  echo "FAIL: $DESC — no row inserted for session_id=$TEST_TAG"
  exit 1
fi

if [ "$ROW" != "NULL" ]; then
  echo "Row event_props: $ROW"
  echo "FAIL: $DESC — nested props were NOT coerced to NULL"
  exit 1
fi

echo "PASS: $DESC"
exit 0
