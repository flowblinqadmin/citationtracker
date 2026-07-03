#!/usr/bin/env bash
# 06-log-pii-scan.sh — static scan: ensure no `console.log` writes raw IP or full UA at
# info level. Only `console.warn`/`console.error` may include `key=${ip}` and only on block
# events. Spec: sec-verify #6.
# Exit: 0 pass, 1 fail, 2 skip
set -u

DESC="No raw IP or full UA in console.log (info-level) statements"

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="${REPO_ROOT:-$( cd "$SCRIPT_DIR/../../../.." && pwd )}"

COLLECT_DIR="$REPO_ROOT/supabase/functions/track-collect"
SLUG_DIR="$REPO_ROOT/supabase/functions/track-slug"
SHARED_DIR="$REPO_ROOT/supabase/functions/_shared"

if [ ! -d "$COLLECT_DIR" ] || [ ! -d "$SLUG_DIR" ] || [ ! -d "$SHARED_DIR" ]; then
  echo "SKIP: $DESC — build agent hasn't created beacon source yet"
  exit 2
fi

# Grep for console.log occurrences referencing ip/user-agent identifiers we know about.
# Patterns we flag: console.log + (ip|userAgent|user-agent|x-forwarded-for|UA|ua) on same line.
HITS=$(grep -RIn -E 'console\.(log|info)\b[^;]{0,200}(ip\b|userAgent|user-agent|x-forwarded-for|\bua\b|\bUA\b|client_ip)' \
  "$COLLECT_DIR" "$SLUG_DIR" "$SHARED_DIR" 2>/dev/null || true)

if [ -n "$HITS" ]; then
  echo "Offending lines:"
  echo "$HITS"
  echo "FAIL: $DESC — console.log/console.info writes raw IP or UA"
  exit 1
fi

echo "PASS: $DESC"
exit 0
