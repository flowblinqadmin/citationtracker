#!/usr/bin/env bash
# scripts/ops/clean-vercel-env.sh — ES-wave-6 §D1 AC-D1-1
#
# Removes literal "\n" corruption from quoted prod env values introduced by
# `echo "..." | vercel env add ...` (echo's trailing newline gets captured
# inside the quoted value, breaking parsers downstream).
#
# REQUIRES OPERATOR APPROVAL — review before running. Does NOT run
# automatically. Prompts before each `vercel env rm`. Run from a shell with
# the Vercel CLI authenticated (`vercel login`).
#
# Brief deploy gap during the rm window: run rm + add in tight succession.
# Hold off on triggering deploys during the operation.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

echo "===================================================="
echo "  Vercel env corruption clean — ES-wave-6 §D1"
echo "===================================================="
echo
echo "REQUIRES OPERATOR APPROVAL — review before running."
echo
echo "This script will:"
echo "  1. Pull current prod env into a tmp file."
echo "  2. Detect quoted values whose content ends with literal \\n."
echo "  3. For each corrupt key: vercel env rm + printf-piped vercel env add."
echo "  4. Re-pull + verify the corruption is cleared."
echo "  5. Prompt before the final 'vercel --prod' redeploy."
echo
read -r -p "Confirm? [y/N] " ack
case "${ack,,}" in
  y|yes) ;;
  *) echo "[abort] Operator did not confirm — exiting."; exit 1 ;;
esac

if ! command -v vercel >/dev/null 2>&1; then
  echo "[abort] vercel CLI not found in PATH" >&2
  exit 2
fi

TMP_PRE="$(mktemp -t vercel-env-pre.XXXXXX)"
TMP_POST="$(mktemp -t vercel-env-post.XXXXXX)"
trap 'rm -f "$TMP_PRE" "$TMP_POST"' EXIT

echo
echo "[1/5] Pulling production env..."
vercel env pull "$TMP_PRE" --environment=production

echo
echo "[2/5] Scanning for quoted values ending in literal \\n..."
# Match KEY="...\n" (literal \n inside quotes, not a newline).
mapfile -t CORRUPT_KEYS < <(awk -F= '/^[A-Z][A-Z0-9_]*="/ && /\\n"$/ {print $1}' "$TMP_PRE")

if [ ${#CORRUPT_KEYS[@]} -eq 0 ]; then
  echo "[ok] No corrupt keys found — D1 already clean. Exiting."
  exit 0
fi

echo "Detected corrupt keys:"
for k in "${CORRUPT_KEYS[@]}"; do
  echo "  - $k"
done

echo
read -r -p "Proceed with rm + re-add for the ${#CORRUPT_KEYS[@]} key(s) above? [y/N] " ack
case "${ack,,}" in
  y|yes) ;;
  *) echo "[abort] Operator did not confirm — exiting."; exit 1 ;;
esac

echo
echo "[3/5] Removing + re-adding each corrupt key..."
for k in "${CORRUPT_KEYS[@]}"; do
  RAW=$(grep "^${k}=" "$TMP_PRE" | head -1 | cut -d= -f2-)
  # Strip leading + trailing quote, then strip trailing literal \n.
  CLEAN=${RAW#\"}
  CLEAN=${CLEAN%\"}
  CLEAN=${CLEAN%\\n}
  echo "  · ${k}: cleaned length=${#CLEAN}"   # length only, never the value
  vercel env rm "$k" production --yes
  printf '%s' "$CLEAN" | vercel env add "$k" production
done

echo
echo "[4/5] Verifying post-state..."
vercel env pull "$TMP_POST" --environment=production
mapfile -t REMAINING < <(awk -F= '/^[A-Z][A-Z0-9_]*="/ && /\\n"$/ {print $1}' "$TMP_POST")
if [ ${#REMAINING[@]} -gt 0 ]; then
  echo "[fail] Corruption still present in: ${REMAINING[*]}" >&2
  exit 3
fi
echo "[ok] No corrupt keys remain."

echo
read -r -p "[5/5] Trigger 'vercel --prod' redeploy now? [y/N] " ack
case "${ack,,}" in
  y|yes) vercel --prod ;;
  *) echo "[skip] Redeploy not triggered — operator will do it manually." ;;
esac

echo
echo "Done."
