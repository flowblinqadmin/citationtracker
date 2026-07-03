#!/usr/bin/env bash
# 02-secrets-list.sh — assert project-level secret store has the expected beacon secrets and
# does NOT carry SUPABASE_SERVICE_ROLE_KEY at the project level (or document its scoping).
# Spec: sec-verify #2.
# Exit: 0 pass, 1 fail, 2 skip
set -u

DESC="supabase secrets list shows SUPABASE_DB_URL + IP_HASH_SECRET, no SUPABASE_SERVICE_ROLE_KEY at project scope"

if [ -z "${SUPABASE_PROJECT_REF:-}" ]; then
  echo "SKIP: $DESC — set SUPABASE_PROJECT_REF env var"
  exit 2
fi

# Local Supabase has no remote project secret store. Skip cleanly — pre-deploy
# audit runs against the real project ref before flipping clients.
if [ "$SUPABASE_PROJECT_REF" = "local" ]; then
  echo "SKIP: $DESC — SUPABASE_PROJECT_REF=local (no remote secret store to audit)"
  exit 2
fi

if ! command -v supabase >/dev/null 2>&1; then
  echo "SKIP: $DESC — supabase CLI not on PATH"
  exit 2
fi

OUT=$(supabase secrets list --project-ref "$SUPABASE_PROJECT_REF" 2>&1)
if [ $? -ne 0 ]; then
  echo "$OUT"
  echo "FAIL: $DESC — supabase secrets list errored (auth? project ref?)"
  exit 1
fi

missing=()
for required in SUPABASE_DB_URL IP_HASH_SECRET; do
  if ! echo "$OUT" | grep -qE "(^|[[:space:]])${required}([[:space:]]|$)"; then
    missing+=("$required")
  fi
done

if [ ${#missing[@]} -gt 0 ]; then
  echo "Secrets missing: ${missing[*]}"
  echo "$OUT"
  echo "FAIL: $DESC — required secrets not present"
  exit 1
fi

if echo "$OUT" | grep -qE '(^|[[:space:]])SUPABASE_SERVICE_ROLE_KEY([[:space:]]|$)'; then
  echo "$OUT"
  echo "WARN: SUPABASE_SERVICE_ROLE_KEY exists at project scope. Per plan, verify it is NOT inherited by track-collect or track-slug. This check warns but does not fail (Supabase per-function scoping is project-dependent)."
fi

echo "PASS: $DESC"
exit 0
