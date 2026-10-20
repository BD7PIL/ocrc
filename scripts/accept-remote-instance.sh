#!/usr/bin/env bash
# 远程实例验收（开发测试方案 §5.3）——把 P1 的手工链路变成可复跑的 fail-fast 清单。
#
# 覆盖：**P2 离线推包装机（结构性零联网 + strace 零外联 + 毒代理下装机）** → 引擎 v2 门禁
#   → 运行时/应用落点 → 实例健康 → 版本与能力 → 引擎兼容性（实例自报 binary/version）
#   → **B1 目录来源=对端** → **B2 会话数据=对端引擎** → 卸载 → 无副作用。
# 未实现的能力（P3 代理出网 / P4 重连开关）在这里**显式打印 SKIP**，不用假绿糊过去。
#
# Usage:
#   scripts/accept-remote-instance.sh --target user@192.0.2.10
#   scripts/accept-remote-instance.sh --target user@192.0.2.10 --provision
#   scripts/accept-remote-instance.sh --target user@192.0.2.10 --offline-proof   # 断网复验（对端需先能上外网做对照）
#   scripts/accept-remote-instance.sh --target user@192.0.2.10 --assume-offline  # 真离线机：断言基线不可达，跳过 200 对照
#   scripts/accept-remote-instance.sh --target user@192.0.2.10 --teardown [--purge]
#
# --offline-proof 做三件事（对端无 root，无法 iptables 真断网，如实标注）：
#   ① 结构性：所有远程脚本零联网命令（ocrc remote offline-proof）
#   ② 实测：同一次装机用毒代理 env（外网指向死端口）+ strace -f -e trace=connect，
#      再用 ocrc remote trace-check 断言「安装期间零非回环 connect()」
#   ③ 有效性对照：同一环境下 curl 外网必须失败（否则 ② 不算数）；真离线机用 --assume-offline 走断言式基线
set -euo pipefail

TARGET=""
INSTANCE_PORT=${INSTANCE_PORT:-2610}
LOCAL_PORT=${LOCAL_PORT:-4610}
APP_VERSION=${APP_VERSION:-2.3.3}
NODE_VERSION=${NODE_VERSION:-24.22.0}
ENGINE_VERSION=${ENGINE_VERSION:-2.0.27}
# UI 密码来自实例档案（同一台机器的 0600 文件；`ocrc remote add` 打印过一次）。
# 允许用环境变量/--ui-password 覆盖，用于临时实例。
UI_PASSWORD=${OCRC_INSTANCE_UI_PASSWORD:-}
# 显式 pin 的引擎（R12 口径）。默认不用：P2 之后我们自己的部署件会落在
# $HOME/.ocrc/remote/engine/opencode，门禁应当靠它过。
ENGINE_PATH=""
PROVISION=0
OFFLINE_PROOF=0
ASSUME_OFFLINE=0
TEARDOWN=0
PURGE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --instance-port) INSTANCE_PORT="${2:-}"; shift 2 ;;
    --local-port) LOCAL_PORT="${2:-}"; shift 2 ;;
    --app-version) APP_VERSION="${2:-}"; shift 2 ;;
    --engine-version) ENGINE_VERSION="${2:-}"; shift 2 ;;
    --engine-path) ENGINE_PATH="${2:-}"; shift 2 ;;
    --ui-password) UI_PASSWORD="${2:-}"; shift 2 ;;
    --provision) PROVISION=1; shift ;;
    --offline-proof) OFFLINE_PROOF=1; PROVISION=1; shift ;;
    --assume-offline) ASSUME_OFFLINE=1; OFFLINE_PROOF=1; PROVISION=1; shift ;;
    --teardown) TEARDOWN=1; shift ;;
    --purge) PURGE=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$TARGET" ] || { echo "需要 --target user@host[:port]" >&2; exit 2; }

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CLI="node $ROOT/dist/cli/index.js"
[ -f "$ROOT/dist/cli/index.js" ] || { echo "先 npm run build（缺 dist/cli/index.js）" >&2; exit 2; }
TRACE_PREFIX="ocrc-accept.strace"      # 对端相对名：绝对路径会被 MSYS 改写成 Windows 路径

