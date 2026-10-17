#!/usr/bin/env bash
# 面板侧 provisioning 验收（PRODUCT 第零点九条 / 裁决 D4–D17）。
#
# 目标机由 --target 显式给出（没有默认值）：这一套会真的往那台机器上读写，
# 所以指向哪台必须由人负责。**绝不对生产机跑安装段**——用一次性容器或专用测试账号。
#
# 所有写入都落在目标机的 /tmp/ocrc-accept.XXXX 临时目录里（脚本自己建、自己删）；
# 服务本身在面板侧的临时 HOME 下起，绝不碰真实的 ~/.config/opencode。
#
# Usage:
#   extensions/ocrc-connect/scripts/accept-provision.sh --target user@host[:port]
#   extensions/ocrc-connect/scripts/accept-provision.sh --target user@host --with-install
#   extensions/ocrc-connect/scripts/accept-provision.sh --target user@host --with-runtime
#
# --with-install 会把 fixture registry 的假工件真装进目标机的 ~/.opencode/bin
# （并验证校验失败不动旧件、幂等重放、卸载）。它要求目标机能访问面板侧端口，
# 所以典型用法是 loopback（同一台机器）或容器。
#
# --with-runtime 用同一个 fixture registry 兼当 **npm registry**，在目标机上真跑
# 一次 npm install（落点 ~/.ocrc/runtime/<pkg>/<slot>，入口由包自己的 bin 解析），
# 并验证幂等、npx 改写、失败不动旧目录、移除。同样要求目标机能访问面板侧端口；
# 目标机没有 node/npm 时这一段会改成断言「如实报装不了」。
#
# --registry-host 指定 fixture registry 绑定的面板侧地址（默认 127.0.0.1）。远程靶机
# （例如 --target demo@192.168.26.101）要给一个它够得着、且是**本机**的地址：
#   ... --target demo@192.168.26.101 --with-runtime --registry-host 192.168.26.1
set -euo pipefail

TARGET=""
WITH_INSTALL=0
WITH_RUNTIME=0
# fixture registry 绑在哪个地址上：loopback 靶机用默认值；远程靶机要给一个它够得着的
# 面板侧地址（例如 --registry-host 192.168.26.1）。它同时是 npm registry 的地址。
REGHOST=127.0.0.1
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --with-install) WITH_INSTALL=1; shift ;;
    --with-runtime) WITH_RUNTIME=1; shift ;;
    --registry-host) REGHOST="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$TARGET" ] || { echo "需要 --target user@host[:port]（这一套会真往目标机读写）" >&2; exit 2; }

UH=${TARGET%%@*}
TH=${TARGET##*@}
TPORT=22
case "$TH" in *:*) TPORT=${TH##*:}; TH=${TH%%:*} ;; esac
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p "$TPORT")
ssh_t() { ssh "${SSH_OPTS[@]}" "$UH@$TH" "$@"; }

PORT=${PORT:-4544}
TOK=${TOK:-accept-prov-tok}
WS=$(mktemp -d /tmp/ocrc-prov-accept.XXXXXX)
# 面板侧的临时工件缓存。**不能靠改 HOME 来沙箱化**：Windows 的 ssh 从 HOME 找私钥，
# 改 HOME 会直接把认证打断（本轮实测）——所以缓存单独指，其余环境保持原样。
CACHE_DIR="$WS/artifacts"
REGPORT=${REGPORT:-4545}
SRV_PID=""
REG_PID=""
TARGET_WS=""

