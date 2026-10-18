# ARCHITECTURE — 远程 openchamber 实例

> 以代码为准。这个仓库现在只做一件事：**把整套 openchamber 装到远程 Linux 机器上、起它、
> 把它配对进桌面 app、并保持配置与凭据同步**。产品边界见 [PRODUCT.md](PRODUCT.md)，
> 运维见 [OPS.md](OPS.md)；驾驶舱那一代（Telegram/Web 通道、工作流、日程、技能、引擎级
> 远程主机）已删除，见 [AGENTS.md](../AGENTS.md) 的「已删除」。

## 一、拓扑（一句话）

**控制端** = 跑着 openchamber 桌面 app 的那台机器（Win/Mac）；**被控端** = 我们装出来的
openchamber 实例（Linux）。控制端只做三件事：**装**（推运行时 + pin 的 opencode + app）、
**连**（转发腿 / 出网中继）、**配对**（一次性链接交给上游）。被控端的 openchamber 自己
服务自己的界面与会话——我们不改它一行。

```
控制端（Win/Mac）                                   被控端（Linux x86_64）
┌──────────────────────────────┐                  ┌──────────────────────────────┐
│ openchamber 桌面 app          │                  │ openchamber（我们装的）        │
│  ├─ 面板 iframe：extensions/ocrc/panel           │  ├─ UI :2610（回环）           │
│  ├─ 状态区 iframe：…/status   │   ssh -L/-R      │  ├─ opencode v2（pin 2.0.27）  │
│  └─ service 进程：…/service   │◄────────────────►│  └─ ~/.ocrc/remote/…           │
│       （宿主上唯一能跑 ssh 的）│                  │                                │
│  ~/.ocrc/remote-instances.json│                  │                                │
└──────────────────────────────┘                  └──────────────────────────────┘
         │                                                      ▲
         └── 出网中继（对端没有外网时）：本机 :4711 ── ssh -R ──► 对端 :2711 ──► 引擎的 HTTPS_PROXY
```

## 二、扩展的三个槽位，以及为什么必须有 service

openchamber 的 guest 模型给扩展三个槽位，我们都用了：

| 槽位 | 入口 | 做什么 |
| --- | --- | --- |
| `panel` | `extensions/ocrc/panel/` | 服务器列表：添加 / 检查并安装 / 启动 / 配对 / 配置同步 / 日志 / 界面密码 |
| `statusSection` | `extensions/ocrc/status/` | 右侧栏每台一行只读读数（状态 · 版本 · 直连或经本机转发） |
| `service` | `extensions/ocrc/service/` | 宿主上 spawn 的常驻进程；**唯一能执行 `ssh` 的地方**（`permissions.exec: ["ssh"]`） |

iframe 跑在 `sandbox="allow-scripts"` 里，不能起进程、不能跑 ssh——所以"画界面"和"干活"
必须分开。面板与状态区都通过 `host.serviceRequest(...)` 打 service。

**service 只有两条路由**（`src/service/main.ts`，97 行）：

- `GET /health` —— 宿主契约要求（15 秒内 200）
- `POST /remote-instance` —— 所有 op（见下）

`src/service/remote-instance-ops.ts` 是 op 层：闭集字段校验、长操作改 job + 轮询、密码脱敏。
op 清单：`list / add / patch / delete / plan / apply / upgrade / up / down / probe / status /
logs / peerlog / url / pairlink / defaults / uipassword / configdiff / syncconfig / syncauth / job`。

## 三、CLI 侧的模块（`src/`，19 个文件，零运行时依赖）

| 模块 | 职责 |
| --- | --- |
| `core/remote-instance.ts` | 域模型 + arg 构造：id、路径、转发参数、中继参数、引擎 v2 门禁、终端探测解析、脱敏 |
| `core/remote-instance-bridge.ts` | **manager**：起停实例、转发腿、出网中继、reconcile（策略变了就重启实例）、plan/apply/upgrade、日志 |
| `core/remote-instance-push.ts` | 工件推送：两档 app 包（`legacy-glibc217` / `modern`）、运行时、pin 的引擎；离线（对端零联网） |
| `core/remote-instance-proxy.ts` | 控制端出网中继（CONNECT 代理 + 日志），对端引擎经 `-R` 走它 |
| `core/remote-instances.ts` | 实例记录 store（`~/.ocrc/remote-instances.json`，100ms 去抖 + tmp/rename，0600） |
| `core/instance-config.ts` | 读被控端 `~/.config/opencode` 两档、差异、深合并、显式删除、凭据推送（ssh stdin → 0600） |
| `core/config-merge.ts` | 一套合并引擎：面板段逐叶覆盖、被控端独有键保留、字面量密钥换 `{env:…}` |
| `core/forward-ownership.ts` | 每条转发腿写 marker（pid/角色/端口），起腿前先看（活的复用、死的清理） |
| `core/ssh-askpass.ts` | 密码档：askpass helper（脚本里没有秘密，值走环境变量），POSIX 0700 / Windows 变体 |
| `core/remote-common.ts` | 共用小件：glibc 解析、重试退避、ssh 选项（EL7 兼容） |
| `core/bin-cache.ts` | 工件缓存：cache → bundle → registry；摘要不符报错，无摘要忽略 |
| `utils/{paths,logger,secret,jsonc}.ts` | `~/.ocrc` 路径、日志、随机口令、JSONC 解析 |
| `cli/remote.ts` | `ocrc remote …`：上面所有能力的 headless 等价物 |
| `remote-instance/index.ts` | 显式库边界（service 与 CLI 共用同一实现） |