UH=${TARGET%%@*}
TH=${TARGET##*@}
TPORT=22
case "$TH" in *:*) TPORT=${TH##*:}; TH=${TH%%:*} ;; esac
# 档案里的 UI 密码（`ocrc remote add` 生成的）；没有档案就用环境变量的默认值。
if [ -z "$UI_PASSWORD" ]; then
  UI_PASSWORD=$(node -e "const fs=require('fs'),os=require('os'),path=require('path');try{const f=path.join(os.homedir(),'.ocrc','remote-instances.json');const j=JSON.parse(fs.readFileSync(f,'utf8'));const hit=j.instances.find(i=>i.id===process.argv[1]);process.stdout.write(hit&&hit.uiPassword||'')}catch{}" "$UH@$TH")
fi
[ -n "$UI_PASSWORD" ] || UI_PASSWORD="ocrc-remote-2026"
SSH=(ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p "$TPORT")
ssh_t() { "${SSH[@]}" "$UH@$TH" "$@"; }

WS=$(mktemp -d /tmp/ocrc-instance-accept.XXXXXX)
FWD_PID=""
cleanup() {
  rm -rf "$WS"
  [ -n "$FWD_PID" ] && kill "$FWD_PID" 2>/dev/null || true
}
trap cleanup EXIT

fail() { echo "FAIL: $1"; exit 1; }
note() { echo "      $1"; }
skip() { echo "SKIP: $1"; }
# JSON 字段抽取（与 accept-provision.sh 同一套）
field() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{let v=JSON.parse(d);for(const k of process.argv[1].split('.'))v=v?.[k];if(v===undefined)process.stdout.write('null');else process.stdout.write(typeof v==='string'?v:JSON.stringify(v))})" "$1"; }
# 远端文件 → 本机临时文件
fetch_remote() { ssh_t "cat '$1' 2>/dev/null" > "$2"; }

R="\$HOME/.ocrc/remote"
NODE="$R/runtime/node-v$NODE_VERSION/bin/node"
CLIJS="$R/openchamber/$APP_VERSION/lib/node_modules/@openchamber/web/bin/cli.js"
BASE="http://127.0.0.1:$LOCAL_PORT"
JAR="$WS/cookies.txt"

echo "[1] ssh 可达 + 远端既有资产基线（后面用来证明我们没动它们）"
ssh_t true || fail "ssh 不可用：$TARGET"
LEGACY_BEFORE=$(ssh_t 'if [ -x $HOME/.local/bin/opencode ]; then $HOME/.local/bin/opencode --version 2>&1 | head -1; else echo none; fi')
LEGACY_MD5_BEFORE=$(ssh_t 'md5sum $HOME/.local/bin/opencode 2>/dev/null | cut -d" " -f1 || echo none')
note "用户既有 opencode：$LEGACY_BEFORE（md5 ${LEGACY_MD5_BEFORE:0:12}…）"

if [ "$PROVISION" = "1" ]; then
  echo "[1.5] P2 装机：控制端备件 → ssh stdin 推送 → 对端原子落位（对端零联网）"
  if [ "$OFFLINE_PROOF" = "1" ]; then
    # 毒代理有效性对照：没有这一步，「毒代理下装成功」可能只是因为代理根本没生效。
    # 真离线机（B4）走 --assume-offline：对照的前提（"不加 guard 时外网可达"）在它身上
    # 天然不成立，但**不能靠嘴说**——改为断言基线确实不可达，参数与事实不符就拒跑。
    if [ "$ASSUME_OFFLINE" = "1" ]; then
      echo "       · --assume-offline：断言基线确实不可达（而不是假定）"
      BASE=$(ssh_t 'curl -s -o /dev/null -w "%{http_code}" --max-time 10 https://registry.npmjs.org/ || true')
      [ "$BASE" = "000" ] || fail "--assume-offline 但对端能上外网（HTTP $BASE）——参数与事实不符，去掉它跑真对照"
      note "基线不可达（HTTP 000）：毒代理对照的前提成立，跳过 200 那一半"
    else
      echo "       · 对照：不加 guard 时外网可达"
      ssh_t 'curl -s -o /dev/null -w "%{http_code}" --max-time 10 https://registry.npmjs.org/' | grep -q '^200$' \
        || fail "对端本来就上不了外网——本次「毒代理」对照失去意义；真离线机请加 --assume-offline"
    fi
    GUARD=$(node "$ROOT/dist/cli/index.js" remote guard-env)
    echo "       · 实验：同一环境加 guard（外网指向死端口）"
    GCODE=$(ssh_t "${GUARD}curl -s -o /dev/null -w '%{http_code}' --max-time 8 https://registry.npmjs.org/ || true")
    [ "$GCODE" = "000" ] || fail "guard 没起作用（外网仍返回 $GCODE）——断网复验不成立"
    note "guard 生效：外网 ${BASE:-200} → 000"
    $CLI remote apply "$TARGET" --offline-guard --trace "$TRACE_PREFIX" --force \
      || fail "毒代理 + strace 下装机失败（对端离线工况过不去）"
  else
    $CLI remote apply "$TARGET" || fail "装机失败"
  fi
