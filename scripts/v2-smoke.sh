#!/usr/bin/env bash
# V2 smoke test (roadmap ⑤, PRODUCT 兼容基线): download the opencode V2
# binary into an ISOLATED prefix (never touching the production install at
# ~/.local/bin/opencode), verify it runs on THIS machine, and check the V2
# plugin surface. The GLIBC gate IS the deliverable: a clean failure here is
# the recorded conclusion ("V2 needs glibc ≥ X / another platform"), not a
# bug.
#
# Usage: bash scripts/v2-smoke.sh [version]   (default: latest)
#
# FINDING (2026-10-05, EL7实测): the default channel still serves V1 —
# `latest` = 1.18.34, which RUNS CLEAN on glibc 2.17 (verified: --version rc=0,
# stray install removed). V2 rides a separate channel (the migration doc's
# "remove V1 first, install V2" flow — exact V2 install command still to be
# sourced from upstream docs). Until that channel is known, this script's
# latest-install path doubles as the V1-latest compatibility probe.
set -u
PREFIX="${TMPDIR:-/tmp}/ocrc-v2-smoke-$$"
mkdir -p "$PREFIX"
LOG="${PREFIX}/smoke.log"
log() { echo "[v2-smoke] $*" | tee -a "$LOG"; }
fail() { log "FAIL: $*"; echo "$PREFIX" > /tmp/ocrc-v2-smoke-last-prefix; exit 1; }
ok()  { log "PASS: $*"; }

# 1. gate THIS machine first (the known EL7 constraint)
GLIBC=$(ldd --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+')
log "local glibc: ${GLIBC:-unknown} · platform: $(uname -s -m)"
if [ -z "$GLIBC" ]; then fail "cannot determine local glibc"; fi

# 2. resolve the V2 download URL (official installer honors OCRC_INSTALL_DIR;
#    use it to keep production untouched)
export OCRC_INSTALL_DIR="$PREFIX/bin"
log "downloading V2 installer (pin: ${1:-latest}) into $OCRC_INSTALL_DIR"
if ! curl -fsSL --max-time 120 https://opencode.ai/install | bash -s -- ${1:+--version $1} >>"$LOG" 2>&1; then
  fail "installer failed (network or platform unsupported) — see $LOG"
fi
V2BIN="$PREFIX/bin/opencode"
[ -x "$V2BIN" ] || V2BIN="$(find "$PREFIX" -type f -name opencode | head -1)"
[ -n "$V2BIN" ] && [ -x "$V2BIN" ] || fail "no opencode binary after install"

# 3. does the binary even RUN here? (the glibc gate)
VER="$("$V2BIN" --version 2>"$PREFIX/version.err")"
RC=$?
if [ $RC -ne 0 ]; then
  log "binary failed to execute (rc=$RC):"
  head -5 "$PREFIX/version.err" | while read -r l; do log "  $l"; done
  fail "V2 binary cannot run on glibc $GLIBC — record as the gate conclusion"
fi
ok "binary runs: $VER"

# 4. plugin surface: V2 loads plugins via the dual export (setup member).
#    Smoke = `opencode` starts a serve and answers /global/health with the
#    plugin's web transport bound on our port. The plugin needs TELEGRAM
#    unset (web-only shape) and OCRC_WEB_ENABLED=true.
export OCRC_WEB_PORT=4599
export OCRC_WEB_ENABLED=true
"$V2BIN" serve --port 4598 --hostname 127.0.0.1 >>"$LOG" 2>&1 &
SERVE_PID=$!
trap 'kill $SERVE_PID 2>/dev/null' EXIT
for i in $(seq 1 30); do
  sleep 1
  if curl -s --max-time 2 http://127.0.0.1:4598/global/health >/dev/null 2>&1; then break; fi
done
if curl -s --max-time 2 http://127.0.0.1:4599/ -o /dev/null 2>&1; then
  ok "plugin web transport answered on 4599 — V2 loads the ocrc plugin"
else
  fail "plugin web transport did NOT answer on 4599 — inspect $LOG"
fi
log "all green — V2 smoke passed on glibc $GLIBC"