## 四、装与起（一次 `up` 里发生的事）

1. **探测**：一次 ssh 拿到 uname/glibc/HOME、有没有运行时、有没有满足 v2 门禁的 opencode、
   实例端口是否被占。
2. **出网判定**：让被控端取 `https://models.dev/api.json`（openchamber 自己取 provider 目录的
   地址）。地址族感知的链：`curl -4` → `curl -6` → `wget` → 我们推过去的 node；每个尝试套
   `timeout 5`（curl 的 `--max-time` 打断不了阻塞的 `getaddrinfo`）。判定 `direct | dns-only |
   none | unknown`，**只有 `direct` 才直连**，其余经本机转发（unknown 也保守转发，且如实说
   没测出来）。
3. **推送**（`push` 档）：运行时 tarball、两档之一的 app 包、pin 的 opencode——全走 ssh stdin，
   被控端零联网；`reuse` 档一个字节都不推，只检查 + 把引擎 pin 下来，缺件就明确失败。
4. **起实例**：在回环上 `serve --port <实例端口>`，env 按第 2 步的结果决定（转发档注入
   `HTTPS_PROXY=http://127.0.0.1:2711`）。
5. **转发**：控制端 `-L <本机端口> → 被控端实例端口`（UI 那条由桌面壳持有）+ 需要时 `-R`
   （出网中继那条）。每条腿在 `~/.ocrc/forwards/` 留 marker，`status` 会报持有者。
6. **探活**：实例自报版本与引擎兼容性（`major=2` 且 `>= 2.0.20`），不满足就是错误状态。

**reconcile**：`up` 时若发现实例正跑着但它的 env 与当前策略不符（例如策略从 relay 变 direct），
会重启实例——"在线但没有出网"这种状态不允许存在。

## 五、状态与文件

| 位置 | 内容 |
| --- | --- |
| `~/.ocrc/remote-instances.json` | 实例记录（0600；含我们生成的界面密码，接口不回显） |
| `~/.ocrc/bin-cache/` | 工件缓存（app 包 / 引擎 / 运行时） |
| `~/.ocrc/forwards/` | 转发持有者 marker |
| `~/.ocrc/remote-relay.log` / `remote-forward.log` | 中继与转发日志（面板「日志」卡读它们） |
| 被控端 `~/.ocrc/remote/` | 运行时、pin 的引擎、app 树、`instance.log`（移除记录时也不动它） |
| 被控端 `~/.config/opencode/` | 引擎真正读的配置；我们只推差异，旧件留 `.ocrc-bak` |

## 六、CI 与工件

| 工作流 | 作用 |
| --- | --- |
| `ci.yml` | typecheck（CLI + 测试树）· CLI 测试 · 两个扩展的 typecheck/test/build · 扩展产物一致性 · guest bundle 不变量 |
| `ocrc-extension.yml` | 手动 dispatch：发布扩展 zip（`ocrc-<ver>` 钉 / `ocrc-latest` 通道）+ 把扩展子树推成 `ocrc` 分支（git 装法才能自更新） |
| `ocrc-follow.yml` | 跟着上游 openchamber 写引擎 pin（`ops/v2-pin-manifest.json`） |
| `ocrc-pack.yml` | 构建两档兼容包（`ocrc-openchamber-pack-<ver>-linux-x64-<tier>.tar.gz` + `.sha512` + manifest） |

pin 优先级：`ops/v2-pin-manifest.json` > `OCRC_V2_PIN` > 动态跟随。被控端**不做自更新**——
版本源是控制端（我们 pin 什么，它就装什么）。

## 七、有意为之（不要"顺手修"）

- **`StrictHostKeyChecking=no` 而不是 `accept-new`**：EL7 的 OpenSSH 7.4 不认 `accept-new`。
- **ssh 死了就让它把起的东西一起带走**：实例与转发腿绑在同一条 ssh 生命周期上，反陈旧、反漂移。
- **出网是探测结果，不是配置项**：`auto` 是默认，`relay`/`direct` 是强制覆盖；理由写在卡片上，不猜。
- **被控端零联网**：所有远程脚本里不允许出现取件命令——`ocrc remote offline-proof` 是结构性
  断言，`trace-check` 判读 strace。
- **密码只落 0600、接口不回显**：对外只有 `hasSshPassword` / `hasUiPassword` 两个布尔，
  `redactInstance` 是唯一出口。
- **面板不自己画主题**：控件用宿主 kit、颜色用宿主 token（`shared/guest.css` 只留布局）。
- **配对不能由面板打开**：宿主对 `open-url` 只放行 http(s)，`openchamber://` 深链必被拒——
  所以是"复制链接 → 到 app 的服务器列表点「导入链接」粘贴"。
