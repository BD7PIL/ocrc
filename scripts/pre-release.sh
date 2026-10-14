#!/bin/bash
# Release gate — run BEFORE tagging vX.Y.Z. Exits non-zero on any failure.
#   ./scripts/pre-release.sh          # full gate + deploy + live smoke
#
# 2.0.0-alpha.1 (base-swap batch 1): web-next is FROZEN — its typecheck/test/
# build steps are retired from this gate (the openchamber panel replaces it;
# see docs/research/openchamber-base-swap-verdict.md). Re-enable nothing here
# without a PRODUCT-level reversal.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "── 1/4 typecheck"
npm run typecheck
echo "── 2/4 backend tests"
npx vitest run --reporter=dot 2>&1 | tail -2
echo "── 3/4 build"
npm run build
echo "── 4/4 deploy to production"
~/bin/restart-ocrc.sh
echo "── live release smoke (CDP + real streaming)"
node scripts/release-smoke.mjs http://127.0.0.1:4099
echo "── GATE PASSED — safe to tag."
