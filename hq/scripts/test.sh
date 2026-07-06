#!/usr/bin/env bash
set -uo pipefail

# Mirrors assistant/scripts/test.sh's convention: run each test file in its
# own Bun process so module-level state (env vars, mock fetch) can never
# bleed across files.

cd "$(dirname "$0")/.."

fail=0
for f in src/__tests__/*.test.ts; do
  echo "──────────────────────────────────────────────"
  echo "▶ ${f}"
  bun test "${f}" || fail=1
done

echo "──────────────────────────────────────────────"
if [[ "${fail}" -ne 0 ]]; then
  echo "❌ hq test suite failed"
else
  echo "✅ hq test suite passed"
fi
exit "${fail}"
