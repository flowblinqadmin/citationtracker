#!/bin/bash
# run-weekly.sh — Weekly AI surface ranking factor experiment
#
# Designed to run as a cron job or GitHub Actions workflow.
# Runs the full experiment, saves results, and optionally commits to git.
#
# Cron example (every Monday 6am EST):
#   0 10 * * 1 cd /path/to/geo && bash scripts/experiments/ai-surface-audit/run-weekly.sh
#
# GitHub Actions: see .github/workflows/ai-surface-audit.yml
#
# Required env vars (set in .env.local or CI secrets):
#   OPENAI_API_KEY, PERPLEXITY_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY
#   FIRECRAWL_API_KEY, BRAVE_API_KEY (optional), TOGETHER_API_KEY (optional)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GEO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RESULTS_DIR="$SCRIPT_DIR/results"
DATE=$(date +%Y-%m-%d)

cd "$GEO_ROOT"

echo "═══════════════════════════════════════════════════════════"
echo "  Weekly AI Surface Ranking Factor Audit — $DATE"
echo "═══════════════════════════════════════════════════════════"

# Load env if available
if [ -f .env.local ]; then
  export $(grep -v '^#' .env.local | xargs)
fi

# Run experiment
node --env-file=.env.local scripts/experiments/ai-surface-audit/run-experiment.mjs \
  --output "$RESULTS_DIR" \
  2>&1 | tee "$RESULTS_DIR/run-$DATE.log"

echo ""
echo "Results saved to: $RESULTS_DIR/"
echo "  - ranking-factors-$DATE.txt (human-readable)"
echo "  - ranking-factors-$DATE.json (machine-readable)"
echo "  - signals.json (cached signals)"
echo "  - probes.json (cached probes)"

# If running in CI with git access, commit results
if [ "${CI:-false}" = "true" ] && [ "${AUTO_COMMIT:-false}" = "true" ]; then
  git add "$RESULTS_DIR/"
  git commit -m "data: weekly AI surface ranking audit — $DATE

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>" || true
fi
