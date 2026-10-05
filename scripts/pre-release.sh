#!/bin/bash
# Release gate — run BEFORE tagging vX.Y.Z. Exits non-zero on any failure.
#   ./scripts/pre-release.sh          # full gate + deploy + live smoke
set -euo pipefail
cd "$(dirname "$0")/.."

echo "── 1/6 typecheck"
npm run typecheck
echo "── 2/6 backend tests"
npx vitest run --reporter=dot 2>&1 | tail -2
echo "── 3/6 web checks + tests"
npm --prefix web run check --silent >/dev/null 2>&1 || npx --prefix web svelte-check --threshold error 2>&1 | tail -1
npm --prefix web test 2>&1 | tail -2
echo "── 4/6 builds"
npm run build
npm --prefix web run build 2>&1 | tail -1
echo "── 5/6 deploy to production"
~/bin/restart-ocrc.sh
echo "── 6/6 live release smoke (CDP + real streaming)"
node scripts/release-smoke.mjs http://127.0.0.1:4099
echo "── GATE PASSED — safe to tag."
