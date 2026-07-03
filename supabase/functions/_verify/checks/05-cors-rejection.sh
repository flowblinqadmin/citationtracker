#!/usr/bin/env bash
# 05-cors-rejection.sh — request from a non-allowlist origin returns Allow-Origin: *
# (or no allow-origin) and NO Allow-Credentials. The browser then refuses the credentialed
# response. Spec: sec-verify #5.
# Exit: 0 pass, 1 fail, 2 skip
set -u

DESC="CORS rejection: https://evil.example.com gets * (no credentials)"

if [ -z "${SUPABASE_URL:-}" ]; then
  echo "SKIP: $DESC — set SUPABASE_URL"
  exit 2
fi

URL="$SUPABASE_URL/functions/v1/track-collect"
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

curl -sS -o /dev/null -D "$TMP" \
  -X OPTIONS "$URL" \
  -H "Origin: https://evil.example.com" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type" || {
    echo "FAIL: $DESC — curl error reaching $URL"
    exit 1
  }

HEADERS=$(tr 'A-Z' 'a-z' < "$TMP")

# Two acceptable shapes: (a) Allow-Origin: * with no credentials, (b) Allow-Origin absent.
# Either way, Allow-Credentials must NOT be true.
if echo "$HEADERS" | grep -q "access-control-allow-credentials: true"; then
  echo "Response headers:"
  cat "$TMP"
  echo "FAIL: $DESC — credentials granted to disallowed origin"
  exit 1
fi

if echo "$HEADERS" | grep -q "access-control-allow-origin: https://evil.example.com"; then
  echo "Response headers:"
  cat "$TMP"
  echo "FAIL: $DESC — disallowed origin was echoed back"
  exit 1
fi

echo "PASS: $DESC"
exit 0
