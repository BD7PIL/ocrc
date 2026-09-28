#!/usr/bin/env bash
# V2 host restart + plugin-health verification (unattended batch, 2026-09-28).
# Retries up to 3 times: the V2.0.15 host intermittently skips plugin init
# (historical flakiness; boot-hang itself was fixed by the machine reboot).
set -u

REPO=/home/demo/develop/opencode-plugin/ocrc
BIN=/tmp/opencode-v2-baseline/opencode
LOG=/tmp/ocrc-spike/home/.ocrc/ocrc.log
V2LOG=/tmp/ocrc-spike/v2-retest2.log
export HOME=/tmp/ocrc-spike/home
export OCRC_HOME=/tmp/ocrc-spike/home/.ocrc
export OPENCODE_CONFIG_DIR=/tmp/ocrc-spike/home/.config/opencode

OLDBASE=$(wc -l < "$LOG" 2>/dev/null || echo 0)

for attempt in 1 2 3; do
  # kill by exact binary path (never pkill -f — self-match kills the caller)
  for pid in $(pgrep -f "/tmp/opencode-v2-basel[a]ine/opencode" 2>/dev/null); do kill "$pid" 2>/dev/null; done
  sleep 3
  rm -f "$OCRC_HOME/primary.lock"

  cd "$REPO"
  nohup "$BIN" serve --port 4599 --hostname 127.0.0.1 >> "$V2LOG" 2>&1 &
  sleep 30

  # project-scoped request to force V2 lazy bootstrap
  curl -s -o /dev/null --max-time 5 "http://127.0.0.1:4599/app" || true
  curl -s -o /dev/null --max-time 5 "http://127.0.0.1:4599/session?directory=/tmp/ocrc-spike/project3" || true
  sleep 8

  NEW=$(tail -n +$((OLDBASE + 1)) "$LOG" 2>/dev/null || true)
  INIT=$(echo "$NEW" | grep -c "v0.8.1-ocrc.1 starting" || true)
  PRIM=$(echo "$NEW" | grep -c "became PRIMARY" || true)
  POLL=$(echo "$NEW" | grep -c "polling as @" || true)
  WEB=$(ss -tlnp 2>/dev/null | grep -c 4099 || true)

  echo "--- attempt $attempt: init=$INIT primary=$PRIM polling=$POLL web=$WEB"
  if [ "$INIT" -ge 1 ] && [ "$PRIM" -ge 1 ] && [ "$WEB" -ge 1 ]; then
    echo ">>> HEALTHY on attempt $attempt"
    tail -6 "$LOG"
    exit 0
  fi
done

echo "NOT healthy after 3 attempts — plugin init remained intermittent"
exit 1
