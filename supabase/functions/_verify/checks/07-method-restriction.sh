#!/usr/bin/env bash
# 07-method-restriction.sh — GET on track-collect must return 405 (POST/OPTIONS only).
# Spec: sec-verify #7.
# Exit: 0 pass, 1 fail, 2 skip
set -u

DESC="GET /functions/v1/track-collect → 405 (method not allowed)"

if [ -z "${SUPABASE_URL:-}" ]; then
  echo "SKIP: $DESC — set SUPABASE_URL"
  exit 2
fi

URL="$SUPABASE_URL/functions/v1/track-collect"
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" -X GET "$URL" || echo "000")

if [ "$STATUS" != "405" ]; then
  echo "FAIL: $DESC — got status $STATUS, expected 405"
  exit 1
fi

echo "PASS: $DESC"
exit 0