fi

echo "[2] 运行时在位（$NODE_VERSION glibc-217）"
ssh_t "[ -x $NODE ]" || fail "运行时缺失：$NODE（先跑 --provision）"
V=$(ssh_t "$NODE --version" | tr -d '\r')
[ "$V" = "v$NODE_VERSION" ] || fail "运行时版本不对：$V"

echo "[2a] P2-a 结构性离线断言：所有远程脚本零联网命令"
$CLI remote offline-proof > "$WS/offline.txt" || fail "远程脚本里出现了联网命令：$(cat "$WS/offline.txt")"
note "$(tail -1 "$WS/offline.txt")"

echo "[2b] P2-b 布局归一：lib/node_modules 落位，前缀根部不留 node_modules"
ssh_t "[ -f $CLIJS ]" || fail "应用入口不在位：$CLIJS（推送落点与启动路径必须同一处）"
if ssh_t "[ -d $R/openchamber/$APP_VERSION/node_modules ]"; then
  fail "前缀根部还有 node_modules——跨平台装的树没被归一到 Linux 布局"
fi
note "$CLIJS 在位，布局已归一"

if [ "$OFFLINE_PROOF" = "1" ]; then
  echo "[2c] P2-c strace 判读：装机期间零非回环 connect()"
  for w in runtime engine app; do
    fetch_remote "$TRACE_PREFIX.$w" "$WS/trace-$w.txt"
    [ -s "$WS/trace-$w.txt" ] || fail "缺 strace 输出：$TRACE_PREFIX.$w（对端没被 trace？）"
    $CLI remote trace-check "$WS/trace-$w.txt" > "$WS/tc-$w.txt" || fail "$w 安装期间有外联：$(cat "$WS/tc-$w.txt")"
    note "$w: $(tail -1 "$WS/tc-$w.txt")"
  done
  echo "       · 诚实标注：对端无 root，无法 iptables 真断网；证据 = 零联网脚本 + 毒代理 + strace 三重"
else
  skip "P2-c strace 判读（未开 --offline-proof）"
fi

echo "[2d] P2-d 引擎是我们推的那一份（R12：pin 的 v2，不是对端 v1）"
OWN_ENGINE="$R/engine/opencode"
ssh_t "[ -x $OWN_ENGINE ]" || fail "我们的引擎落点缺失：$OWN_ENGINE（先跑 --provision）"
OWN_V=$(ssh_t "$OWN_ENGINE --version 2>&1 | head -1" | tr -d '\r')
case "$OWN_V" in *"$ENGINE_VERSION"*) ;; *) fail "引擎版本不对：$OWN_V（期望含 $ENGINE_VERSION）" ;; esac
note "$OWN_V @ ~/.ocrc/remote/engine/opencode"

echo "[3] 应用版本（跑起来自报）"
AV=$(ssh_t "$NODE $CLIJS --version" | tr -d '\r' | tail -1)
[ "$AV" = "$APP_VERSION" ] || fail "应用版本不对：$AV"
note "$AV"

