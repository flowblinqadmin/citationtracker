#!/usr/bin/env bash
# 04-cors-allowlist.sh — request from allowed origin with credentials must produce
# echoed origin + Allow-Credentials: true + Vary: Origin from the Edge Function.
# Spec: sec-verify #4.
#
# Local-vs-production gotcha: `supabase functions serve` puts Kong in front of the
# function, and Kong rewrites Access-Control-Allow-Origin from our echoed value back
# to `*`. Other CORS headers (Credentials, Vary, Methods) pass through untouched.
# Production Supabase Edge does not exhibit this Kong rewrite; the function's CORS
# response is preserved on the wire. When Kong is detected locally we SKIP this
# check and rely on the _deploy.md smoke test against the deployed function URL.
#
# Exit: 0 pass, 1 fail, 2 skip
set -u

DESC="CORS allowlist: https://geo.flowblinq.com gets echoed + credentials + Vary"

if [ -z "${SUPABASE_URL:-}" ]; then
  echo "SKIP: $DESC — set SUPABASE_URL"
  exit 2
fi

URL="$SUPABASE_URL/functions/v1/track-collect"
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

# Trigger CORS via POST (not OPTIONS) — Kong's CORS plugin only mangles the
# preflight response. The actual POST is round-tripped to the function and
# Kong leaves the function's CORS response mostly alone (except ACAO, which
# Kong overrides to `*` locally — handled below).
UNIQ_IP="10.$((RANDOM % 250)).$((RANDOM % 250)).$((RANDOM % 250))"
curl -sS -o /dev/null -D "$TMP" \
  -X POST "$URL" \
  -H "Origin: https://geo.flowblinq.com" \
  -H "Content-Type: application/json" \
  -H "X-Forwarded-For: $UNIQ_IP" \
  -d '{"s":"verify-cors-04","u":"https://a.b"}' || {
    echo "FAIL: $DESC — curl error reaching $URL"
    exit 1
  }

HEADERS=$(tr 'A-Z' 'a-z' < "$TMP")

# Detect Kong-in-front: local supabase functions serve runs behind Kong, which
# rewrites Access-Control-Allow-Origin to `*` regardless of upstream.
KONG_PRESENT=0
if echo "$HEADERS" | grep -qE 'via:.*kong|server:.*kong'; then
  KONG_PRESENT=1
fi

# Validate the headers the function controls regardless of Kong:
#   - Credentials must be set when origin is allowlisted
#   - Vary must include Origin so caches don't bleed
if ! echo "$HEADERS" | grep -q "access-control-allow-credentials: true"; then
  echo "Response headers:"
  cat "$TMP"
  echo "FAIL: $DESC — Access-Control-Allow-Credentials: true missing from function response"
  exit 1
fi

if ! echo "$HEADERS" | grep -q "vary:.*origin"; then
  echo "Response headers:"
  cat "$TMP"
  echo "FAIL: $DESC — Vary header missing Origin in function response"
  exit 1
fi

if echo "$HEADERS" | grep -q "access-control-allow-origin: https://geo.flowblinq.com"; then
  echo "PASS: $DESC"
  exit 0
fi

if [ "$KONG_PRESENT" = "1" ]; then
  echo "Response headers (Kong in front, locally rewrites ACAO to *):"
  cat "$TMP"
  echo "SKIP: $DESC — Kong gateway rewrote Access-Control-Allow-Origin to *."
  echo "       Function-side CORS (Credentials, Vary) is correct. Production"
  echo "       Supabase Edge preserves function CORS; verify with _deploy.md"
  echo "       smoke test against the deployed function URL before client flip."
  exit 2
fi

echo "Response headers:"
cat "$TMP"
echo "FAIL: $DESC — Access-Control-Allow-Origin did not echo allowed origin (no Kong detected)"
exit 1
