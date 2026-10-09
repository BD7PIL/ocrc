#!/usr/bin/env bash
# P0-1 spike runner — reproduce the tool-registration semantics findings.
#
# SAFETY: this script never touches the user's engine (opencode :4096) or any
# running ocrc host. It creates its own scratch HOME under $ROOT, starts its own
# `opencode serve` on $PORT, and kills ONLY pids it started (resolved by pid, and
# the port owner as a fallback because the bun-compiled binary re-execs itself —
# `$!` is not always the listening process). Never `pkill opencode`: that would
# take the user's engine down with it.
#
# Usage:  scripts/spikes/p0-tool-registration/run.sh [--with-duplicate] [--port 4297]
set -u

WITH_DUP=0
PORT=4297
while [ $# -gt 0 ]; do
  case "$1" in
    --with-duplicate) WITH_DUP=1; shift ;;
    --port) PORT="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${PROBE_ROOT:-/tmp/ocrc-p0}"
HOMEDIR="$ROOT/home"
PROJ1="$ROOT/proj"
PROJ2="$ROOT/proj2"
LOG="$ROOT/probe-loads.log"
SERVE_LOG="$ROOT/serve.log"

rm -rf "$ROOT"
mkdir -p "$HOMEDIR/.config/opencode/plugin" "$PROJ1" "$PROJ2"
cp "$HERE/probe.js" "$HOMEDIR/.config/opencode/plugin/probe.js"
if [ "$WITH_DUP" = "1" ]; then
  cp "$HERE/probe2.js" "$HOMEDIR/.config/opencode/plugin/probe2.js"
fi

# Pid of whoever holds $PORT right now (may be empty before the server is up).
port_pid() {
  ss -ltnp 2>/dev/null | grep -F ":$PORT " | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2
}

SPAWN_PID=""
cleanup() {
  local pids="$SPAWN_PID $(port_pid)"
  for p in $pids; do
    [ -n "$p" ] || continue
    kill "$p" 2>/dev/null || true
  done
  for _ in $(seq 1 20); do
    [ -z "$(port_pid)" ] && break
    sleep 0.3
  done
  local left
  left="$(port_pid)"
  if [ -n "$left" ]; then
    echo "   !! port $PORT still held by pid $left — killing it (it is this script's own serve)" >&2
    kill -9 "$left" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "== starting scratch opencode serve (HOME=$HOMEDIR, port=$PORT)"
( cd "$PROJ1" && HOME="$HOMEDIR" PROBE_LOG="$LOG" nohup opencode serve --port "$PORT" --hostname 127.0.0.1 --print-logs >"$SERVE_LOG" 2>&1 & echo $! >"$ROOT/serve.pid" )
SPAWN_PID="$(cat "$ROOT/serve.pid" 2>/dev/null || true)"
echo "   spawned pid=$SPAWN_PID (the listening pid is resolved from the port and killed too)"

for _ in $(seq 1 40); do
  curl -s -m 2 "http://127.0.0.1:$PORT/experimental/tool/ids" >/dev/null 2>&1 && break
  sleep 0.5
done
LISTEN_PID="$(port_pid)"
echo "   listening pid=$LISTEN_PID"

echo
echo "== [1] tool ids, workspace 1 ($PROJ1)"
curl -s "http://127.0.0.1:$PORT/experimental/tool/ids?directory=$PROJ1"
echo
echo "== [2] tool ids, workspace 2 ($PROJ2) — same process, second app instance"
curl -s "http://127.0.0.1:$PORT/experimental/tool/ids?directory=$PROJ2"
echo
echo "== [3] tool list with descriptions (duplicates visible only here)"
curl -s "http://127.0.0.1:$PORT/experimental/tool?provider=anthropic&model=claude-sonnet-4-5&directory=$PROJ1" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); [print("   ", t.get("id"), "|", t.get("description")) for t in d if str(t.get("id","")).startswith("wf_")]' 2>/dev/null
echo
echo "== [4] plugin load events (one line per plugin file x app instance)"
cat "$LOG" 2>/dev/null || echo "   (none)"
echo
echo "== [5] app-instance bootstraps seen by the engine"
grep -E "creating instance|bootstrapping" "$SERVE_LOG" 2>/dev/null | sed 's/^/   /'
echo
echo "== [6] sockets owned by the serve process (only the API port; the plugin opens none)"
if [ -n "$LISTEN_PID" ]; then
  ss -ltnp 2>/dev/null | grep -F "pid=$LISTEN_PID," | sed 's/^/   /'
fi
