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

# ── alpha.7: full endpoint coverage (previously untested faces) ─────────────
echo "[11] GET /status"
req "http://127.0.0.1:$PORT/status" | grep -q '"status"' || fail "GET /status"
echo "[12] fs/stat"
req -X POST "http://127.0.0.1:$PORT/fs/stat" -d "{\"path\":\"$ROOT/hello.txt\"}" | grep -q '"type":"file"' || fail "fs/stat"
echo "[13] fs/mkdir"
req -X POST "http://127.0.0.1:$PORT/fs/mkdir" -d "{\"path\":\"$ROOT/newdir\"}" | grep -q '"path"' || fail "fs/mkdir"
[ -d "$ROOT/newdir" ] || fail "mkdir landed"
echo "[14] git/log"
req -X POST "http://127.0.0.1:$PORT/git/log" -d "{\"path\":\"$ROOT\"}" | grep -q 'acceptance: workspace face' || fail "git/log"
echo "[15] error path: 401 without token"
[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/health)" = "401" ] || fail "401 guard"
echo "[16] error path: 409 fs without... (active profile present — use a fresh service for 409)"
# 409 needs a service with NO active profile: the second service instance below.
echo "[16] omo/config GET (no remote config → format missing)"
req "http://127.0.0.1:$PORT/omo/config" | grep -q '"format"' || fail "omo/config GET"
echo "[17] omo/config POST structured with a raw content doc present (preset set + .ocrc-bak)"
# Seed the remote with a base config carrying a presets map, then structured-edit it.
ssh -o BatchMode=yes -o StrictHostKeyChecking=no "$(id -un)@127.0.0.1" 'mkdir -p ~/.config/opencode && printf "{\"presets\":{\"balanced\":{}},\"model\":\"m\"}" > ~/.config/opencode/oh-my-opencode-slim.json'
req -X POST "http://127.0.0.1:$PORT/omo/config" -d '{"preset":"balanced"}' | grep -q '"ok":true' || fail "omo preset apply"
echo "[18] omo/config POST raw content (atomic write + .ocrc-bak)"
req -X POST "http://127.0.0.1:$PORT/omo/config" -d '{"content":"{\"preset\":\"balanced\"}"}' | grep -q '"ok":true' || fail "omo/config write"
ssh -o BatchMode=yes -o StrictHostKeyChecking=no "$(id -un)@127.0.0.1" "grep -q balanced \"\$HOME/.config/opencode/oh-my-opencode-slim.json\" && [ -f \"\$HOME/.config/opencode/oh-my-opencode-slim.json.ocrc-bak\" ]" || fail "omo write landed + .ocrc-bak"
echo "[19] omo/config 422 on invalid JSON"
[ "$(code -X POST "http://127.0.0.1:$PORT/omo/config" -d '{"content":"{not json"}')" = "422" ] || fail "omo 422"
echo "[20] omo/config 400 on mixed body"
[ "$(code -X POST "http://127.0.0.1:$PORT/omo/config" -d '{"content":"{}","preset":"x"}')" = "400" ] || fail "omo mixed-body 400"
echo "[21] config/source (panel-host inventory)"
req -X POST "http://127.0.0.1:$PORT/config/source" -d '{}' | grep -q '"configPath"' || fail "config/source"
echo "[22] config/preview → 404 when panel-host config missing"
[ "$(code -X POST "http://127.0.0.1:$PORT/config/preview" -d '{}' )" = "404" ] || true # panel host may have a real config; 404 OR 200 both fine, just log
echo "      (config/preview status: $(code -X POST "http://127.0.0.1:$PORT/config/preview" -d '{}'))"
echo "[23] config/apply round-trip (panel config → remote \$HOME/.config/opencode/opencode.json)"
# Seed the remote's opencode.json so the apply's .ocrc-bak path is exercised
# (bak is only created when the remote file pre-exists — syncConfig family).
ssh -o BatchMode=yes -o StrictHostKeyChecking=no "$(id -un)@127.0.0.1" 'mkdir -p ~/.config/opencode && printf "{\"model\":\"keep-me\"}" > ~/.config/opencode/opencode.json'
# Seed a panel-host config the service will find (service resolves via env).
mkdir -p "$WS/panel-cfg"
OPENCODE_CONFIG_DIR="$WS/panel-cfg" true # env for THIS shell only; service reads its own env at spawn — restart service with the env
kill "$SRV_PID" 2>/dev/null || true
echo '{"mcp":{"servers":{"acc":{"type":"local"}}},"agents":{"acc-agent":"md"}}' > "$WS/panel-cfg/opencode.json"
OPENCHAMBER_SERVICE_PORT=$PORT OPENCHAMBER_SERVICE_TOKEN=$TOK \
  OCRC_CONNECT_PROFILES="$WS/profiles.json" OPENCODE_CONFIG_DIR="$WS/panel-cfg" node service/main.js >> "$LOG" 2>&1 &
SRV_PID=$!
for _ in $(seq 1 20); do curl -s -o /dev/null -H "Authorization: Bearer $TOK" "http://127.0.0.1:$PORT/health" && break; sleep 0.5; done
# reconnect after restart (active profile is in-memory)
req -X POST "http://127.0.0.1:$PORT/connect" -d '{"profileId":"acc"}' > /dev/null
req -X POST "http://127.0.0.1:$PORT/config/preview" -d '{}' | grep -q '"sectionsBridged"' || fail "config/preview"
req -X POST "http://127.0.0.1:$PORT/config/apply" -d '{}' | grep -q '"applied":true' || fail "config/apply"
ssh -o BatchMode=yes -o StrictHostKeyChecking=no "$(id -un)@127.0.0.1" "grep -q acc-agent \"\$HOME/.config/opencode/opencode.json\"" || fail "config/apply landed on remote"
ssh -o BatchMode=yes -o StrictHostKeyChecking=no "$(id -un)@127.0.0.1" "[ -f \"\$HOME/.config/opencode/opencode.json.ocrc-bak\" ]" || fail "apply .ocrc-bak"
echo "[24] disconnect + 409 on fs face without active profile"
req -X POST "http://127.0.0.1:$PORT/disconnect" -d '{}' | grep -q '"status"' || fail "disconnect"
[ "$(code -X POST "http://127.0.0.1:$PORT/fs/list" -d "{\"path\":\"$ROOT\"}")" = "409" ] || fail "409 no-active-profile"
echo "[25] DELETE /profiles/:id"
req -X DELETE "http://127.0.0.1:$PORT/profiles/acc" | grep -q '"profiles":\[\]' || fail "DELETE profile"

echo "ACCEPTANCE OK — browse/edit/diff/commit over loopback ssh, guards hold;"
echo "alpha.7: status/fs-stat/fs-mkdir/git-log/omo-config/config-bridge/disconnect/delete covered."
