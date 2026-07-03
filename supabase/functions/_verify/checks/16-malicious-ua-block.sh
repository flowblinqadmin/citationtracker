#!/usr/bin/env bash
# 16-malicious-ua-block.sh — GET /functions/v1/track-slug/X with sqlmap UA must return 403.
# Spec: sec-verify #16. UA-block list is Nikto/sqlmap/nmap/acunetix/wpscan.
# Exit: 0 pass, 1 fail, 2 skip
set -u

DESC="Malicious UA block: sqlmap UA on track-slug → 403"

if [ -z "${SUPABASE_URL:-}" ]; then
  echo "SKIP: $DESC — set SUPABASE_URL"
  exit 2
fi

SLUG="${TEST_SLUG:-verify-test}"
URL="$SUPABASE_URL/functions/v1/track-slug/$SLUG"

# Check at least one of the five UA strings is blocked. We test sqlmap as canonical case
# and also try Nikto in case test slug 404 short-circuits before UA-block.
# Per plan, malicious UA enforcement is on track-slug only (collect keeps current Vercel
# behavior of not UA-blocking).
for ua in "Mozilla/5.0 (sqlmap/1.0)" "Mozilla/5.0 (compatible; Nikto/2.1.6)"; do
  STATUS=$(curl -sS -o /dev/null -w "%{http_code}" -A "$ua" "$URL" || echo "000")
  if [ "$STATUS" = "403" ]; then
    echo "PASS: $DESC (UA '$ua' → 403)"
    exit 0
  fi
done

echo "FAIL: $DESC — neither sqlmap nor Nikto UA returned 403 from track-slug"
exit 1