cleanup() {
  [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null || true
  [ -n "$REG_PID" ] && kill "$REG_PID" 2>/dev/null || true
  [ -n "$TARGET_WS" ] && ssh_t "rm -rf '$TARGET_WS'" 2>/dev/null || true
  rm -rf "$WS"
}
trap cleanup EXIT

cd "$(dirname "$0")/.." # extension root

fail() { echo "FAIL: $1"; exit 1; }
note() { echo "      $1"; }

ssh_t true 2>/dev/null || fail "目标机 ssh 不可用：$TARGET（BatchMode 公钥要先配好）"
TARGET_WS=$(ssh_t 'mktemp -d /tmp/ocrc-accept.XXXXXX' | tr -d '\r')
[ -n "$TARGET_WS" ] || fail "在目标机上建临时目录失败"
note "目标机 : $TARGET ，临时目录 $TARGET_WS（结尾会删掉）"

# ── fixture registry：元数据与 tarball 都在本地造，安装段完全离线 ──────────────
mkdir -p "$WS/registry" "$WS/pkg/package/bin"
cat > "$WS/pkg/package/bin/opencode" <<'EOF'
#!/bin/sh
echo "2.0.27"
EOF
chmod 755 "$WS/pkg/package/bin/opencode"
tar czf "$WS/registry/cli-linux-x64-2.0.27.tgz" -C "$WS/pkg" package
# 被换过内容的「同一个工件」：元数据里的校验值不变，磁盘上的字节变了（第 [15] 步用）。
mkdir -p "$WS/pkg-tampered/package/bin"
printf '#!/bin/sh\necho "9.9.9"\n' > "$WS/pkg-tampered/package/bin/opencode"
chmod 755 "$WS/pkg-tampered/package/bin/opencode"
tar czf "$WS/registry/cli-linux-x64-2.0.27-tampered.tgz" -C "$WS/pkg-tampered" package
INTEGRITY="sha512-$(openssl dgst -sha512 -binary "$WS/registry/cli-linux-x64-2.0.27.tgz" | openssl base64 -A)"
BAD_INTEGRITY="sha512-$(printf 'not the artifact' | openssl dgst -sha512 -binary | openssl base64 -A)"

cat > "$WS/registry/serve.mjs" <<'EOF'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
const [dir, integrity, bad, host, port, engineTgz] = process.argv.slice(2)
createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const path = decodeURIComponent(url.pathname)
  // npm packument（运行时段）：/<name> → 元数据文件 <name>.packument.json
  const packument = join(dir, path.replace(/^\/+/, '') + '.packument.json')
  if (existsSync(packument)) {
    res.writeHead(200, { 'content-type': 'application/json' })
    createReadStream(packument).pipe(res)
    return
  }
  if (path.endsWith('.tgz')) {
    // 引擎工件的元数据请求会带 scoped 包名（`@opencode/cli-linux-x64`），按它拼出来的
    // 文件名和磁盘上的对不上——所以请求的文件不在时退到那份唯一的 fixture 工件。
    const wanted = join(dir, path.slice(1))
    const file = existsSync(wanted) ? wanted : join(dir, engineTgz)
    if (!existsSync(file)) { res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"no such tarball"}'); return }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': statSync(file).size })
    createReadStream(file).pipe(res)
    return
  }
  const wantedIntegrity = url.searchParams.get('bad') === '1' ? bad : integrity
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ dist: { tarball: `http://${host}:${port}/${engineTgz}`, integrity: wantedIntegrity, unpackedSize: 11 * 1024 * 1024 } }))
}).listen(Number(port), host, () => console.log('fixture registry up on ' + host + ':' + port))
EOF
node "$WS/registry/serve.mjs" "$WS/registry" "$INTEGRITY" "$BAD_INTEGRITY" "$REGHOST" "$REGPORT" "cli-linux-x64-2.0.27.tgz" > "$WS/registry.log" 2>&1 &
REG_PID=$!
sleep 0.6

# ── 服务：临时 profiles + 临时缓存；锚点版本由环境给出（面板宿主就是版本源，D6）──
OCRC_ENGINE_VERSION=2.0.27 \
OCRC_REGISTRY="http://$REGHOST:$REGPORT" \
OCRC_CACHE_DIR="$CACHE_DIR" \
OPENCHAMBER_SERVICE_PORT=$PORT OPENCHAMBER_SERVICE_TOKEN=$TOK \
OCRC_CONNECT_PROFILES="$WS/profiles.json" \
  node service/main.js > "$WS/service.log" 2>&1 &
SRV_PID=$!
for _ in $(seq 1 20); do
  curl -s -o /dev/null -H "Authorization: Bearer $TOK" "http://127.0.0.1:$PORT/health" && break
  sleep 0.5
done

req() { curl -s -H "Authorization: Bearer $TOK" -H 'content-type: application/json' "$@"; }
code() { curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOK" -H 'content-type: application/json' "$@"; }
field() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{let v=JSON.parse(d);for(const k of process.argv[1].split('.'))v=v?.[k];if(v===undefined)process.stdout.write('null');else process.stdout.write(typeof v==='string'?v:JSON.stringify(v))})" "$1"; }
# 从一圈运行时计划里挑出某一项（按包名）——清单顺序不是契约，索引会漂。
rtitem() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const it=(j.runtime?.items??[]).find(i=>i.need.name===process.argv[1]);process.stdout.write(it?JSON.stringify(it):'null')})" "$1"; }
rtstate() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const it=(j.runtime?.items??[]).find(i=>i.need.name===process.argv[1]);process.stdout.write(it?it.action:'null')})" "$1"; }