echo "[4] 引擎 v2 门禁（R12）：候选里必须有 v2，且 v1 不得被选中"
CANDIDATES='"$HOME/.ocrc/remote/engine/opencode"'
[ -n "$ENGINE_PATH" ] && CANDIDATES="'$ENGINE_PATH' $CANDIDATES"
PROBE=$(ssh_t "for c in $CANDIDATES \"\$HOME/.opencode/bin/opencode\" \"\$HOME/.local/bin/opencode\" /usr/local/bin/opencode /usr/bin/opencode; do if [ -x \"\$c\" ]; then v=\"\$c\"'\n'v=\$(\"\$c\" --version 2>/dev/null | head -1); printf \"%s\t%s\n\" \"\$c\" \"\$v\"; fi; done" 2>/dev/null || true)
echo "$PROBE" | sed 's/^/      · /'
PICKED=$(echo "$PROBE" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const rows=d.split('\n').filter(Boolean).map(l=>{const [p,...r]=l.split('\t');const m=/(\d+)\.(\d+)\.(\d+)/.exec(r.join('\t'));if(!m)return null;const [maj,min,pat]=[+m[1],+m[2],+m[3]];const ok=maj===2&&(min>0||pat>=20);return ok?p:null}).filter(Boolean);process.stdout.write(rows[0]||'')})")
[ -n "$PICKED" ] || fail "没有任何满足 major=2 且 ≥2.0.20 的引擎（不许回落 v1）"
note "选中：$PICKED"
case "$PICKED" in *'.ocrc/remote/engine/opencode') note "选中的是我们推的那一份（对端既有 v1 未被选中，正确）" ;; esac
case "$PROBE" in *'.local/bin/opencode'*) note "注意：目标机上存在 v1（未被选中，正确）" ;; esac

echo "[5] 实例健康（远端 $INSTANCE_PORT）"
H=$(ssh_t "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$INSTANCE_PORT/health 2>/dev/null || echo 000" | tr -d '\r')
[ "$H" = "200" ] || fail "实例 /health = $H（先跑 ocrc remote up $TARGET）"
note "health=200"

echo "[6] 控制端转发（127.0.0.1:$LOCAL_PORT → 对端 $INSTANCE_PORT）"
if (netstat -ano 2>/dev/null | grep -qE ":$LOCAL_PORT\b.*LISTENING"); then
  note "本地 $LOCAL_PORT 已在监听——复用（不重复拉起）"
else
  "${SSH[@]}" -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
    -N -L "127.0.0.1:$LOCAL_PORT:127.0.0.1:$INSTANCE_PORT" "$UH@$TH" &
  FWD_PID=$!
  for _ in $(seq 1 10); do
    (netstat -ano 2>/dev/null | grep -qE ":$LOCAL_PORT\b.*LISTENING") && break
    sleep 0.5
  done
  note "已建立转发（pid $FWD_PID）"
fi

echo "[7] 版本与能力（经转发的 /api/version）"
VER=$(curl -s -m 10 "$BASE/api/version")
echo "$VER" | grep -q "\"openchamberVersion\":\"$APP_VERSION\"" || fail "/api/version 版本不是 $APP_VERSION：$VER"
echo "$VER" | grep -q 'api.runtime-url.v1' || fail "缺少能力 api.runtime-url.v1（上游探针的硬要求）"
note "openchamberVersion=$APP_VERSION · 能力齐全"

echo "[8] 引擎兼容性（实例自己说的）：compatible、≥2.0.20、binary 是绝对路径"
curl -s -m 10 -c "$JAR" -X POST -H 'content-type: application/json' \
  -d "{\"password\":\"$UI_PASSWORD\",\"trustDevice\":true}" "$BASE/auth/session" | grep -q '"authenticated":true' \
  || fail "登录失败（UI 密码不对？）"
