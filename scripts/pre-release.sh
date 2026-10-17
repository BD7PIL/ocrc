#!/bin/bash
# Release gate — run BEFORE tagging vX.Y.Z. Exits non-zero on any failure.
#   ./scripts/pre-release.sh          # full gate + deploy
#
# History: the web-next (ZCode shell) typecheck/test/build steps were retired in
# 2.0.0-alpha.1 (base swap) and the directory itself removed in 2.0.0-alpha.8
# (tag `web-next-final` keeps the snapshot). The CDP/release-smoke UI checks
# targeted that shell, so they went with it; `node scripts/release-smoke.mjs`
# is retired for the same reason. Do not re-add without a PRODUCT-level reversal.
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
echo "── GATE PASSED — safe to tag."
