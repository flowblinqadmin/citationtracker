#!/usr/bin/env bash
# Archive subsumed remote branches AFTER consolidation/prod-handoff-2026-06-05
# is merged to main and deployed.
#
# Renames each subsumed remote branch to archive/<name> (create archive ref at the
# current remote tip, then delete the original). This MUTATES the remote.
#
# SAFETY:
#   * Dry-run by default. Pass --apply to actually push/delete.
#   * Requires the remote token set (see CLAUDE.md / memory).
#   * Run ONLY after the consolidation branch has landed on main.
#
# Usage:
#   bash docs/consolidation/archive-subsumed-branches.sh          # dry-run
#   bash docs/consolidation/archive-subsumed-branches.sh --apply  # execute
set -euo pipefail

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

# Branches merged/cherry-picked into the consolidation (the ones to archive).
SUBSUMED=(
  fix/supabase-getuser-middleware
  fix/beacon-mobile-perf
  fix/middleware-allowlist-crawl-webhook
  geo-007-recrawl-ledger
  fix/logged-in-audit-autoverify-clean
  feat/beacon-supabase-edge
  fix/ga-pipe-reader-cursor-advance
  fix/ga-pipe-main-wire-sink-secrets
  feat/ga4-type-aware-sink
  ci/ga-pipe-release-workflow
)
# NOTE: cleo-overhaul was a LOCAL branch (its remote is already merged) — nothing to archive.
# Superseded/already-in-main branches (otp-login-consent-uxgap, local-fix/gmc-completion-*,
# security-audit-2026-05-27, stripe-promo-codes-upi, fix-f2-revoked-race, dev-sprint-10,
# fix/HP-272-consent-ui) were NOT subsumed by us — handle separately if desired.

git fetch origin --prune

for b in "${SUBSUMED[@]}"; do
  if ! git show-ref --verify --quiet "refs/remotes/origin/$b"; then
    echo "SKIP  origin/$b (not on remote)"
    continue
  fi
  echo "ARCHIVE  origin/$b  ->  origin/archive/$b"
  if [ "$APPLY" = "1" ]; then
    git push origin "origin/$b:refs/heads/archive/$b"
    git push origin ":refs/heads/$b"
  else
    echo "  (dry-run) git push origin origin/$b:refs/heads/archive/$b"
    echo "  (dry-run) git push origin :refs/heads/$b"
  fi
done

echo ""
[ "$APPLY" = "1" ] && echo "Done — subsumed branches archived." || echo "Dry-run complete. Re-run with --apply to execute."
