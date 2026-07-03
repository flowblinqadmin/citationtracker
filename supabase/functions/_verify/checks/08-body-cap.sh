#!/usr/bin/env bash
# 08-body-cap.sh — Content-Length > 8192 must return 413 BEFORE body parse.
# Spec: sec-verify #8.
# Exit: 0 pass, 1 fail, 2 skip
set -u

DESC="Body cap: Content-Length: 100000 → 413"

if [ -z "${SUPABASE_URL:-}" ]; then
  echo "SKIP: $DESC — set SUPABASE_URL"
  exit 2
fi

URL="$SUPABASE_URL/functions/v1/track-collect"

# Build a body that actually is ~100KB. Sending only the Content-Length header without a
# matching body would be rejected by curl's HTTP/1.1 client. So we craft a large JSON.
PAYLOAD=$(printf '{"s":"x","u":"https://a.b","filler":"%s"}' "$(head -c 99000 /dev/urandom | base64 | tr -d '\n' | head -c 99000)")

STATUS=$(printf '%s' "$PAYLOAD" | curl -sS -o /dev/null -w "%{http_code}" \
  -X POST "$URL" \
  -H "Origin: https://geo.flowblinq.com" \
  -H "Content-Type: application/json" \
  --data-binary @- || echo "000")

if [ "$STATUS" != "413" ]; then
  echo "FAIL: $DESC — got status $STATUS, expected 413"
  exit 1
fi

echo "PASS: $DESC"
exit 0
