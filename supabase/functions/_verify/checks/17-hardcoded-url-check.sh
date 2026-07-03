#!/usr/bin/env bash
# 17-hardcoded-url-check.sh — emitted beacon JS must NOT contain
# "geo.flowblinq.com/api/t/collect". It must reference the env-templated PUBLIC_COLLECT_URL.
# Spec: sec-verify #17.
# Exit: 0 pass, 1 fail, 2 skip
set -u

DESC="Emitted JS: no hardcoded geo.flowblinq.com/api/t/collect"

if [ -z "${SUPABASE_URL:-}" ]; then
  echo "SKIP: $DESC — set SUPABASE_URL"
  exit 2
fi

SLUG="${TEST_SLUG:-verify-test}"
URL="$SUPABASE_URL/functions/v1/track-slug/$SLUG"

# Use a unique IP so we don't collide with rate limits set by earlier checks
# (slug-serve rate limit is 100/min/IP; check 14 fires 110 hits as one IP).
UNIQ_IP="10.$((RANDOM % 250)).$((RANDOM % 250)).$((RANDOM % 250))"

# Bot UA returns the script body (vs pixel/redirect for visitor UA).
# Capture HTTP status as well so we surface 429/500/etc. instead of swallowing.
RESP=$(curl -sS -A "Mozilla/5.0 (compatible; ChatGPT-User/1.0)" \
  -H "X-Forwarded-For: $UNIQ_IP" \
  -w "\nHTTPSTATUS:%{http_code}" "$URL" 2>/dev/null || echo "")
BODY=$(echo "$RESP" | sed -e 's/HTTPSTATUS\:.*//')
STATUS=$(echo "$RESP" | tr -d '\n' | sed -e 's/.*HTTPSTATUS://')

if [ "$STATUS" != "200" ]; then
  echo "FAIL: $DESC — got HTTP $STATUS from $URL (expected 200; body: $(echo "$BODY" | head -c 200))"
  exit 1
fi

if [ -z "$BODY" ]; then
  echo "FAIL: $DESC — empty body from $URL"
  exit 1
fi

# (1) Hard ban on the literal Vercel URL.
if echo "$BODY" | grep -qF "geo.flowblinq.com/api/t/collect"; then
  echo "Offending substring found. First 400 chars of body:"
  echo "$BODY" | head -c 400
  echo ""
  echo "FAIL: $DESC — emitted beacon JS still hardcodes geo.flowblinq.com/api/t/collect"
  exit 1
fi

# (2) Spot-check the URL is templated to something sensible — either the Supabase URL or a
# host containing "track-collect" or "supabase".
if ! echo "$BODY" | grep -qE 'track-collect|supabase\.co'; then
  # Don't fail outright — PUBLIC_COLLECT_URL might be a CNAME. Print a warning instead.
  echo "WARN: emitted JS doesn't obviously reference track-collect/supabase. Confirm PUBLIC_COLLECT_URL is set correctly."
fi

echo "PASS: $DESC"
exit 0
