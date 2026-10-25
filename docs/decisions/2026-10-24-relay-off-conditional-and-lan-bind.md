# 裁决：relay off 条件化 + LAN bind 开关（2026-10-24，扩展 0.11.1）

## 事故与根因（证据链）

用户报告：「ocrc 重新拉起的实例会丢失远程配置，官方 relay 全都断开，通过官方 relay 连接的
终端都显示不可达」。

EL7 真机取证（2026-10-24）：

- **配置没有丢**：`~/.config/openchamber/` 里 relay-identity.json（10-16）、jwt-secret（10-16）、
  client-pairing-sessions.json、remote-clients.json 全在且正常更新。「丢失」是 relay 断开在
  UI 里的样子。
- **真凶**：ocrc 的 serve 行自首个实例提交（08f8e920）起无条件注入
  `OPENCHAMBER_RELAY_HOST=off`，注释写「Air-gapped hosts: never dial the hosted relay」。
  而该变量的真实语义（app 源码 `server/index.js:2590`、`lib/relay/service.js:197`）是
  `allowPassiveHost=false`——**永不被动担任 relay host**：`start()` 的门
  `claim !== 'force' && !allowPassiveHost → standby` 让 off 的实例每次启动都落 standby，
  不建立到 relay.openchamber.dev 的 control socket；boot/demand/watcher 都不走 force，
  所以 `/relay/enable` 持久化的 enabled=true 救不了下次重启。EL7 出网实测正常
  （models.dev 200、relay 域名可达）——air-gap 假设对它是纯误伤。
- 日志铁证：当前进程 boot 标记在 app 日志第 3531 行，最后一条 `[Relay]` 在 3502 行
  ——本次进程从未建立 control socket。
- 即时恢复：`POST /auth/session`（UI 密码）→ `POST /api/openchamber/relay/enable`
  （源码注释「Explicit user action: take the machine's host claim like pairing does」，
  force-claim 且持久化 enabled）→ state=connected。

## 裁决

1. **off 条件化**：纯谓词 `relayHostFor(probe, relayInjected)` = `!relayInjected && probe === 'none'`。
   判据的不对称代价：air-gap 对端多拨几次 relay 是无害重试日志；在线对端被 off 则 relay 全断。
   所以拿不准（unknown / dns-only / 显式 direct 且无代理）一律不注入。
2. **LAN bind 显式 opt-in**（用户提出）：`bind: 'loopback' | 'lan'`，默认 loopback 不变；
   lan → `--hostname 0.0.0.0`。安全纪律：lan 无 UI 密码构造期抛错；plan 连同对端 IP
   把暴露面（单因子密码、无 TLS、防火墙自行放行）一次说清；pairlink 追加上游 `--lan`
   （候选由对端自己生成）；`ocrc remote set` 为修改通道，改动下次 up 生效。
3. defaults 返回体里撞名的展示用 `bind: '127.0.0.1'` 删除——新 select 承载该信息。

## 附记（取证手法与教训）

- 「配置丢了」类报告先查盘再下结论：文件在不在、mtime 对不对，比复述症状可靠。
- 环境变量注入前先读上游对它的**真实语义**（grep 上游源码里它的全部消费点），
  按变量名猜语义是这次事故的源头。
- app 侧对网络暴露绑定的护栏（无 UI 密码拒绝启动 bind 非 loopback）是现成的——
  我们在构造期提前抛同样的错，失败信息比 app 的启动失败更早更可读。
