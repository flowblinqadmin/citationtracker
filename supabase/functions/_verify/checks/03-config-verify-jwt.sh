#!/usr/bin/env bash
# 03-config-verify-jwt.sh — assert supabase/config.toml has verify_jwt = false ONLY for
# track-collect and track-slug. Spec: sec-verify #3.
# Exit: 0 pass, 1 fail, 2 skip
set -u

DESC="config.toml has verify_jwt=false ONLY for track-collect and track-slug"

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="${REPO_ROOT:-$( cd "$SCRIPT_DIR/../../../.." && pwd )}"
CONFIG="$REPO_ROOT/supabase/config.toml"

if [ ! -f "$CONFIG" ]; then
  echo "SKIP: $DESC — $CONFIG not found"
  exit 2
fi

# Both required blocks must declare verify_jwt = false.
required_blocks=("functions.track-collect" "functions.track-slug")
missing_blocks=()
for blk in "${required_blocks[@]}"; do
  if ! grep -qE "^\[$blk\]" "$CONFIG"; then
    missing_blocks+=("$blk")
  fi
done

# If both blocks are missing, the build agent hasn't shipped commit #1 yet — SKIP.
if [ "${#missing_blocks[@]}" -eq "${#required_blocks[@]}" ]; then
  echo "SKIP: $DESC — build agent's config.toml entries (commit #1) not landed yet"
  exit 2
fi

# Partial state = real failure (build agent shipped one block, not both).
if [ "${#missing_blocks[@]}" -gt 0 ]; then
  echo "FAIL: $DESC — missing [${missing_blocks[*]}] block(s) in config.toml"
  exit 1
fi

for blk in "${required_blocks[@]}"; do
  # Look inside the section for verify_jwt = false. Bounded by the next [section] or EOF.
  block_body=$(awk -v sect="[$blk]" '
    $0 == sect { in_blk=1; next }
    /^\[/ { in_blk=0 }
    in_blk { print }
  ' "$CONFIG")
  if ! echo "$block_body" | grep -qE '^[[:space:]]*verify_jwt[[:space:]]*=[[:space:]]*false[[:space:]]*$'; then
    echo "[$blk] block contents:"
    echo "$block_body"
    echo "FAIL: $DESC — [$blk] does not declare verify_jwt = false"
    exit 1
  fi
done

# Make sure no OTHER function block declares verify_jwt = false (only beacon should be public).
other_false=$(awk '
  /^\[functions\./ {
    name=$0
    sub(/^\[functions\./, "", name)
    sub(/\].*$/, "", name)
    in_blk=1
    cur=name
    next
  }
  /^\[/ { in_blk=0 }
  in_blk && /^[[:space:]]*verify_jwt[[:space:]]*=[[:space:]]*false/ {
    if (cur != "track-collect" && cur != "track-slug") print cur
  }
' "$CONFIG")

if [ -n "$other_false" ]; then
  echo "Other functions declaring verify_jwt = false:"
  echo "$other_false"
  echo "FAIL: $DESC — additional functions are also public"
  exit 1
fi

echo "PASS: $DESC"
exit 0
