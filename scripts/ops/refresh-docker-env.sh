#!/usr/bin/env bash
# scripts/ops/refresh-docker-env.sh — ES-wave-6 §D2 AC-D2-2
#
# Refreshes .env.docker from production. Pulls Vercel prod env, then patches
# .env.docker preserving local-only overrides + the cloudflared tunnel URL.
#
# Usage: from repo root, `bash scripts/ops/refresh-docker-env.sh`
#        or via npm: `npm run env:refresh-docker`

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

if [ "$(pwd)" != "$REPO_ROOT" ]; then
  echo "[abort] must run from repo root" >&2
  exit 1
fi

if ! command -v vercel >/dev/null 2>&1; then
  echo "[abort] vercel CLI not found in PATH" >&2
  exit 2
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "[abort] python3 not found in PATH" >&2
  exit 2
fi

VERCEL_DUMP="$REPO_ROOT/.env.vercel-prod"
TARGET="$REPO_ROOT/.env.docker"

echo "[1/3] Pulling production env into ${VERCEL_DUMP}..."
vercel env pull "$VERCEL_DUMP" --environment=production

if [ ! -f "$TARGET" ]; then
  echo "[abort] target ${TARGET} does not exist; create it first (copy from .env.docker.example)" >&2
  exit 3
fi

echo "[2/3] Patching ${TARGET} (preserving local-only keys + tunnel URL)..."
/home/aditya/miniconda3/bin/python3 "$REPO_ROOT/scripts/ops/patch-env-docker.py" "$VERCEL_DUMP" "$TARGET"

echo
echo "[3/3] Reminder:"
echo "  Restart the container with 'docker compose down && docker compose up -d'"
echo "  (D4 — 'docker compose restart' does NOT reload env_file; vars are baked"
echo "   at container CREATE time, not at start)."
echo
echo "Done."
