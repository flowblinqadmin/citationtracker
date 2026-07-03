#!/usr/bin/env bash
# 01-no-service-role-source.sh — assert no SERVICE_ROLE reference in beacon source.
# Spec: sec-verify #1. grep -r "SERVICE_ROLE|SUPABASE_SERVICE_ROLE_KEY" supabase/functions/{track-collect,track-slug}/ returns nothing.
# Exit: 0 pass, 1 fail, 2 skip
set -u

DESC="No SERVICE_ROLE / SUPABASE_SERVICE_ROLE_KEY in track-collect/ or track-slug/ source"

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="${REPO_ROOT:-$( cd "$SCRIPT_DIR/../../../.." && pwd )}"

COLLECT_DIR="$REPO_ROOT/supabase/functions/track-collect"
SLUG_DIR="$REPO_ROOT/supabase/functions/track-slug"

if [ ! -d "$COLLECT_DIR" ] || [ ! -d "$SLUG_DIR" ]; then
  echo "SKIP: $DESC — build agent hasn't created track-collect/ or track-slug/ yet"
  exit 2
fi

# Look for either spelling. -I skips binaries. -n shows line numbers in any hit.
# Exclude *.test.ts — test files legitimately assert the *absence* of these strings
# via `assertEquals(code.includes("SUPABASE_SERVICE_ROLE_KEY"), false)` style guards.
HITS=$(grep -RIn --include='*.ts' --exclude='*.test.ts' -E 'SERVICE_ROLE|SUPABASE_SERVICE_ROLE_KEY' "$COLLECT_DIR" "$SLUG_DIR" 2>/dev/null || true)

if [ -n "$HITS" ]; then
  echo "Offending lines:"
  echo "$HITS"
  echo "FAIL: $DESC — service-role reference present in beacon source"
  exit 1
fi

echo "PASS: $DESC"
exit 0
