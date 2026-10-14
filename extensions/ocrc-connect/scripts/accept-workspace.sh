#!/usr/bin/env bash
# Batch 4 acceptance: the ocrc-connect service's fs/git-over-ssh face, live
# against loopback ssh (same pattern as the batch-2 tunnel acceptance).
#
#   browse → read → edit-save(.bak) → diff → stage → commit → status clean
#   plus the guards: 403 outside allowedRoots, 400 on `..` escapes.
#
# Usage: extensions/ocrc-connect/scripts/accept-workspace.sh
# Requires: local sshd reachable as $(id -un)@127.0.0.1 with BatchMode keys.
set -euo pipefail

PORT=${PORT:-4532}
TOK=${TOK:-accept-tok}
WS=$(mktemp -d /tmp/ocrc-ws-accept.XXXXXX)
ROOT="$WS/root"
LOG="$WS/service.log"
SRV_PID=""

cleanup() {
  [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null || true
  rm -rf "$WS"
}
trap cleanup EXIT

cd "$(dirname "$0")/.." # extension root

# fixture: a git repo with one file
mkdir -p "$ROOT/sub"
git init -q "$ROOT"
git -C "$ROOT" config user.email accept@ocrc
git -C "$ROOT" config user.name acceptance
echo "hello v1" > "$ROOT/hello.txt"
git -C "$ROOT" add -A
git -C "$ROOT" commit -qm init

OPENCHAMBER_SERVICE_PORT=$PORT OPENCHAMBER_SERVICE_TOKEN=$TOK \
  OCRC_CONNECT_PROFILES="$WS/profiles.json" node service/main.js > "$LOG" 2>&1 &
SRV_PID=$!
for _ in $(seq 1 20); do
  curl -s -o /dev/null -H "Authorization: Bearer $TOK" "http://127.0.0.1:$PORT/health" && break
  sleep 0.5
done

req() { curl -s -H "Authorization: Bearer $TOK" -H 'content-type: application/json' "$@"; }
code() { curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOK" -H 'content-type: application/json' "$@"; }
fail() { echo "FAIL: $1"; exit 1; }

# profile: loopback self-connection, allowlist = the fixture root
req -X POST "http://127.0.0.1:$PORT/profiles" -d "{\"profile\":{\"id\":\"acc\",\"name\":\"loopback\",\"host\":\"127.0.0.1\",\"user\":\"$(id -un)\",\"port\":22,\"remotePort\":4398,\"localPort\":4599,\"allowedRoots\":[\"$ROOT\"]}}" > /dev/null
req -X POST "http://127.0.0.1:$PORT/connect" -d '{"profileId":"acc"}' > /dev/null

echo "[1] fs/list"
req -X POST "http://127.0.0.1:$PORT/fs/list" -d "{\"path\":\"$ROOT\"}" | grep -q '"name":"hello.txt"' || fail "fs/list"
echo "[2] allowlist guard (403 outside)"
[ "$(code -X POST "http://127.0.0.1:$PORT/fs/list" -d '{"path":"/etc"}')" = "403" ] || fail "403 guard"
echo "[3] fs/read (base64)"
req -X POST "http://127.0.0.1:$PORT/fs/read" -d "{\"path\":\"$ROOT/hello.txt\"}" | grep -q 'aGVsbG8gdjEK' || fail "fs/read"
echo "[4] fs/write atomic + .bak"
req -X POST "http://127.0.0.1:$PORT/fs/write" -d "{\"path\":\"$ROOT/hello.txt\",\"content\":\"hello v2\"}" | grep -q '"backup"' || fail "fs/write backup"
grep -q 'hello v2' "$ROOT/hello.txt" || fail "write landed"
[ -f "$ROOT/hello.txt.bak" ] || fail ".bak missing"
echo "[5] .. escape rejected (400)"
[ "$(code -X POST "http://127.0.0.1:$PORT/fs/read" -d "{\"path\":\"$ROOT/../$WS/passwd\"}")" = "400" ] || fail ".. guard"
echo "[6] git/status shows the edit"
req -X POST "http://127.0.0.1:$PORT/git/status" -d "{\"path\":\"$ROOT\"}" | grep -q '"y":"M","path":"hello.txt"' || fail "git/status"
echo "[7] git/diff non-empty"
req -X POST "http://127.0.0.1:$PORT/git/diff" -d "{\"path\":\"$ROOT\"}" | grep -q 'hello v2' || fail "git/diff"
echo "[8] stage + commit"
req -X POST "http://127.0.0.1:$PORT/git/stage" -d "{\"path\":\"$ROOT\"}" | grep -q '"ok":true' || fail "git/stage"
req -X POST "http://127.0.0.1:$PORT/git/commit" -d "{\"path\":\"$ROOT\",\"message\":\"acceptance: workspace face\"}" | grep -q '"committed":true' || fail "git/commit"
echo "[9] status clean after commit"
req -X POST "http://127.0.0.1:$PORT/git/status" -d "{\"path\":\"$ROOT\"}" | grep -q '"entries":\[\]' || fail "post-commit clean"
echo "[10] badge endpoint"
req "http://127.0.0.1:$PORT/git-branch" | grep -q '"branch":' || fail "git-branch"

echo "ACCEPTANCE OK — browse/edit/diff/commit over loopback ssh, guards hold."