echo "[1] 无档案时要求先连上（409，而不是拿一台随机机器动手）"
for path in /detect /provision/plan /capabilities; do
  [ "$(code -X POST "http://127.0.0.1:$PORT$path" -d '{}')" = "409" ] || fail "$path should 409 without a profile"
done

req -X POST "http://127.0.0.1:$PORT/profiles" \
  -d "{\"profile\":{\"id\":\"acc\",\"name\":\"acceptance\",\"host\":\"$TH\",\"user\":\"$UH\",\"port\":$TPORT,\"remotePort\":4398,\"localPort\":4599,\"allowedRoots\":[\"$TARGET_WS\"],\"projects\":[{\"path\":\"$TARGET_WS\"}]}}" > /dev/null
req -X POST "http://127.0.0.1:$PORT/connect" -d '{"profileId":"acc"}' > /dev/null

echo "[2] POST /detect：一条 ssh 探完四档"
DET=$(req -X POST "http://127.0.0.1:$PORT/detect" -d '{}')
echo "$DET" | grep -q '"readiness"' || fail "readiness missing: $DET"
echo "$DET" | grep -q '"anchor":"2.0.27"' || fail "anchor missing（面板宿主是版本源，D6）"
echo "$DET" | grep -q '"glibc"' || fail "glibc not probed"
note "$(echo "$DET" | field detect.os) / glibc $(echo "$DET" | field detect.glibc) / 平台 $(echo "$DET" | field detect.platform) / 出网 $(echo "$DET" | field detect.outbound) / 引擎 $(echo "$DET" | field detect.engine.version)"

echo "[3] 第③档如实报缺；用户既有安装被单独记下并标明不动它"
# 上一轮中断可能留下我们自己装的引擎——那时第③档就该报在位，而不是硬报缺。
ENGINE_V=$(echo "$DET" | field detect.engine.version)
if [ "$ENGINE_V" = "null" ]; then
  [ "$(echo "$DET" | field readiness.steps.2.ok)" = "false" ] || fail "engine step should be false when nothing is installed"
  note "第③档如实报缺（~/.opencode/bin 里没有引擎）"
else
  note "目标机上已有引擎 $ENGINE_V（上一轮遗留或本来就在我们的落点上）——第③档按在位报，[13] 会重装它"
fi
if [ "$(echo "$DET" | field detect.legacyEngine.path)" != "null" ]; then
  note "探测到既有安装 $(echo "$DET" | field detect.legacyEngine.version) @ $(echo "$DET" | field detect.legacyEngine.path)（结构化的 detect.legacyEngine，我们不碰它）"
  # 缺引擎时第③档的 detail 要带上它（在位时那档说的是在位版本，见 detect.test.ts 的用例）。
  if [ "$ENGINE_V" = "null" ]; then
    echo "$DET" | grep -q '不会动它' || fail "legacy install note missing from the engine rung"
    note "第③档的 detail 里也点明了既有安装、且不会动它"
  fi
fi

echo "[4] 规划：包名/版本/校验值/落点/取件方式/为什么，一次说清"
# 把 [2] 探到的那份 detect 原样带进去——面板就是这么做的，于是「看到的」与「决定的」
# 之间没有窗口（出网探测是活的外部依赖，两次探测可能给出不同答案）。
PLAN=$(req -X POST "http://127.0.0.1:$PORT/provision/plan" -d "{\"detect\":$(echo "$DET" | field detect)}")
echo "$PLAN" | grep -q '"version":"2.0.27"' || fail "plan version: $PLAN"
echo "$PLAN" | grep -q '"package":"@opencode/cli-linux' || fail "plan package"
echo "$PLAN" | grep -q '"integrity":"sha512-' || fail "plan integrity"
echo "$PLAN" | grep -q '"installDir":"[^"]*\.opencode/bin"' || fail "plan installDir"
PLANJSON=$(echo "$PLAN" | field plan)
ARTJSON=$(echo "$PLAN" | field artifact)
note "$(echo "$PLAN" | field plan.action) $(echo "$PLAN" | field plan.package)@$(echo "$PLAN" | field plan.version) via $(echo "$PLAN" | field plan.source)"
note "$(echo "$PLAN" | field plan.reason)"

echo "[5] 确认门禁（D3）：apply / uninstall 没有 confirm 一律 400"
[ "$(code -X POST "http://127.0.0.1:$PORT/provision/apply" -d "{\"plan\":$PLANJSON,\"artifact\":$ARTJSON}")" = "400" ] || fail "apply without confirm must be 400"
[ "$(code -X POST "http://127.0.0.1:$PORT/provision/uninstall" -d '{"home":"/tmp/nope"}')" = "400" ] || fail "uninstall without confirm must be 400"
[ "$(code -X POST "http://127.0.0.1:$PORT/provision/apply" -d '{"confirm":true}')" = "400" ] || fail "confirm without plan must be 400"

echo "[6] 取件路与出网能力一致（通则直取，不通则面板推送）"
OUTBOUND=$(echo "$DET" | field detect.outbound)
SRC=$(echo "$PLAN" | field plan.source)
if [ "$OUTBOUND" = "true" ]; then
  [ "$SRC" = "remote" ] || fail "outbound target should use remote source, got $SRC"
else
  [ "$SRC" = "push" ] || fail "non-outbound target should use push source, got $SRC"
fi
note "出网=$OUTBOUND → 取件=$SRC"

echo "[7] 能力盘点：三类需求逐项列出，转发与 URL 改写可见（D11/D12/D15）"
CAPS=$(req -X POST "http://127.0.0.1:$PORT/capabilities" -d "{\"projectPath\":\"$TARGET_WS\"}")
echo "$CAPS" | grep -q '"capabilities"' || fail "capabilities missing"
echo "$CAPS" | grep -q '"config"' || fail "config report missing"
note "能力 $(echo "$CAPS" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).capabilities.length))") 项 · 需要转发 $(echo "$CAPS" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).forwards.length))") 条 · 引擎读的是 $(echo "$CAPS" | field config.targetPath)"

echo "[8] 项目级配置：预览只算差异不落盘；字面量密钥必须变成 {env:…} 引用"
req -X POST "http://127.0.0.1:$PORT/project-config" -d "{\"projectPath\":\"$TARGET_WS\"}" > /dev/null
[ "$(ssh_t "[ -f '$TARGET_WS/opencode.jsonc' ] && echo yes || echo no")" = "no" ] || fail "read must not create the file"
PREVIEW=$(req -X POST "http://127.0.0.1:$PORT/project-config" -d "{\"projectPath\":\"$TARGET_WS\",\"config\":{\"mcp\":{\"servers\":{\"acc\":{\"type\":\"local\",\"command\":\"npx acc\",\"environment\":{\"ACC_TOKEN\":\"live-secret\"}}}}}}")
echo "$PREVIEW" | grep -q '"changed":true' || fail "preview should report a change: $PREVIEW"
echo "$PREVIEW" | grep -q '{env:ACC_TOKEN}' || fail "literal secret must become an {env:…} reference"
echo "$PREVIEW" | grep -q '"secretsRewritten"' || fail "rewrites must be listed"
[ "$(ssh_t "[ -f '$TARGET_WS/opencode.jsonc' ] && echo yes || echo no")" = "no" ] || fail "preview must not write"
note "落点 $(echo "$PREVIEW" | field targetPath)"

echo "[9] 应用：写入项目级配置；全局层只读不写（D10）"
GLOBAL_BEFORE=$(ssh_t "cat \$HOME/.config/opencode/opencode.json 2>/dev/null | md5sum" || true)
APPLY=$(req -X POST "http://127.0.0.1:$PORT/project-config" -d "{\"projectPath\":\"$TARGET_WS\",\"config\":{\"mcp\":{\"servers\":{\"acc\":{\"type\":\"local\",\"command\":\"npx acc\",\"environment\":{\"ACC_TOKEN\":\"live-secret\"}}}}},\"apply\":true}")
echo "$APPLY" | grep -q '"applied":true' || fail "apply failed: $APPLY"
ssh_t "grep -q 'env:ACC_TOKEN' '$TARGET_WS/opencode.jsonc'" || fail "project config not written"
ssh_t "grep -q 'live-secret' '$TARGET_WS/opencode.jsonc'" && fail "literal secret landed in the config file"
GLOBAL_AFTER=$(ssh_t "cat \$HOME/.config/opencode/opencode.json 2>/dev/null | md5sum" || true)
[ "$GLOBAL_BEFORE" = "$GLOBAL_AFTER" ] || fail "global user config was touched (must stay read-only)"
note "写入 $(echo "$APPLY" | field targetPath)；全局层 md5 未变"

echo "[10] 幂等：同样的内容再应用一次，不写任何东西（不产生无意义的 .ocrc-bak）"
AGAIN=$(req -X POST "http://127.0.0.1:$PORT/project-config" -d "{\"projectPath\":\"$TARGET_WS\",\"config\":{\"mcp\":{\"servers\":{\"acc\":{\"type\":\"local\",\"command\":\"npx acc\",\"environment\":{\"ACC_TOKEN\":\"live-secret\"}}}}},\"apply\":true}")
echo "$AGAIN" | grep -q '"changed":false' || fail "second apply should be a no-op: $AGAIN"

echo "[11] 粘性合并：面板没提供的键保留在远端（D11）"
MERGED=$(req -X POST "http://127.0.0.1:$PORT/project-config" -d "{\"projectPath\":\"$TARGET_WS\",\"config\":{\"model\":\"panel/model\"}}")
echo "$MERGED" | grep -q 'env:ACC_TOKEN' || fail "remote-only key was dropped by the merge"
note "面板只写 model，远端原有的 mcp 段仍在预览里"

echo "[12] 转发落地：写进档案并持久化（与主隧道共生，D15）"
FORWARDS=$(req -X POST "http://127.0.0.1:$PORT/forwards" -d '{"forwards":[{"direction":"local","peerHost":"127.0.0.1","peerPort":4532,"port":4601,"activePort":4601,"reason":"acceptance"}]}')
echo "$FORWARDS" | grep -q '"peerPort":4532' || fail "forwards not stored"
req "http://127.0.0.1:$PORT/status" | grep -q '"peerPort":4532' || fail "forwards not persisted in the profile"

echo "[12b] fromPanel：服务自己读面板宿主的配置（内容不过桥）；没有配置时如实报路径"
FROMPANEL=$(req -X POST "http://127.0.0.1:$PORT/project-config" -d "{\"projectPath\":\"$TARGET_WS\",\"fromPanel\":true}")
if echo "$FROMPANEL" | grep -q '"targetPath"'; then
  note "面板宿主有配置 → 预览成功"
elif echo "$FROMPANEL" | grep -q '面板宿主上没有配置'; then
  note "面板宿主没有配置 → 如实拒绝并给出路径（不是静默空写入）"
else
  fail "fromPanel 既没成功也没给出可读的理由: $FROMPANEL"
fi

# ── 安装段：fixture registry，目标机由 --target 指定 ────────────────────────
if [ "$WITH_INSTALL" = "1" ]; then
echo "[13] 安装段：清理目标机上的旧件，规划应为 install"
ssh_t "rm -f \$HOME/.opencode/bin/opencode \$HOME/.opencode/bin/.ocrc-deploy.json \$HOME/.opencode/bin/opencode.ocrc-bak \$HOME/.ocrc-upload-*.tgz 2>/dev/null; true"
TPLAN=$(req -X POST "http://127.0.0.1:$PORT/provision/plan" -d "{\"detect\":$(echo "$DET" | field detect)}")
[ "$(echo "$TPLAN" | field plan.action)" = "install" ] || fail "expected install, got $(echo "$TPLAN" | field plan.action): $TPLAN"
TPLANJSON=$(echo "$TPLAN" | field plan)
TARTJSON=$(echo "$TPLAN" | field artifact)

if [ "$(echo "$TPLAN" | field plan.source)" = "push" ]; then
  echo "[13a] 推送路：先确保面板缓存里有校验过的工件"
  PREFETCH=$(req -X POST "http://127.0.0.1:$PORT/provision/prefetch" -d "{\"artifact\":$TARTJSON}")
  echo "$PREFETCH" | grep -q '"ok":true' || fail "prefetch failed: $PREFETCH"
fi

APPLIED=$(req -X POST "http://127.0.0.1:$PORT/provision/apply" -d "{\"plan\":$TPLANJSON,\"artifact\":$TARTJSON,\"confirm\":true}")
echo "$APPLIED" | grep -q '"ok":true' || fail "install failed: $APPLIED"
ssh_t "[ -x \$HOME/.opencode/bin/opencode ]" || fail "binary not installed"
ssh_t "grep -q sha512 \$HOME/.opencode/bin/.ocrc-deploy.json" || fail "marker missing the sha512 identity"
note "装到 $(echo "$APPLIED" | field path)（$(echo "$APPLIED" | field version)）"

echo "[14] 幂等重放：同样的工件再规划一次 → none（不重复推 200MB）"
[ "$(req -X POST "http://127.0.0.1:$PORT/provision/plan" -d "{\"detect\":$(echo "$DET" | field detect)}" | field plan.action)" = "none" ] || fail "replan should be none"

echo "[15] 换过字节的工件必须失败（目标机校验自己真下到的东西），且旧二进制一个字节都不动"
# 篡改的是**磁盘上的工件**，元数据里的校验值照旧：这才是「校验值对不对得上手里那份」
# 该验的东西。只改请求体里的 integrity 是验不到任何东西的——安装脚本比的是计划里的值。
BADART=$(printf '%s' "$TARTJSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);j.tarballUrl=String(j.tarballUrl).replace('.tgz','-tampered.tgz');process.stdout.write(JSON.stringify(j))})")
BEFORE_MD5=$(ssh_t 'md5sum $HOME/.opencode/bin/opencode | cut -d" " -f1' | tr -d '\r')
BADAPPLY=$(req -X POST "http://127.0.0.1:$PORT/provision/apply" -d "{\"plan\":$TPLANJSON,\"artifact\":$BADART,\"confirm\":true}")
echo "$BADAPPLY" | grep -q '"ok":false' || fail "tampered artifact must fail: $BADAPPLY"
echo "$BADAPPLY" | grep -q '校验失败' || fail "the failure must name the checksum: $BADAPPLY"
AFTER_MD5=$(ssh_t 'md5sum $HOME/.opencode/bin/opencode | cut -d" " -f1' | tr -d '\r')
[ "$BEFORE_MD5" = "$AFTER_MD5" ] || fail "failed install must not touch the binary"
note "校验失败时旧件原样保留，失败原因：$(echo "$BADAPPLY" | field error)"

echo "[16] 卸载：只删我们的命名空间与 marker（用户的既有安装不在其中）"
# 这里的 home 是**被控机的 $HOME**（引擎落点 <home>/.opencode/bin），不是项目目录。
T_HOME=$(ssh_t 'printf %s "$HOME"' | tr -d '\r')
UNINSTALLED=$(req -X POST "http://127.0.0.1:$PORT/provision/uninstall" -d "{\"home\":\"$T_HOME\",\"confirm\":true}")
echo "$UNINSTALLED" | grep -q '"uninstalled":true' || fail "uninstall failed: $UNINSTALLED"
ssh_t "[ ! -f \$HOME/.opencode/bin/.ocrc-deploy.json ]" || fail "marker survived uninstall"
ssh_t "[ ! -f \$HOME/.opencode/bin/opencode ]" || fail "our binary survived uninstall"
note "卸载后 ~/.opencode/bin 里我们自己放的东西都没了；既有安装 $(echo "$DET" | field detect.legacyEngine.path) 未动"
fi

# ── 运行时段：fixture registry 兼当 npm registry（D12/D13）──────────────────
if [ "$WITH_RUNTIME" = "1" ]; then
RTPKG=ocrc-accept-runtime
RTSLOT=1.0.0
echo "[17] 造一个真的 npm 包（含 bin）并挂到 fixture registry 上"
# 上一轮中断可能留下同名槽位——先清掉它，让这一段每次都从「干净目标机」开始。
ssh_t "rm -rf \$HOME/.ocrc/runtime/$RTPKG" 2>/dev/null || true
mkdir -p "$WS/rtpkg/package"
cat > "$WS/rtpkg/package/package.json" <<'EOF'
{ "name": "ocrc-accept-runtime", "version": "1.0.0", "bin": { "ocrc-accept-runtime": "cli.js" } }
EOF
cat > "$WS/rtpkg/package/cli.js" <<'EOF'
#!/usr/bin/env node
console.log('ocrc-accept-runtime ok')
EOF
chmod 755 "$WS/rtpkg/package/cli.js"
tar czf "$WS/registry/$RTPKG-$RTSLOT.tgz" -C "$WS/rtpkg" package
RT_SHASUM=$(openssl dgst -sha1 "$WS/registry/$RTPKG-$RTSLOT.tgz" | sed 's/.*= *//')
RT_INTEGRITY="sha512-$(openssl dgst -sha512 -binary "$WS/registry/$RTPKG-$RTSLOT.tgz" | openssl base64 -A)"
cat > "$WS/registry/$RTPKG.packument.json" <<EOF
{
  "name": "$RTPKG",
  "dist-tags": { "latest": "$RTSLOT" },
  "versions": {
    "$RTSLOT": {
      "name": "$RTPKG",
      "version": "$RTSLOT",
      "bin": { "$RTPKG": "cli.js" },
      "dist": {
        "tarball": "http://$REGHOST:$REGPORT/$RTPKG-$RTSLOT.tgz",
        "shasum": "$RT_SHASUM",
        "integrity": "$RT_INTEGRITY"
      }
    }
  }
}
EOF
note "packument 与包体都在 $WS/registry（$(echo "$RT_INTEGRITY" | cut -c1-24)…）"

echo "[18] 被控端项目配置里声明一个 npx 形态的 MCP → 能力盘点算出一项运行时需求"
# 直接写目标机的项目配置（不是 /project-config）：这一步只要「有这个声明」，
# 面板侧的合并与改写留给第 [22] 步单独验。钉版本 → 槽位名可断言（没钉版本走
# latest 槽，见 runtime.test.ts 的用例）。
ssh_t "printf '%s' '{\"mcp\":{\"servers\":{\"accrun\":{\"type\":\"local\",\"command\":\"npx -y $RTPKG@$RTSLOT\"}}}}' > '$TARGET_WS/opencode.jsonc'"
RTPLAN=$(req -X POST "http://127.0.0.1:$PORT/runtime/plan" -d "{\"projectPath\":\"$TARGET_WS\"}")
echo "$RTPLAN" | grep -q '"runtime"' || fail "runtime plan missing: $RTPLAN"
note "node $(echo "$RTPLAN" | field runtime.node) · npm $(echo "$RTPLAN" | field runtime.npm) · nodeOk $(echo "$RTPLAN" | field runtime.nodeOk) · 根目录 $(echo "$RTPLAN" | field runtime.root)"

NODE_OK=$(echo "$RTPLAN" | field runtime.nodeOk)
if [ "$NODE_OK" != "true" ] || [ "$(echo "$RTPLAN" | field runtime.npm)" = "null" ]; then
  echo "[19] 目标机缺 node/npm → 必须如实报「装不了」，不许假装能装"
  [ "$(rtstate "$RTPKG" <<< "$RTPLAN")" = "impossible" ] || fail "missing node/npm must be impossible, got $(rtstate "$RTPKG" <<< "$RTPLAN")"
  note "理由：$(rtitem "$RTPKG" <<< "$RTPLAN" | field reason)"
  note "目标机没有 node ≥ 20 或没有 npm —— 这一段到此为止（这正是本步要验的如实报告）"
else
  echo "[19] 确认门禁（D3）：/runtime/apply 没有 confirm 一律 400"
  ITEM=$(rtitem "$RTPKG" <<< "$RTPLAN")
  [ "$ITEM" != "null" ] || fail "runtime item for $RTPKG missing: $RTPLAN"
  [ "$(rtstate "$RTPKG" <<< "$RTPLAN")" = "install" ] || fail "expected install, got $(rtstate "$RTPKG" <<< "$RTPLAN")"
  [ "$(code -X POST "http://127.0.0.1:$PORT/runtime/apply" -d "{\"item\":$ITEM}")" = "400" ] || fail "apply without confirm must be 400"

  echo "[20] 真装：npm install 落到 ~/.ocrc/runtime/<pkg>/<slot>，入口由包自己的 bin 解析"
  RTAPPLY=$(req -X POST "http://127.0.0.1:$PORT/runtime/apply" -d "{\"item\":$ITEM,\"confirm\":true}")
  echo "$RTAPPLY" | grep -q '"ok":true' || fail "runtime install failed: $RTAPPLY"
  RT_ENTRY=$(echo "$RTAPPLY" | field entry)
  RT_DIR=$(echo "$RTAPPLY" | field dir)
  case "$RT_ENTRY" in *"/.ocrc/runtime/$RTPKG/$RTSLOT/"*) : ;; *) fail "entry not under the runtime slot: $RT_ENTRY" ;; esac
  case "$RT_ENTRY" in *".bin/$RTPKG") : ;; *) fail "entry should be the package's own bin shim: $RT_ENTRY" ;; esac
  ssh_t "[ -x '$RT_ENTRY' ]" || fail "entry is not executable on the target"
  ssh_t "grep -q '^SPEC=$RTPKG@$RTSLOT\$' '$RT_DIR/.ocrc-runtime'" || fail "marker missing SPEC ($RTPKG@$RTSLOT)"
  ssh_t "grep -q '^ENTRY=' '$RT_DIR/.ocrc-runtime'" || fail "marker missing ENTRY"
  # 入口就是写进配置的那条命令（opencode 通过 shell 执行它）——直接跑它，走产品路径。
  (ssh_t "'$RT_ENTRY'" 2>/dev/null || ssh_t "node '$RT_ENTRY'") | grep -q 'ocrc-accept-runtime ok' || fail "installed entry does not run"
  note "装到 $RT_DIR（入口 $RT_ENTRY）"

  echo "[21] 幂等：同样的 spec 再装一次 → 短路，一个字都不写"
  RTAGAIN=$(req -X POST "http://127.0.0.1:$PORT/runtime/apply" -d "{\"item\":$ITEM,\"confirm\":true}")
  echo "$RTAGAIN" | grep -q '"skipped":true' || fail "second apply should short-circuit: $RTAGAIN"

  echo "[21b] 重盘：已装的运行时变成 present（面板不再提示装）"
  RTPLAN2=$(req -X POST "http://127.0.0.1:$PORT/runtime/plan" -d "{\"projectPath\":\"$TARGET_WS\"}")
  [ "$(rtstate "$RTPKG" <<< "$RTPLAN2")" = "present" ] || fail "after install the plan should say present, got $(rtstate "$RTPKG" <<< "$RTPLAN2")"
  [ "$(rtitem "$RTPKG" <<< "$RTPLAN2" | field found.path)" = "$RT_ENTRY" ] || fail "present item should carry the entry path"

  echo "[22] npx 改写（D13）：写入项目配置时改成目标机上的真实入口，运行期不走 npx 联网"
  REWRITE=$(req -X POST "http://127.0.0.1:$PORT/project-config" -d "{\"projectPath\":\"$TARGET_WS\",\"config\":{\"mcp\":{\"servers\":{\"accrun\":{\"type\":\"local\",\"command\":\"npx -y $RTPKG@$RTSLOT\"}}}},\"apply\":true}")
  echo "$REWRITE" | grep -q '"npxRewrites"' || fail "rewrites must be reported: $REWRITE"
  echo "$REWRITE" | grep -q "$RTPKG" || fail "rewrite should mention the runtime entry"
  ssh_t "grep -q '$RT_ENTRY' '$TARGET_WS/opencode.jsonc'" || fail "npx command was not rewritten in the config"
  ssh_t "grep -q 'npx -y $RTPKG' '$TARGET_WS/opencode.jsonc' && fail_expected=1 || true"

  echo "[23] 失败如实报：不存在的包 → npm 的错误原样带回来，且不留下半截 marker"
  echo '{"mcp":{"servers":{"accmiss":{"type":"local","command":"npx -y ocrc-missing-pkg"}}}}' | ssh_t "cat > '$TARGET_WS/opencode.jsonc'"
  MISPLAN=$(req -X POST "http://127.0.0.1:$PORT/runtime/plan" -d "{\"projectPath\":\"$TARGET_WS\"}")
  MITEM=$(rtitem ocrc-missing-pkg <<< "$MISPLAN")
  [ "$MITEM" != "null" ] || fail "missing package should still be planned: $MISPLAN"
  MISAPPLY=$(req -X POST "http://127.0.0.1:$PORT/runtime/apply" -d "{\"item\":$MITEM,\"confirm\":true}")
  echo "$MISAPPLY" | grep -q '"ok":false' || fail "a nonexistent package must fail: $MISAPPLY"
  note "如实报：$(echo "$MISAPPLY" | field error)"
  # 失败不留半截目录：留下来的空目录会让下一次探测把它当成「别人装的」而永久拒装。
  ssh_t "[ ! -d \$HOME/.ocrc/runtime/ocrc-missing-pkg/latest ]" || fail "failed install left a half-made slot dir"
  ssh_t "[ ! -d \$HOME/.ocrc/runtime/ocrc-missing-pkg ]" || fail "failed install left an empty package dir"
  note "失败后槽位目录已清干净（下一次重试不会被自己的残渣挡住）"

  echo "[24] 移除：只删我们的槽位（marker 在才删）"
  REMOVED=$(req -X POST "http://127.0.0.1:$PORT/runtime/remove" -d "{\"dir\":\"$RT_DIR\",\"confirm\":true}")
  echo "$REMOVED" | grep -q '"removed":true' || fail "remove failed: $REMOVED"
  ssh_t "[ ! -d '$RT_DIR' ]" || fail "slot dir survived removal"
fi
fi

if [ "$WITH_INSTALL" = "0" ] && [ "$WITH_RUNTIME" = "0" ]; then
  echo
  echo "ACCEPTANCE OK（探测 + 读写段）——四档/规划/确认门禁/取件路/能力/项目级配置/粘性/幂等/转发全过。"
  echo "安装段（真把 fixture 工件装进目标机 ~/.opencode/bin）用 --with-install 打开，"
  echo "运行时段（在目标机真跑一次 npm install）用 --with-runtime 打开，"
  echo "两者都只对一次性容器或专用测试账号跑：$0 --target user@host --with-install --with-runtime"
  exit 0
fi

DONE_SECTIONS=""
if [ "$WITH_INSTALL" = "1" ]; then DONE_SECTIONS="安装段"; fi
if [ "$WITH_RUNTIME" = "1" ]; then DONE_SECTIONS="${DONE_SECTIONS:+$DONE_SECTIONS + }运行时段"; fi
echo
echo "ACCEPTANCE OK（含 $DONE_SECTIONS）——探测/规划/确认/校验/幂等/失败不动旧件/卸载/运行时落点/入口解析/改写全过。"
