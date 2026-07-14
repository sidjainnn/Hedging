#!/usr/bin/env bash
# Unified QA gate. Runs, in order:
#   1. typecheck            (this repo)
#   2. unit tests           (this repo — adversarial: sign, scale, edge cases)
#   3. selftest             (this repo — end-to-end wiring)
#   4. their Jest suites     (matcher + distribution, if cloned) — REPORTED HONESTLY,
#                            not gated on, since their own suites have known failures.
# Exits non-zero if OUR checks fail. Their suites are informational.
set -uo pipefail
cd "$(dirname "$0")/.."
FAIL=0

echo "── 1. typecheck ─────────────────────────────────"
npm run --silent typecheck || FAIL=1

echo "── 2. unit tests (adversarial) ──────────────────"
node --import tsx --test test/*.test.ts || FAIL=1

echo "── 3. selftest (end-to-end wiring) ──────────────"
npm run --silent selftest || FAIL=1

echo "── 4. their Jest suites (informational) ─────────"
for repo in ~/gb-trading-matching-engine-service ~/gb-trading-distribution-engine-se; do
  if [ -d "$repo/node_modules/.bin" ]; then
    echo "  · $(basename "$repo"):"
    ( cd "$repo" && npx jest 2>&1 | grep -E "Tests:|Test Suites:" | sed 's/^/    /' ) || true
  else
    echo "  · $(basename "$repo"): deps not installed — skipped"
  fi
done

echo "─────────────────────────────────────────────────"
if [ "$FAIL" -eq 0 ]; then echo "✅ OUR QA gate PASSED"; else echo "❌ OUR QA gate FAILED"; fi
exit $FAIL
