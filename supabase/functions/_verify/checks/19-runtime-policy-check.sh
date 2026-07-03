#!/usr/bin/env bash
# 19-runtime-policy-check.sh — run `node scripts/check-runtime-policy.ts`. Script doesn't
# exist until build agent's commit #14; SKIP until then. Spec: sec-verify #19.
# Exit: 0 pass, 1 fail, 2 skip
set -u

DESC="check-runtime-policy.ts exits 0 (every route classified)"

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="${REPO_ROOT:-$( cd "$SCRIPT_DIR/../../../.." && pwd )}"

POLICY_SCRIPT="$REPO_ROOT/scripts/check-runtime-policy.ts"

if [ ! -f "$POLICY_SCRIPT" ]; then
  echo "SKIP: $DESC — $POLICY_SCRIPT not present (commit #14 not yet landed)"
  exit 2
fi

if ! command -v node >/dev/null 2>&1; then
  echo "SKIP: $DESC — node not on PATH"
  exit 2
fi

# Run from repo root so relative paths inside the script resolve correctly.
OUT=$(cd "$REPO_ROOT" && node --no-warnings "$POLICY_SCRIPT" 2>&1)
RC=$?

if [ "$RC" -ne 0 ]; then
  echo "$OUT"
  echo "FAIL: $DESC — check-runtime-policy.ts exited $RC"
  exit 1
fi

echo "PASS: $DESC"
exit 0
