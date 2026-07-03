#!/usr/bin/env bash
# run-all.sh — execute every numbered security check, aggregate, print summary.
# Exit 0 only if no non-skipped check fails.
set -u

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
CHECK_DIR="$SCRIPT_DIR/checks"

if [ ! -d "$CHECK_DIR" ]; then
  echo "ERROR: $CHECK_DIR not found"
  exit 2
fi

passed=0
failed=0
skipped=0
fail_names=()
skip_names=()

# Iterate in numerical order: 01..19
for f in $(ls "$CHECK_DIR"/*.sh 2>/dev/null | sort); do
  name="$(basename "$f")"
  printf "\n========== %s ==========\n" "$name"
  bash "$f"
  rc=$?
  case "$rc" in
    0)
      passed=$((passed + 1))
      ;;
    2)
      skipped=$((skipped + 1))
      skip_names+=("$name")
      ;;
    *)
      failed=$((failed + 1))
      fail_names+=("$name")
      ;;
  esac
done

total=$((passed + failed + skipped))
echo ""
echo "==================== SUMMARY ===================="
echo "Total:   $total"
echo "Passed:  $passed"
echo "Failed:  $failed"
echo "Skipped: $skipped"

if [ "$failed" -gt 0 ]; then
  echo ""
  echo "Failures:"
  for n in "${fail_names[@]}"; do echo "  - $n"; done
fi
if [ "$skipped" -gt 0 ]; then
  echo ""
  echo "Skipped (precondition unmet):"
  for n in "${skip_names[@]}"; do echo "  - $n"; done
fi
echo "================================================="

[ "$failed" -eq 0 ] || exit 1
exit 0