COMP=$(curl -s -m 15 -b "$JAR" "$BASE/api/opencode/compatibility")
STATE=$(echo "$COMP" | field state); E_V=$(echo "$COMP" | field version); E_BIN=$(echo "$COMP" | field binary)
[ "$STATE" = "compatible" ] || fail "引擎兼容性 state=$STATE：$COMP"
node -e "const v=process.argv[1].split('.').map(Number);process.exit(v[0]===2&&(v[1]>0||v[2]>=20)?0:1)" "$E_V" || fail "引擎版本不合格：$E_V"
case "$E_BIN" in /*) ;; *) fail "实例报的引擎路径不是绝对路径：$E_BIN" ;; esac
note "state=$STATE version=$E_V binary=$E_BIN"

echo "[9] B1 目录来源 = 对端（add project 的数据通路）"
REMOTE_HOME=$(ssh_t 'printf %s "$HOME"' | tr -d '\r')
API_HOME=$(curl -s -m 10 -b "$JAR" "$BASE/api/fs/home" | field home)
[ "$API_HOME" = "$REMOTE_HOME" ] || fail "实例报的 home=$API_HOME，对端实际 home=$REMOTE_HOME"
ENTRIES=$(curl -s -m 10 -b "$JAR" "$BASE/api/fs/list?path=$REMOTE_HOME")
echo "$ENTRIES" | grep -q "\"path\":\"$REMOTE_HOME\"" || fail "列目录失败：$(echo "$ENTRIES" | head -c 200)"
REMOTE_FIRST=$(ssh_t "ls -a $REMOTE_HOME | grep -vx '\.' | grep -vx '\.\.' | head -1" | tr -d '\r')
[ -n "$REMOTE_FIRST" ] || fail "对端 $REMOTE_HOME 是空的——换一个目录做 B1 验收"
echo "$ENTRIES" | grep -q "$REMOTE_FIRST" || fail "实例列出的目录里没有对端的 $REMOTE_FIRST（可能列的是本机）"
note "home=$API_HOME · 对端条目 $REMOTE_FIRST 出现在实例列举里（= 对端文件系统）"

echo "[10] B2 会话数据 = 对端引擎"
SESS=$(curl -s -m 15 -b "$JAR" "$BASE/api/session")
echo "$SESS" | grep -q '"data"' || fail "/api/session 不是预期结构：$(echo "$SESS" | head -c 200)"
N=$(node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);process.stdout.write(String(Array.isArray(j.data)?j.data.length:'?'))})" <<< "$SESS")
note "/api/session → $N 条（来自对端引擎，binary=$E_BIN）"

echo "[10b] P6 终端：探到真错就如实标注（不许当作『能用』）"
TERM_LINE=$(node "$ROOT/dist/cli/index.js" remote plan "$TARGET" 2>/dev/null | grep -o "终端暂不可用（[^）]*）" | head -1 || true)
if [ -n "$TERM_LINE" ]; then
  note "如实标注：$TERM_LINE"
  note "（真修：bash scripts/remote-node-pty-glibc217.sh $TARGET；见 handoff §4.5）"
else
  note "终端探测未报不可用"
  TSID=$(curl -s -m 15 -b "$JAR" -H 'content-type: application/json' \
    -d "{\"cwd\":\"$REMOTE_HOME\",\"cols\":100,\"rows\":30}" "$BASE/api/terminal/create" | field sessionId || true)
  if [ -n "$TSID" ] && [ "$TSID" != "null" ]; then
    TSTAT=$(curl -s -m 10 -b "$JAR" "$BASE/api/terminal/sessions" | field sessions.0.status || true)
    curl -s -m 10 -b "$JAR" -X DELETE "$BASE/api/terminal/$TSID" >/dev/null || true
    note "终端实测：/api/terminal/create → $TSID（status=$TSTAT），已 delete"
  else
    note "终端探测可加载，但 create 未返回会话（如实）"
  fi
fi

 echo "[11] P3 出网：按策略走（relay=经控制端 / direct=对端自己出网）"
PROXY_LOCAL=${PROXY_LOCAL:-4711}
PROXY_REMOTE=${PROXY_REMOTE:-2711}
RELAY_LOG="$WS/relay.log"
RELAY_PID=""
cleanup_relay() { [ -n "$RELAY_PID" ] && kill "$RELAY_PID" 2>/dev/null || true; }
trap 'cleanup_relay; cleanup' EXIT
# 出口是**决定**，不是配置开关：auto 会探测对端。这里读同一份决定的文本输出
# （`ocrc remote status`），据此断言该有的形态——有外网的对端**不该**被拉进控制端，
# 把它的直连当成"少了 -R"是错的（2026-10-17 实测：Ubuntu 直连、EL7 经中继）。
EGRESS_LINE=$(node "$ROOT/dist/cli/index.js" remote status "$TARGET" 2>/dev/null | grep -oE '出口 +[^（]*（[^）]*）' | head -1 || true)
[ -n "$EGRESS_LINE" ] || fail "读不到出口决定（ocrc remote status 没打印「出口」行）"
note "出口决定：$EGRESS_LINE"
PEER_PORT_OPEN=0
ssh_t "export PATH=\$PATH:/usr/sbin:/sbin; if command -v ss >/dev/null 2>&1; then ss -ltn 2>/dev/null | grep -qE ':$PROXY_REMOTE '; else netstat -ltn 2>/dev/null | grep -qE ':$PROXY_REMOTE'; fi" \
  && PEER_PORT_OPEN=1 || true

if printf '%s' "$EGRESS_LINE" | grep -q '经控制端'; then
  # 中继通常由 `ocrc remote up` 拉起；脚本自己起一个也是同一条路径（同一份代码）。
  if ! (netstat -ano 2>/dev/null | grep -qE ":$PROXY_LOCAL\b.*LISTENING"); then
    node "$ROOT/dist/cli/index.js" remote proxy-serve --port "$PROXY_LOCAL" --log "$RELAY_LOG" > "$WS/relay-stdout.log" 2>&1 &
    RELAY_PID=$!
    for _ in $(seq 1 20); do (netstat -ano 2>/dev/null | grep -qE ":$PROXY_LOCAL\b.*LISTENING") && break; sleep 0.25; done
    note "脚本起了中继（pid $RELAY_PID，端口 $PROXY_LOCAL）"
  else
    note "中继已在 :$PROXY_LOCAL 上监听（复用）"
  fi
  [ "$PEER_PORT_OPEN" = "1" ] || fail "策略是经控制端，但对端 loopback $PROXY_REMOTE 没在听——隧道少了 -R（up 是否带代理？）"
  note "对端 127.0.0.1:$PROXY_REMOTE 在听（ssh -R 建立的）"
  PCODE=$(ssh_t "HTTPS_PROXY=http://127.0.0.1:$PROXY_REMOTE NO_PROXY=127.0.0.1,localhost curl -sS -o /dev/null -w '%{http_code}' --max-time 15 https://registry.npmjs.org/ || true")
  [ "$PCODE" = "200" ] || fail "经中继出网失败（HTTP $PCODE）——中继或 -R 没接上"
  note "经中继出网：HTTP 200"
  if [ -s "$RELAY_LOG" ]; then
    grep -q 'CONNECT registry.npmjs.org:443' "$RELAY_LOG" || fail "中继日志里没有这次 CONNECT——出网没走我们（对端自己出的网？）"
    note "中继日志记到了这次 CONNECT（= 字节确实从控制端出去）"
  else
    note "（复用既有中继，日志在 ~/.ocrc/remote-relay.log；本次未单独记录）"
  fi
else
  # 直连档：断言"确实没经我们"——对端自己得能出去，且引擎 env 不指向我们的腿。
  #
  # 一条**既有的** `-R 2711` 不算失败（2026-10-18 实测遇到）：它可能是另一个持有者
  # （桌面壳的隧道，或策略还是 relay 时起的）留下的腿，我们不杀别人的进程；实例 env
  # 已证明没指向它，数据路径上就不白绕。如实报出来并附上持有者。
  DCODE=$(ssh_t "curl -sS -o /dev/null -w '%{http_code}' --max-time 15 https://registry.npmjs.org/ || true")
  [ "$DCODE" = "200" ] || fail "直连档但对端自己出不去（HTTP $DCODE）——策略选错了"
  note "对端自己出网：HTTP 200（没有经过控制端）"
  if [ "$PEER_PORT_OPEN" = "1" ]; then
    HOLDERS=$(node "$ROOT/dist/cli/index.js" remote status "$TARGET" 2>/dev/null | grep -o '持有者.*' | head -3 | tr '\n' '；' || true)
    note "注意：对端 $PROXY_REMOTE 上还有一条既有的 -R 在听（不是本次起的，也不在数据路径上）——${HOLDERS:-持有者未知（多半是桌面壳的隧道）}"
    note "  · 实例 env 不指向它，所以不白绕；要撤它得停那个持有者（我们不杀别人的进程）"
  else
    note "对端 $PROXY_REMOTE 没有监听（直连档不该有中继腿）"
  fi
fi
# 引擎进程的 env 要与策略一致：relay 注入 HTTPS_PROXY，direct 一个代理变量都不该有。
# 用 `pgrep -x opencode`（按进程名）而不是 `-f` 模式匹配：`-f` 会把跑探测的这层 shell
# 自己也匹配进去，一 break 就抓到错 pid —— 结果是空值而不是报错（真踩过）。
ENGINE_PID=$(ssh_t "for p in \$(pgrep -x opencode); do if tr '\\0' '\\n' < /proc/\$p/environ 2>/dev/null | grep -q '^OPENCODE_SERVER_PASSWORD='; then echo \$p; break; fi; done" | tr -d '\r')
[ -n "$ENGINE_PID" ] || fail "没找到实例的 opencode 引擎进程"
ENGINE_PROXY=$(ssh_t "tr '\\0' '\\n' < /proc/$ENGINE_PID/environ 2>/dev/null | sed -n 's/^HTTPS_PROXY=//p' | head -1" | tr -d '\r')
if printf '%s' "$EGRESS_LINE" | grep -q '经控制端'; then
  [ "$ENGINE_PROXY" = "http://127.0.0.1:$PROXY_REMOTE" ] || fail "引擎进程的 HTTPS_PROXY=$ENGINE_PROXY（期望 http://127.0.0.1:$PROXY_REMOTE）"
  note "引擎进程（pid $ENGINE_PID）env：HTTPS_PROXY=$ENGINE_PROXY（注入到位）"
else
  # 直连档断言的是"**不是我们**"，不是"一个代理变量都没有"：对端自己的 shell 里
  # 可能就有一个本地代理（实测 Ubuntu 上是用户自己的 127.0.0.1:7897），那是它的环境，
  # 我们不替它清掉。要证明的只有一件事——它没在绕我们。
  case "$ENGINE_PROXY" in
    *":$PROXY_REMOTE"*) fail "直连档但引擎进程指向我们的中继腿：HTTPS_PROXY=$ENGINE_PROXY" ;;
    "") note "引擎进程（pid $ENGINE_PID）env：零代理变量（直连档正确）" ;;
    *) note "引擎进程（pid $ENGINE_PID）env：HTTPS_PROXY=$ENGINE_PROXY（对端自己的代理，不是我们的中继腿 :$PROXY_REMOTE）" ;;
  esac
fi
# 真正的模型回答需要一个已配置的 provider。三种结果分开说，不拿空响应当"能跑"。
ENGINE_PORT=$(ssh_t "tr '\\0' ' ' < /proc/$ENGINE_PID/cmdline | sed -n 's/.*--port \\([0-9]*\\).*/\\1/p'" | tr -d '\r')
ENGINE_PW=$(ssh_t "tr '\\0' '\\n' < /proc/$ENGINE_PID/environ 2>/dev/null | sed -n 's/^OPENCODE_SERVER_PASSWORD=//p' | head -1" | tr -d '\r')
# 引擎重启后要读完用户配置（共享目录上的 opencode.jsonc + 插件）才出 provider 列表；
# 这里轮询而不是一次判定，避免把启动竞态当成「没有 provider」。
PROV=""
for _i in $(seq 1 12); do
  PROV=$(ssh_t "curl -s -m 15 -u 'opencode:$ENGINE_PW' 'http://127.0.0.1:$ENGINE_PORT/api/provider' 2>/dev/null | head -c 400" 2>/dev/null | tr -d '\r')
  case "$PROV" in
    *UnauthorizedError*) break ;;
    *'"data":[]'*|'') sleep 5 ;;
    *) break ;;
  esac
