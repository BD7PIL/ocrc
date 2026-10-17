#!/usr/bin/env bash
# 多路转发实验（D15）：验证「一条 ssh、多个 -L、动态端口、与主隧道共生」。
#
# 靶子怎么造的：在被控机上起一个**只绑 127.0.0.1** 的 HTTP 服务——这正是 D12 里
# 「内网地址 / 本机进程」那一类的真实形状：面板直连够不着（因为没监听在对外地址上），
# 只有经隧道才可能到达。用真内网服务（如 192.168.96.11 的 searxng）当靶子也可以，
# 但它不可控、不可重复；这个靶子两条都能满足，而且不碰任何生产服务。
#
# Usage:  extensions/ocrc-connect/scripts/spike-multi-forward.sh --target user@host[:port]
set -euo pipefail

TARGET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$TARGET" ] || { echo "需要 --target user@host[:port]" >&2; exit 2; }

UH=${TARGET%%@*}; TH=${TARGET##*@}; TPORT=22
case "$TH" in *:*) TPORT=${TH##*:}; TH=${TH%%:*} ;; esac
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p "$TPORT")
ssh_t() { ssh "${SSH_OPTS[@]}" "$UH@$TH" "$@"; }

PORT=${PORT:-4556}          # 面板侧服务端口
TOK=${TOK:-spike-mf-tok}
TARGET_PORT=18099           # 被控机上只绑 loopback 的靶子端口
WS=$(mktemp -d /tmp/ocrc-mf.XXXXXX)
SRV_PID=""
TUN_PID=""
MARK="ocrc-tunnel-marker-$RANDOM"

