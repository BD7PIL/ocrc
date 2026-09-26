#!/usr/bin/env bash
# Spike-instance restart runbook (P2b lessons, 2026-09-26).
# Encapsulates the full recovery sequence: kill → start with spike env →
# force project bootstrap (the V1-baseline compat loader intermittently skips
# eager plugin init, so a project-scoped request is REQUIRED to wake it) →
# verify PRIMARY + TG polling + web port + single instance.
#
# Usage: scripts/spike-restart.sh
set -euo pipefail

REPO=/home/demo/develop/opencode-plugin/ocrc
BIN=/tmp/opencode-v1-baseline/opencode
LOG=/tmp/ocrc-spike/home/.ocrc/ocrc.log
export HOME=/tmp/ocrc-spike/home
export OCRC_HOME=/tmp/ocrc-spike/home/.ocrc
export OPENCODE_CONFIG_DIR=/tmp/ocrc-spike/home/.config/opencode

OLD=$(ss -tlnp 2>/dev/null | grep 4598 | grep -oE 'pid=[0-9]+' | cut -d= -f2 | head -1 || true)
if [ -n "${OLD:-}" ]; then
  echo "killing old instance pid=$OLD"
  kill "$OLD" 2>/dev/null || true
  sleep 3
fi

cd "$REPO"
nohup "$BIN" serve --port 4598 --hostname 127.0.0.1 >> "$LOG" 2>&1 &
sleep 6

# Wake the plugin: project-scoped request forces bootstrap → plugin init.
# (If eager init already ran, these are harmless.)
for p in /app /project /session/list; do
  curl -s -o /dev/null --max-time 3 "http://127.0.0.1:4598$p" || true
done
sleep 5

FAIL=0
# 1. web port
curl -s -o /dev/null --max-time 3 http://127.0.0.1:4099/ || { echo "FAIL: 4099 not serving"; FAIL=1; }
# 2. authenticated API
TOK=$(cat "$OCRC_HOME/token")
curl -s -o /dev/null --max-time 3 -H "Authorization: Bearer $TOK" http://127.0.0.1:4099/api/me || { echo "FAIL: /api/me"; FAIL=1; }
# 3. single instance
N=$(ps aux | grep "opencode-v1-baseline/opencode serve" | grep -v grep | wc -l)
[ "$N" = "1" ] || { echo "FAIL: $N spike instances running"; FAIL=1; }
# 4. plugin became PRIMARY + TG polling
tail -40 "$LOG" | grep -q "became PRIMARY" || { echo "FAIL: no PRIMARY election in recent log"; FAIL=1; }
tail -40 "$LOG" | grep -q "bot polling as @" || { echo "FAIL: no TG polling line"; FAIL=1; }

if [ "$FAIL" = "0" ]; then
  echo "OK: instance up — web 4099 ✓  api ✓  single ✓  PRIMARY ✓  polling ✓"
else
  echo "NOT healthy — check $LOG (network blackholes to api.telegram.org also hang grammY: restart again)"
  exit 1
fi