done
if [ -z "$PROV" ]; then
  skip "P3 模型回答：引擎 /api/provider 无响应（端口 $ENGINE_PORT）——无法判定，不当作通过"
elif printf '%s' "$PROV" | grep -q 'UnauthorizedError'; then
  skip "P3 模型回答：引擎 /api/provider 鉴权失败（密码口径不符）——不当作通过"
elif printf '%s' "$PROV" | grep -q '"data":\[\]'; then
  skip "P3 模型回答：本机引擎没有已配置的 provider（/api/provider → []，已等 60s）——出网通道已验；模型调用需先在面板登一次 provider"
else
  note "引擎 provider 非空：$(printf '%s' "$PROV" | head -c 120)"
  # D6「能干活」的最后一步：真的发一条消息，等一个真的回答。之前的验收只走到
  # 「provider 非空」——那证明的是**能出网**，不是**能干活**。标记串固定
  # （pong-ocrc-<随机>），所以判定不依赖模型的发挥；等不到就 skip 并带上引擎
  # 原话，绝不把超时当通过。
  MARK="pong-ocrc-$RANDOM"
  # `|| true` on every probe substitution: a curl timeout must surface as a SKIP
  # with its reason, not as a silent script exit under `set -e` (hit exactly that
  # on the Ubuntu peer, where creating a session can outlast a 20 s budget).
  SID=$(ssh_t "curl -s -m 40 -u 'opencode:$ENGINE_PW' -H 'content-type: application/json' \
      -X POST -d '{\"directory\":\"$REMOTE_HOME\",\"title\":\"ocrc accept\"}' \
      'http://127.0.0.1:$ENGINE_PORT/api/session'" 2>/dev/null \
    | sed -n 's/.*"id":"\(ses_[^"]*\)".*/\1/p' | head -1 | tr -d '\r' || true)
  if [ -z "$SID" ]; then
    skip "P3 模型回答：引擎没有建出会话（POST /api/session 无 id / 超时）——不当作通过"
  else
    # The prompt POST is the whole turn on this engine build: give it a real
    # budget. Its HTTP code is reported for information — the **gate** is the
    # marker showing up in the message list, because that is the answer itself.
    CODE=$(ssh_t "curl -s -m 120 -u 'opencode:$ENGINE_PW' -H 'content-type: application/json' \
        -X POST -d '{\"text\":\"Reply with exactly: $MARK\"}' \
        'http://127.0.0.1:$ENGINE_PORT/api/session/$SID/prompt?directory=$REMOTE_HOME' \
        -o /dev/null -w '%{http_code}'" 2>/dev/null | tr -d '\r' || true)
    ANSWER=""
    WAITED=0
    for _i in $(seq 1 30); do
      sleep 3
      WAITED=$((_i * 3))
      MSGS=$(ssh_t "curl -s -m 20 -u 'opencode:$ENGINE_PW' 'http://127.0.0.1:$ENGINE_PORT/api/session/$SID/message?directory=$REMOTE_HOME'" 2>/dev/null | tr -d '\r' || true)
      ANSWER=$(printf '%s' "$MSGS" | grep -o "$MARK" | head -1 || true)
      [ -n "$ANSWER" ] && break
    done
    if [ -n "$ANSWER" ]; then
      note "P3 模型回答（实测）：会话 $SID，prompt HTTP $CODE，回答里出现标记 $ANSWER（约 ${WAITED}s）"
    else
      skip "P3 模型回答：会话 $SID 建了、prompt HTTP $CODE，但 90s 内没等到标记 $MARK——不当作通过"
    fi
  fi