cleanup() {
  [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null || true
  [ -n "$TUN_PID" ] && kill "$TUN_PID" 2>/dev/null || true
  ssh_t "kill \$(cat /tmp/ocrc-mf-target.pid 2>/dev/null) 2>/dev/null; rm -f /tmp/ocrc-mf-target.pid; rm -rf /tmp/ocrc-mf-target" 2>/dev/null || true
  rm -rf "$WS"
}
trap cleanup EXIT
cd "$(dirname "$0")/.."

say() { echo; echo "── $1"; }
fail() { echo "FAIL: $1"; exit 1; }

say "0. 在被控机上起一个只绑 127.0.0.1 的靶子（端口 $TARGET_PORT）"
# 启动形式是 (nohup … &) 加上**同一个 ssh 调用里** sleep 后自测：
#   · 只重定向 stdout/stderr 时 sshd 会等 stdin（通道）关闭，命令挂住 → 三个 fd 都要断；
#   · 分两次 ssh 自测则容易把「还没起来」当成「起不来」（第一轮就踩了）。
STARTED=$(ssh_t "mkdir -p /tmp/ocrc-mf-target && printf '%s\n' '$MARK' > /tmp/ocrc-mf-target/index.html && \
  cd /tmp/ocrc-mf-target && \
  if command -v python3 >/dev/null 2>&1; then (nohup python3 -m http.server $TARGET_PORT --bind 127.0.0.1 >/tmp/ocrc-mf-target.log 2>&1 </dev/null & echo \$! > /tmp/ocrc-mf-target.pid); \
  elif command -v python >/dev/null 2>&1; then (nohup python -m SimpleHTTPServer $TARGET_PORT >/tmp/ocrc-mf-target.log 2>&1 </dev/null & echo \$! > /tmp/ocrc-mf-target.pid); \
  else echo NO-SERVER; fi; \
  sleep 1; curl -s -m 3 http://127.0.0.1:$TARGET_PORT/ || echo CURL-FAILED" | tr -d '\r')
echo "      $(echo "$STARTED" | head -1)"
echo "$STARTED" | grep -q "$MARK" || {
  echo "      靶子没起来，诊断如下："
  ssh_t "echo -n '  pid: '; cat /tmp/ocrc-mf-target.pid 2>/dev/null; ps -p \$(cat /tmp/ocrc-mf-target.pid 2>/dev/null) -o pid,cmd 2>/dev/null | tail -1; echo '  日志:'; head -5 /tmp/ocrc-mf-target.log 2>/dev/null" || true
  fail "被控机上的靶子没起来（端口 $TARGET_PORT 被占？python 不在？）"
}

say "1. 面板直连：应当够不着（靶子只在被控机的 loopback 上）"
if curl -s -m 4 "http://$TH:$TARGET_PORT/" -o /dev/null 2>/dev/null; then
  echo "      ⚠ 面板竟然直连成功了——说明靶子绑到了对外地址，本次实验的前提不成立。"
  echo "        请检查被控机上是否有别的服务占用了 $TARGET_PORT（那它就不是 loopback-only）。"
  DIRECT_HIT=1
else
  echo "      ✓ 直连失败（预期）：$TH:$TARGET_PORT 从面板不可达"
  DIRECT_HIT=0
fi

say "2. 起服务（面板侧），档案里带一条转发：127.0.0.1:<动态> → 被控机 127.0.0.1:$TARGET_PORT"
OCRC_CONNECT_PROFILES="$WS/profiles.json" OCRC_CACHE_DIR="$WS/cache" \
OPENCHAMBER_SERVICE_PORT=$PORT OPENCHAMBER_SERVICE_TOKEN=$TOK \
  node service/main.js > "$WS/service.log" 2>&1 &
SRV_PID=$!
for _ in $(seq 1 20); do curl -s -o /dev/null -H "Authorization: Bearer $TOK" "http://127.0.0.1:$PORT/health" && break; sleep 0.5; done

req() { curl -s -H "Authorization: Bearer $TOK" -H 'content-type: application/json' "$@"; }
req -X POST "http://127.0.0.1:$PORT/profiles" -d "{\"profile\":{\"id\":\"mf\",\"name\":\"mf\",\"host\":\"$TH\",\"user\":\"$UH\",\"port\":$TPORT,\"remotePort\":4398,\"localPort\":4598,\"projects\":[{\"path\":\"/tmp/ocrc-mf-target\"}]}}" > /dev/null
# 额外转发：先按 port=4602 显式指定（动态分配由 /capabilities 那条路走，见步骤 5）。
# 顺序很重要：**先配转发再连接**（转发的用途就是连之前先配好；spike 第一轮在旧实现上
# 卡在这里——旧 /forwards 要求已连接，于是 409 被吞掉，ssh argv 里根本没有那条 -L）。
req -X POST "http://127.0.0.1:$PORT/forwards" -d "{\"profileId\":\"mf\",\"forwards\":[{\"direction\":\"local\",\"peerHost\":\"127.0.0.1\",\"peerPort\":$TARGET_PORT,\"port\":4602,\"activePort\":4602,\"reason\":\"$MARK\"}]}" | head -c 200; echo
req -X POST "http://127.0.0.1:$PORT/connect" -d '{"profileId":"mf"}' > /dev/null
sleep 2

say "3. 经隧道取靶子：应当拿到标记"
BODY=$(curl -s -m 5 "http://127.0.0.1:4602/" || true)
echo "      127.0.0.1:4602 → ${BODY:0:60}"
echo "$BODY" | grep -q "$MARK" || fail "经隧道的转发没有拿到靶子内容（拿到的是：${BODY:0:80}）"

say "4. 一条 ssh 里的多路转发：数一数进程与参数"
if command -v powershell.exe >/dev/null 2>&1; then
  CMDLINE=$(powershell.exe -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \"Name='ssh.exe'\").CommandLine" 2>/dev/null | tr -d '\r' | grep -F -- "-L 127.0.0.1:4598" || true)
else
  CMDLINE=$(ps -o args= -C ssh 2>/dev/null | grep -F -- "-L 127.0.0.1:4598" || true)
fi
echo "$CMDLINE" | head -2
LCOUNT=$(echo "$CMDLINE" | grep -o -- "-L" | wc -l | tr -d ' ')
[ "$LCOUNT" -ge 2 ] || fail "同一个 ssh 进程里应当有 ≥2 个 -L（主隧道 + 额外转发），实测 $LCOUNT"
echo "      ✓ 同一条 ssh 里有 $LCOUNT 个 -L"

say "5. 断开后转发一起消失（共生）"
req -X POST "http://127.0.0.1:$PORT/disconnect" -d '{}' > /dev/null
sleep 1
if curl -s -m 3 "http://127.0.0.1:4602/" -o /dev/null 2>/dev/null; then
  fail "断开后转发仍然活着——共生没生效，会留下半条活侧路"
fi
echo "      ✓ 断开后 127.0.0.1:4602 不可达"

say "6. 端口冲突会不会炸（ExitOnForwardFailure）"
# 先占住 4602，再连接：ssh 应当立刻退出、由 supervisor 报错，而不是静默半活。
node -e "
const net=require('net');
const s=net.createServer(()=>{});
s.listen(4602,'127.0.0.1',()=>{
  const http=require('http');
  const body=JSON.stringify({profileId:'mf'});
  const r=http.request({host:'127.0.0.1',port:$PORT,path:'/connect',method:'POST',headers:{authorization:'Bearer $TOK','content-type':'application/json','content-length':Buffer.byteLength(body)}},async(res)=>{
    let d=''; res.on('data',c=>d+=c); res.on('end',async ()=>{
      console.log('      /connect 返回', res.statusCode, d.slice(0,120));
      await new Promise(r=>setTimeout(r,2500));
      const st=await new Promise(res2=>{const rq=http.request({host:'127.0.0.1',port:$PORT,path:'/status',headers:{authorization:'Bearer $TOK'}},x=>{let dd='';x.on('data',c=>dd+=c);x.on('end',()=>res2(dd))});rq.end()});
      console.log('      /status →', st.slice(0,260));
      s.close(); process.exit(0);
    });
  });
  r.end(body);
});
"

say "7. 动态端口分配（服务侧 allocator；不经 ssh 输出猜端口）"
node -e "const {pathToFileURL}=require('node:url');import(pathToFileURL('dist/service/tunnels.js').href).then(async (m)=>{
  const ports=await Promise.all([m.systemPortAllocator(),m.systemPortAllocator(),m.systemPortAllocator()]);
  console.log('      三次分配:', ports.join(', '), new Set(ports).size===3?'（互不相同 ✓）':'（有重复 ✗）');
});"

say "8. 能力转发端口被占用 → 自动换一个空闲端口（主端口不换）"
node -e "
const net=require('net'),http=require('http');
const s=net.createServer(()=>{});
s.listen(4602,'127.0.0.1',()=>{
  const body=JSON.stringify({profileId:'mf',forwards:[{direction:'local',peerHost:'127.0.0.1',peerPort:$TARGET_PORT,port:4602,activePort:4602,reason:'searxng'}]});
  const r=http.request({host:'127.0.0.1',port:$PORT,path:'/forwards',method:'POST',headers:{authorization:'Bearer $TOK','content-type':'application/json','content-length':Buffer.byteLength(body)}},x=>{
    let d='';x.on('data',c=>d+=c);x.on('end',()=>{ console.log('      /forwards →', d.slice(0,300)); s.close(); process.exit(0) });
  });
  r.end(body);
});
"

echo
echo "SPIKE OK —— 直连不可达 → 隧道可达 → 同一 ssh 多路 -L → 断开共生 → 冲突可观测。"
