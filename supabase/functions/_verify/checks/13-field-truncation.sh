#!/usr/bin/env bash
# 13-field-truncation.sh — POST with pageUrl of 5000 chars → stored value is exactly 2048.
# Spec: sec-verify #13. Field cap is `.slice(2048)` on pageUrl/referrer in current Vercel handler.
# Exit: 0 pass, 1 fail, 2 skip
set -u

DESC="Field truncation: pageUrl 5000 chars → stored 2048"

if [ -z "${SUPABASE_URL:-}" ] || [ -z "${SUPABASE_DB_URL:-}" ]; then
  echo "SKIP: $DESC — set SUPABASE_URL and SUPABASE_DB_URL"
  exit 2
fi
if ! command -v psql >/dev/null 2>&1; then
  echo "SKIP: $DESC — psql not on PATH"
  exit 2
fi

URL="$SUPABASE_URL/functions/v1/track-collect"
TEST_TAG="_verify-harness-13-$(date +%s)-$$"

# Build a valid URL whose total length is 5000 chars: https://a.b/?p=<a*4985>
FILLER=$(printf 'a%.0s' $(seq 1 4985))
LONG_URL="https://a.b/?p=$FILLER"

PAYLOAD=$(cat <<EOF
{"s":"$TEST_TAG","sid":"$TEST_TAG","u":"$LONG_URL"}
EOF
)

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

LEN=$(psql "$SUPABASE_DB_URL" -t -A -c \
  "SELECT char_length(page_url) FROM geo_page_views WHERE session_id = '$TEST_TAG' ORDER BY viewed_at DESC LIMIT 1;" 2>/dev/null || echo "")

if [ -z "$LEN" ]; then
  echo "FAIL: $DESC — no row inserted"
  exit 1
fi

if [ "$LEN" != "2048" ]; then
  echo "Stored page_url length: $LEN"
  echo "FAIL: $DESC — expected 2048, got $LEN"
  exit 1
fi

echo "PASS: $DESC"
exit 0