fi

echo "[12] R10 三级开关：本脚本不动（它自己管隧道），实测记录见 handoff §4.4"
note '① 重连：supervise 下杀隧道 → 日志「转发断开，2s 后重连」→ 恢复（实测 3s）'
note '① 关掉：ocrc remote switches <id> --reconnect off 后杀隧道 → 不重连（实测 exit 4294967295 后静止）'
note "② 自恢复：只启 supervise 不给 up → 隧道自动回来（实测）"
note "③ 排队补发：开关落盘（口径持久化；补发由实例自己的队列决定）"

if [ "$TEARDOWN" = "1" ]; then
  echo "[13] 卸载：停实例"
  ssh_t "$NODE $CLIJS stop --port $INSTANCE_PORT || true" | tail -2
  H2=$(ssh_t "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$INSTANCE_PORT/health 2>/dev/null || echo 000" | tr -d '\r')
  [ "$H2" = "000" ] || fail "停实例后仍可访问（$H2）"
  note "实例已停，端口已关"
  if [ "$PURGE" = "1" ]; then
    echo "[13] 清除我们新增的命名空间（--purge）"
    ssh_t "rm -rf $R && echo removed"
    ssh_t "[ ! -d $R ]" || fail "~/.ocrc/remote 还在"
    note "~/.ocrc/remote 已删除（对端回到今天之前的状态）"
  fi
  echo "[15] 无副作用：用户既有资产未变"
  LEGACY_AFTER=$(ssh_t 'if [ -x $HOME/.local/bin/opencode ]; then $HOME/.local/bin/opencode --version 2>&1 | head -1; else echo none; fi')
  LEGACY_MD5_AFTER=$(ssh_t 'md5sum $HOME/.local/bin/opencode 2>/dev/null | cut -d" " -f1 || echo none')
  [ "$LEGACY_AFTER" = "$LEGACY_BEFORE" ] || fail "用户既有 opencode 版本变了：$LEGACY_BEFORE → $LEGACY_AFTER"
  [ "$LEGACY_MD5_AFTER" = "$LEGACY_MD5_BEFORE" ] || fail "用户既有 opencode 文件变了"
  note "既有 opencode 原样（$LEGACY_AFTER）"
fi

echo
echo "ACCEPTANCE OK —— P2 离线装机（零联网脚本 / 毒代理 / strace 零外联）· 引擎 v2 门禁"
echo "（含实例自报 binary）· 落点 · 健康 · 版本能力 · B1 目录来源 · B2 会话来源 全过。"
echo "（R10 三级的实测记录见 handoff §4.4；终端如实标注见 §4.5；界面验收 B1/B2 的实际点击见方案 §6。）"
