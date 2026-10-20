# 开发测试方案：openchamber 对端能力（v1：本地 + SSH）

> **已过时（2026-10-19）**：本文件描述的功能/入口属于**已删除的驾驶舱那一代**（Telegram/Web 通道、工作流、日程、技能、子代理、引擎级远程主机）。它们已从本仓库删除，会作为独立的 openchamber 扩展在别的项目里做；保留作为历史记录。当前产品见 [AGENTS.md](../AGENTS.md) 与 [docs/ARCHITECTURE.md](../ARCHITECTURE.md)。

- **日期**：2026-10-16
- **性质**：可落地的完整开发 + 测试方案（含验收、门禁、回滚、时间估计）
- **前置裁决**：[remote-instance-verdict.md](../research/remote-instance-verdict.md)（Phase 0 取证：主路成立、运行时选型、`external` 模式要求、离线可跑、node-pty 阻塞）
- **需求基线**：2026-10-16 grill 封版（R1–R11 + Q14–Q19），见本文 §1

---

## 1. 目标与验收判据（不可协商的硬要求）

**能力条款（用户原话）**

1. 在 openchamber 里 **Add project 的目录浏览器列出的是被控机的目录**，选中的对端路径能作为项目打开。
2. **中栏主页面的会话直接跑在对端引擎上**（模型 / agent / 工具都在对端）。

**基线其余条款**

| 代号 | 内容 |
|---|---|
| R1 | 单人自用，管几台自己的机器（当前全内网 EL7） |
| R3 | 单位是 **workspace**；路径可落 本地 / SSH / WSL / Docker；workspace 可聚合分组 |
| R5 | **控制端 = 这台 Windows 宿主**，持有 本地/SSH/WSL/Docker 四种连接；手机 PWA 连它；**LAN 直连是刚需** |
| R6 | **被控端不出公网**：外网请求经控制端中转（代理 + `ssh -R`），计算与引擎留对端 |
| R7 | **断线重连三级可开关**（默认：重连+重订阅 开 / 重启自恢复 开 / 操作排队补发 关） |
| R9 | 保留 TG/IM 通道（降优先级） |
| R10 | 手机对等基准 = **连已有 workspace**（不做手机端新增连接/装机） |
| **R12** | **引擎必须是 opencode v2（major=2 且 ≥ 2.0.20）**：实例只允许连 v2；缺失时先走"部署引擎"（既有 provisioning，sha512 校验、镜像控制端版本），**绝不回落 v1**；二进制路径必须**显式 pin**，不依赖 PATH 解析 |
| — | v1 范围 = **本地 + SSH**；WSL/Docker 结构留位 |

**v1 退出条件（P1 结束即可验收）**：上面"能力条款"两条各有一条可复现的实测动作（见 §6 验收清单 B1/B2）。

---

## 2. 架构与拓扑（v1）

```
┌──────────────────────── 控制端（Windows，本机） ────────────────────────┐
│  ocrc host/CLI（Node，Hono HTTP :4099）                                  │
│   ├─ /api/remote-instance/*   装机 / 启动 / 停止 / 状态 / 日志 / 转发     │
│   ├─ ssh -N -L 127.0.0.1:<local> : 127.0.0.1:<remote>   （转发 = 唯一的连接）│
│   ├─ [P3] 本地代理 + ssh -R 127.0.0.1:<proxy>  ← 供对端引擎出网           │
│   └─ 面板扩展（extensions/ocrc-remote 改造为"远程实例"面板）             │
│  浏览器 / PWA（桌面或手机，LAN）──▶ http://127.0.0.1:<local>               │
└──────────────────────────────────────────────────────────────────────────┘
                                   │ ssh（免密）
┌──────────────────────── 被控端（EL7）────────────────────────────────────┐
│  ~/.ocrc/remote/runtime/node-v24.22.0/        随包推的运行时              │
│  ~/.ocrc/remote/openchamber/2.3.3/            npm --prefix 装的实例       │
│  openchamber serve --hostname 127.0.0.1 --port 2610                       │
│   └─ 它自己拉起/连上 opencode v2 引擎（OPENCODE_BINARY）                   │
│  用户既有资产（不碰）：~/.local/bin/opencode（1.18）、ocrc agent、~/.ocrc/*.log │
└──────────────────────────────────────────────────────────────────────────┘
```

**为什么这样就满足能力条款**：界面由**对端那个 openchamber 服务端**提供，它的
`project-directory-runtime` / `fs` / `git` / 终端面全部在服务进程里解析（见 verdict §一），
所以 Add project 列的是对端目录、中栏会话走的是对端引擎——**零补丁**。

**界面（这不是"简化"，是设计本身）**：你看到的**就是 openchamber 的 UI**——它由**对端实例自己 serve**
（同一个 `@openchamber/web`，版本 pin 2.3.3，与你在用的那份同源同外观）。我们不改它一行。

**两种入口（v1 提供，任选；两者看到的是同一个实例、同一套面）**：

| 入口 | 形态 | 说明 |
|---|---|---|
| **① 浏览器 / PWA** | 打开转发 URL `http://127.0.0.1:<local>` | 零依赖；桌面与手机同源；多机 = 多标签 |
| **② openchamber 桌面版** | 在它的 Remote Instances 里加一条 **`external`** 实例 | 它自己建转发并**开窗**，带主机切换器（**多机聚合分组就靠它**）；我们负责把它的前提准备好：**钉死远端端口 + UI 密码 + 实例已在跑**（`ensureRemoteServer` 对 external 的要求：`preferredPort` 必填、密码可选，**不要求版本相等**） |

也就是说：**UI 是它的，窗口壳你要就用它的**。v1 默认把 ① 打通（当天可验收），② 在 P5 里做一键"在桌面版中打开"（把 external 的三项前提自动填好）。

### 2.1 引擎版本要求与获取（R12，硬门禁）

- **门禁出处**：`server/lib/opencode/compatibility.js` → `MINIMUM_OPENCODE_VERSION = '2.0.20'`、major 必须为 2；
  违反时报"OpenChamber requires OpenCode 2.0.20 or newer"。引擎自带 client 同款门禁（"Upgrade it to OpenCode V2"）。
- **断言点（三处，缺一不可）**：
  1. `plan`：探测目标机上的引擎候选（显式路径列表，**不看 PATH 解析顺序**），版本不合格就输出"需要先部署引擎"的计划；
  2. `start` 之前：再次断言 `major === 2 && >= 2.0.20`，不合格**拒绝启动并如实报**（引用本机 1.18.31 那次真实失败原文作提示模板）；
  3. 面板/状态接口：显示实例所用引擎的**版本 + 来源绝对路径**（防止"以为连的是 v2、实际是 1.18"）。
- **两条引擎策略**（默认 ①）：
  ① **实例自拉**：`OPENCODE_BINARY=<我们 pin 的 v2 绝对路径>`，实例在远端另起一个引擎进程，**不碰用户既有引擎**（EL7 上既有 `~/.local/bin/opencode` 1.18.32、以及用户自己 `serve --port 4096` 的 v2.0.27）；
  ② **附着既有引擎**：`OPENCODE_PORT=<既有端口>` + `OPENCODE_SERVER_PASSWORD=<既有密码>`，省一份内存，但与用户引擎生命周期耦合（可选，面板上标注差异）。
- **没有 v2 时怎么获取**：复用既有 provisioning 链（`core/bin-cache.ts` 的 sha512 校验 + 扩展的 `artifact.ts`/`install.ts`，
  官方平台包 `@opencode/cli-<platform>-<arch>[-baseline]`），落点 `~/.ocrc/remote/engine/<version>/`，
  **绝不覆盖** `~/.opencode/bin` 或用户目录里的任何既有安装；版本**镜像控制端 pin**（D6 的口径）。
- **控制端本机的特殊性**：远端实例模式下控制端**不需要**引擎；但"本地"这一档（v1 范围内）需要 Windows 上有 v2——
  本机现状是 `opencode-ai@1.18.31` + 空的 `~/.opencode/bin/`，所以本地面当前不可用（点面板的「更新至 OpenCode v2」
  或在控制端装一份 v2 即可，属于"用户动作"，不影响远端档）。

---

## 3. 交付物清单（文件级）

### 3.1 控制端（新增代码）

| 文件 | 职责 |
|---|---|
| `src/core/remote-instance/types.ts` | `RemoteInstance`（host/port/user/keyPath、remotePort、uiPasswordRef、reconnect 开关、runtime/app 版本 pin）与状态机类型 |
| `src/core/remote-instance/provision.ts` | 工件计划与执行：运行时 tarball（Node 24 glibc-217）+ `@openchamber/web@<pin>` tarball；sha256/sha512 校验；解包/安装脚本生成（纯函数，可单测） |
| `src/core/remote-instance/push.ts` | 控制端取件 + 缓存（复用 `core/bin-cache.ts` 的校验与缓存约定）+ 经 ssh stdin 推送（大文件走 gzip/base64 管道，带进度回调） |
| `src/core/remote-instance/launch.ts` | 远端 start/stop/status 脚本（`node <prefix>/bin/cli.js serve --port N` / `stop --port N`），PID 与端口探测 |
| `src/core/remote-instance/forward.ts` | `ssh -N -L` 转发进程管理（keepalive、自动重连、端口占用检测与换端口）与健康探测（`/health`、`/api/version`） |
| `src/core/remote-instance/proxy.ts` | [P3] 控制端本地 HTTP 代理 + `ssh -R`；生成对端引擎的 `HTTPS_PROXY/NO_PROXY` 注入片段 |
| `src/core/remote-instance/store.ts` | 实例持久化（`~/.ocrc/remote-instances.json`，0600；凭据只存引用/密文）与重启自恢复 |
| `src/transport/web/routes/remote-instance.ts` | 路由：`GET/POST /api/remote-instance`、`POST /api/remote-instance/:id/{plan,apply,start,stop,forward}`、`GET /api/remote-instance/:id/{status,logs}`；门禁与错误码沿用既有风格（`confirm:true` 才动手、409 无档案、502 远端失败） |
| `src/cli/commands/remote.ts` | `ocrc remote add/list/plan/up/down/open/logs/remove`（`open` = 打印/打开转发 URL） |

### 3.2 面板（改造既有扩展）

| 文件 | 改动 |
|---|---|
| `extensions/ocrc-remote/src/panel/Panel.tsx` | "连接"页改为**远程实例**页：实例卡片（状态、远端端口、本地 URL、"打开"按钮）、装机预演与一次确认、启动/停止、日志抽屉 |
| `extensions/ocrc-remote/src/panel/HostView.tsx` | 四档就绪收敛为"实例就绪度"（ssh → 运行时 → 应用 → 引擎 → 转发），保留既有检测逻辑 |
| `extensions/ocrc-remote/src/service/*` | 能力盘点/运行时补齐/配置同步**保留**（它们是"能力包"面，不属于远程实例）；隧道相关（`tunnel.ts`）由宿主接管后降级为兼容路径 |

### 3.3 被控端载荷（不写代码，随包推）

```
~/.ocrc/remote/runtime/node-v24.22.0/     node-v24.22.0-linux-x64-glibc-217.tar.xz（35.7 MB，sha256 已对官方 SHASUMS 校验）
~/.ocrc/remote/openchamber/2.3.3/         @openchamber/web@2.3.3（依赖闭包见 verdict §二）
~/.ocrc/remote/libstdc++/libstdc++.so.6   [P6] 终端用；或用 Bun 路径绕开
```

### 3.4 文档

`docs/research/remote-instance-verdict.md`（已写）· 本文 · `docs/PRODUCT.md` 第零点十条（待写）·
`docs/OPS.md` 增补"远程实例运维段"（停/起/卸/换版本）· `docs/handoff/` 增补手工验收脚本说明。

---

## 4. 分阶段计划

> 时长是单人、含自测的估计；P1 是唯一"必须有可见结果"的阶段。

### P0 取证（**已完成**）
产出 = `remote-instance-verdict.md`。结论：主路成立；运行时选 Node v24.22.0 `glibc-217`；
`external` 模式只要钉端口 + 可选密码；启动期零外联；node-pty 阻塞仅影响终端。

### P1 打通（0.5–1 天）— **退出即验收能力条款**
0. **引擎探针 + 版本断言**（R12）：列出候选绝对路径 → 取版本 → 断言 `major=2 && >=2.0.20`；
   不合格则走"部署引擎"分支（`plan → confirm → apply`），**绝不回落到 v1**。
1. 在被控机装运行时与应用（**spike 已完成第一步**：`~/.ocrc/remote/dist/node-v24.22.0-linux-x64-glibc-217.tar.xz` 已下载并通过官方 SHASUMS 校验）。
2. 解包到 `~/.ocrc/remote/runtime/node-v24.22.0/`，验 `node --version` = v24.22.0。
3. `npm install -g --prefix ~/.ocrc/remote/openchamber/2.3.3 @openchamber/web@2.3.3`。
4. 启动：`<runtime>/bin/node <prefix>/lib/node_modules/@openchamber/web/bin/cli.js serve --hostname 127.0.0.1 --port 2610`，
   `OPENCODE_BINARY=<pin 的 v2 绝对路径>`（**显式路径，不靠 PATH**；默认取被测机上的 v2.0.27，若已按 0 步部署则取我们自己的那份）；日志落 `~/.ocrc/remote/instance-2610.log`。
5. 控制端建转发：`ssh -N -L 127.0.0.1:4610:127.0.0.1:2610 user@192.0.2.10`（本地端口避开用户既有隧道 4096）。
6. 探活：`curl -s http://127.0.0.1:4610/health`、`/api/version`（应含 `capabilities` 与 `compatibility`）、`/api/system/info`（应含 `openchamberVersion: 2.3.3`），并确认实例实际使用的引擎版本 ≥2.0.20。
7. **交给用户验收**：浏览器打开 `http://127.0.0.1:4610`（**这就是 openchamber 的 UI**）→ Add project 应列出 **EL7** 的目录（如 `/home/user`）→ 选中 `/home/user/develop/ate` 建项目 → 中栏发一句话 → 在 EL7 上对应引擎的 `/api/session` 能看到会话。

### P2 离线闭环（R6 的"装机"那一半）（0.5 天）
1. 控制端取件 + 缓存 + 校验（`provision.ts`/`push.ts`）。
2. 推送安装到全新路径（用 `/tmp` 或第二个测试账号模拟干净目标），**全程断掉被控端出网**（`iptables -I OUTPUT -d 0.0.0.0/0 -j DROP` 或临时清 DNS/代理，测试后还原）并复验 §P1.6。
3. 卸载路径同批做：停服务 → 删 `~/.ocrc/remote/` → 撤转发 → 断言对端既有文件 md5 未变。

### P3 代理出网（R6 的"运行期"那一半）（0.5 天）
1. 控制端本地代理（HTTP CONNECT，够 LLM HTTPS 用）+ `ssh -R 127.0.0.1:<p>` 反向转发。
2. 对端注入：`HTTPS_PROXY/HTTP_PROXY=http://127.0.0.1:<p>`、`NO_PROXY=127.0.0.1,localhost`；**只注入我们拉起的引擎**，对既有引擎给可粘贴指令。
3. 实测：断掉被控端出网后，在中栏发一条**真实模型请求**并收到回答；关掉代理 → 立刻失败且错误可读。

### P4 重连与自恢复（R10）（0.5 天）
1. 转发进程：keepalive + 掉线自动重连 + 指数退避；状态暴露给面板。
2. 前端重订阅：打开中的页面在转发恢复后自动继续（浏览器侧重载/重连策略）。
3. 控制端重启自恢复：按 `~/.ocrc/remote-instances.json` 自动拉起转发（开关）。
4. 三级开关（重连+重订阅 / 重启自恢复 / 操作排队补发）落到实例配置与面板；分别关掉可观察到差别。

### P5 面板与 CLI 化（0.5–1 天）
路由 + CLI + 面板（§3.1/§3.2），把 P1 的手工步骤变成"一次确认 + 一个按钮"。

### P6 终端修复（0.5 天，可与 P5 并行）
选一：① 随包带 `libstdc++.so.6` 并用 `LD_LIBRARY_PATH` ② 用本机 devtoolset-12 重建 `node-pty`（该机已装 g++ 12.1.1，但无共享库，需静态链接）③ 走 Bun（`bun-pty` 自带 `librust_pty.so`）。
不修也可交付（终端面暂缺），但要在面板里**如实标注**"终端暂不可用"。

### P7 文档与门禁（0.5 天）
PRODUCT 第零点十条、OPS 运维段、handoff 验收脚本说明；跑 §5 门禁。

**总计**：约 3–4 天（不含 P6 则 2.5–3.5 天）。

---

## 4.1 P1 执行记录（2026-10-16，实测）

| 步 | 动作 | 结果（证据） |
|---|---|---|
| P1-0 | 引擎探针（候选绝对路径逐一取版本） | `.ocrc-accept/package/bin/opencode → opencode v2.0.27` ✓；`.opencode/bin/opencode → 不存在`；**`.local/bin/opencode → 1.18.32`（被 R12 规则拒绝）** |
| P1-1 | 下载运行时并校验 | `node-v24.22.0-linux-x64-glibc-217.tar.xz` 35.7 MB，`sha256sum -c` → **OK**（官方 SHASUMS256.txt） |
| P1-2 | 解包 | `~/.ocrc/remote/runtime/node-v24.22.0/bin/node --version` → **v24.22.0**；npm 11.19.1；217 MB |
| P1-3 | 装应用 | `npm install -g --prefix ~/.ocrc/remote/openchamber/2.3.3 @openchamber/web@2.3.3`；`cli.js --version` → **2.3.3**；142 个依赖 |
| P1-4 | 启动实例 | `serve --hostname 127.0.0.1 --port 2610`（`OPENCODE_BINARY` 显式 pin v2.0.27、`OPENCHAMBER_UI_PASSWORD`、`OPENCHAMBER_RELAY_HOST=off`）；`/health` → **200**；实例 **PID 40447** |
| P1-4b | 实例自拉引擎 | 日志：`Launching managed server { sourceBinary: '/home/user/.ocrc-accept/package/bin/opencode', args: ['serve','--hostname','127.0.0.1','--port','36273'] }` → `Detected OpenCode port: 36273`（**未碰用户 4096 上的引擎**） |
| P1-4c | 引擎兼容性（R12 的产品内体现） | `GET /api/opencode/compatibility` → `{"state":"compatible","version":"2.0.27","installation":"managed","binary":"/home/user/.ocrc-accept/package/bin/opencode","minimumVersion":"2.0.20"}` |
| P1-5 | 控制端转发 | `ssh -N -L 127.0.0.1:4610:127.0.0.1:2610 user@192.0.2.10`；本机 `4610` LISTENING |
| P1-6 | 经转发探活 | `/api/version` → `openchamberVersion 2.3.3`、能力含 **`api.runtime-url.v1`**；`/health` 200；`/` 200（UI 在 serve） |
| **B1 服务端证据** | 目录来源 = 对端 | 登录 `POST /auth/session` → `{"authenticated":true}`（cookie `oc_ui_session_4610`）；`GET /api/fs/home` → `{"home":"/home/user"}`；`GET /api/fs/list?path=/home/user` → **对端家目录条目**（`.TDC_Viewer`、`.Xauthority`、`.agents`、`.bash_history`…） |
| **B2 服务端证据** | 引擎 = 对端 v2 | `GET /api/session` → 真实会话（`location.directory: /home/user/develop/opencode-plugin/ocrc`，标题如 `e2-baseline`） |
| 待用户 | B1/B2 的界面确认 | 见 §6 B1/B2（浏览器打开 `http://127.0.0.1:4610`） |

**副作用与披露（P1 期间新增，全部可撤）**：
- 被控机新增 `~/.ocrc/remote/`（运行时 217 MB + 应用 + 日志 + dist 缓存）与 `~/.config/openchamber/`（实例自己的数据目录：jwt-secret、preferences、logs、relay 身份密钥、`opencode.managed.json`）；
- 实例在日志里记了一条 **v1 会话导入计划**（"76 OpenCode 1.x session(s) changed since the last v2 import"）——是 openchamber 自己的迁移行为，**只读 v1、写它自己的 v2 存储**；
- **未动**：用户 `~/.local/bin/opencode`(1.18.32)、`~/.ocrc/*.log`、ocrc agent、`~/.opencode/bin`、4096 上那个引擎。
- 撤除：`<prefix>/bin/openchamber stop --port 2610` + 杀控制端转发进程 + `rm -rf ~/.ocrc/remote`（详见 §8）。

---

## 4.2 P2 执行记录（2026-10-17，实测）

**做了什么**：控制端把 runtime（Node 24.22.0 glibc-217，35.8 MB）+ 引擎（opencode **v2.0.27**，201 MB）+ 应用（`@openchamber/web@2.3.3` 交叉装树，56 MB）准备好，经 `ssh` stdin 推到对端 `~/.ocrc/remote/`，对端脚本**只做文件操作与校验**。代码：`src/core/remote-instance-push.ts`（纯函数 + IO）、`src/cli/remote.ts`（`prepare/plan/apply/up/offline-proof/trace-check`）。

| # | 证据 | 结果 |
|---|---|---|
| P2-1 | 交叉装树（控制端 Windows） | `npm -g --prefix <cache>/tree --os=linux --cpu=x64 --libc=glibc @openchamber/web@2.3.3` → 202 包、267 MB；Windows 布局 `node_modules/…` **归一到** `lib/node_modules/…`（远端路径与 P1 一致） |
| P2-2 | 载荷 | 应用 56.2 MB `tar.gz`（sha512 双编码：缓存 marker 用 base64 对齐 npm integrity，推给 `sha512sum -c` 的用 hex）；运行时 35.8 MB（官方 `SHASUMS256.txt` 校验）；引擎走 `core/bin-cache.ts`（registry sha512 校验 + 解包提取） |
| P2-3 | 对端落位 | 三件全部 `已推送`；`~/.ocrc/remote/engine/opencode` = `opencode v2.0.27`；`openchamber/2.3.3/` 只有 `lib/`（根部无 `node_modules`）；换下来的旧树留 `.ocrc-bak` |
| P2-4 | **零联网（结构性）** | `ocrc remote offline-proof`：6 个远程脚本（runtime/app/engine 的 probe+push）零联网命令（curl/wget/npm/git/… 一个不留） |
| P2-5 | **零外联（实测）** | 毒代理 env（`http(s)_proxy=http://127.0.0.1:1`、`no_proxy=127.0.0.1,localhost`）下重装三件全过；`strace -f -e trace=connect` 三份输出经 `ocrc remote trace-check` 判定：**0 次非回环 connect()**（只有 nscd/sss 的 AF_UNIX 探测） |
| P2-6 | 毒代理有效性对照 | 同一环境不加 guard：`registry.npmjs.org` → 200；加 guard → **000**（curl exit 7）。没有这一步，「毒代理下装成功」不成立 |
| P2-7 | 启动与门禁 | `ocrc remote up` → `online（openchamber 2.3.3，引擎 2.0.27 @ /home/user/.ocrc/remote/engine/opencode）`；实例自报 `state=compatible`（R12 ③ 用**实例自报的 binary+version**，不是我们「请求它用」的） |
| P2-8 | 验收脚本 | `bash scripts/accept-remote-instance.sh --target user@192.0.2.10 --offline-proof` 全绿（[1]–[10]；B1 `/home/user` 条目来自对端、B2 `/api/session` 50 条来自对端引擎） |
| P2-9 | 无副作用 | 用户既有 `~/.local/bin/opencode` 1.18.32 md5 未变；4096 上的生产引擎未碰 |

**诚实标注**：对端无 root（`sudo -n` 要求密码），**无法 iptables 真断网**，故离线证据 = ①脚本零联网（结构性，单测 + 脚本双断言）②毒代理下实跑（含有效性对照）③strace 零非回环 connect。三者叠加等价于「装机路径没有网络依赖」，但与「内核层断网」仍不是同一件事，如实记在此处。

**P2 期间抓到并修掉的 6 个真 bug**（都是真机跑出来的，不是推演）：
1. `buildEngineProbeCommand` 把候选路径整体单引号化 → `$HOME` 不展开 → **对端明明有 v1 却报「一个引擎都没有」**（现在用 `"$HOME"'/rest'` 只放行前导变量）；
2. GNU tar(MSYS) 把 `C:\…` 当 `host:file`（"Cannot connect to C:"）→ 打包改用相对名 + cwd；
3. `extractBinary` 在 Windows 需要 `--force-local` **且**正斜杠路径（四种组合实测只有这一种能跑）；
4. 远端 `sha512sum -c` 需要 **hex**，而缓存 marker 是 base64 → 完好的 56 MB 载荷被判「校验不符」（现在 `sha`/`shaHex` 两个字段分开传）；
5. 写 ssh stdin 的 EPIPE 未处理 → 远端脚本早退时 CLI 直接崩（现在回落到退出码 + stderr）；
6. `spawn('npm.cmd')` 在 Windows 无 shell 是 `EINVAL` → 交叉装的 npm 调用改走 cmd 行（只给可能带空格的参数加引号）。

另外修了一个自己埋的坑：`remote-instances.json` 的 100 ms 防抖写入带 `unref()`，CLI 进程活不到写入 → `remote add` 打印了记录却没落盘（现在进程退出时同步 flush）。

---

## 4.3 P3 执行记录（2026-10-17，实测）— R9 出网中继

**机制**：`src/core/remote-instance-proxy.ts`（回环 CONNECT/HTTP 中继，默认**拒绝本机目标**——反向隧道不能变成通往控制端 loopback 的门）+ `buildForwardArgs({reverse})` 把 `-R 127.0.0.1:2711:127.0.0.1:4711` 挂到**同一条 ssh** 上（一条连接两个方向，掉线一起掉、重连只盯一处）+ serve 行注入 `HTTPS_PROXY=http://127.0.0.1:2711`（`NO_PROXY` 恒带 127.0.0.1/localhost）。CLI 侧中继以 detached 进程存活（`ocrc remote proxy-serve`，日志 `~/.ocrc/remote-relay.log`），面板宿主则用进程内同一份实现。

| # | 证据 | 结果 |
|---|---|---|
| P3-1 | 单元测试 | 8 项：CONNECT 解析（含 IPv6 括号）、本机目标识别、隧道实跑（回环靶机）、403 拒绝且不记出网、明文绝对形式转发、裸路径 400 |
| P3-2 | 对端 -R 端口 | 对端 `127.0.0.1:2711` LISTEN（由我们的 ssh -R 建立） |
| P3-3 | 经中继出网 | 对端发起 `HTTPS_PROXY=http://127.0.0.1:2711 curl https://registry.npmjs.org/` → **HTTP 200**，中继日志记到 `CONNECT registry.npmjs.org:443`（= 字节确实从控制端出去，不是对端自己出的网） |
| P3-4 | 注入到位 | 引擎进程 `/proc/<pid>/environ`：`HTTPS_PROXY=http://127.0.0.1:2711`、`NO_PROXY=127.0.0.1,localhost` |
| P3-5 | **真实模型请求（收到回答）** | 经隧道在引擎上建会话并 prompt → 助手消息 `{"type":"text","text":"pong"}`，`model: opencode/ll-alpha-free`，`finish: stop`，tokens 14620/38；同一时刻中继日志出现引擎自己的出网：`CONNECT models.opencode.ai:443`、`mcp.tavily.com:443`、`registry.npmjs.org:443` |
| P3-6 | 关掉即失败（可读） | 杀掉中继进程 → 对端同一请求 `curl: (56) Proxy CONNECT aborted`、HTTP 000、exit 56；中继重新拉起 → 又 HTTP 200 |
| P3-7 | 验收脚本 | `[11] P3 R9 出网中继` 段：中继在听 + -R 在听 + 经中继 200 + 中继日志有 CONNECT + 引擎 env 注入 + provider 判定（空响应/空 provider/非空 三态分开说，不拿空响应当通过） |

**顺带抓到的两个真 bug（都在验收脚本/编排层）**：
- `pgrep -f 'ocrc/remote/engine/opencode serve'` 会把**跑探测的那层 shell 自己**也匹配进去，`break` 抓到错 pid → 读到空值；且 `case` 把空字符串当成「provider 非空」打印了一句假绿。现在按进程名 `pgrep -x opencode` + 以 `HTTPS_PROXY` 过滤，并把「无响应」单列一态。
- `/proc/<pid>/environ` 是 **NUL 分隔**，`grep -a '^HTTPS_PROXY='` 永远不匹配（`^` 只锚文件头）——必须先 `tr '\0' '\n'`。

**未做（如实）**：`-R` 与中继的"控制端重启后自动回位"是 P4 的 `restoreOnStart` 覆盖；中继目前不做目标白名单（只拒本机目标），企业工况若要收紧需要一个允许域名列表——记在 OPS 的"下一版"里。

---

## 4.4 P4 执行记录（2026-10-17，实测）— R10 三级开关

**机制**（`core/remote-instance-bridge.ts` + `core/remote-instances.ts`）：转发进程带 keepalive（`ServerAliveInterval=15/CountMax=3`），异常退出按 `nextRetryDelay` 退避重连（2s→4s→…→60s）；`ensureAll()` 按持久化档案做启动自恢复；三个开关（`reconnect` / `restoreOnStart` / `replayQueued`，默认 **开/开/关**）落在 `~/.ocrc/remote-instances.json`。新增 `ocrc remote switches <id>`（看/改）与 `ocrc remote supervise`（前台监督，无面板机器用；面板宿主 `ocrc start` 里是同一份实现）。**隧道拥有权分两档**：CLI 的 `up` 用 detached（隧道必须比命令活得久），面板/`supervise` 用受监督（进程内、可重连）。

| # | 证据（真机 `user@192.0.2.10`） | 结果 |
|---|---|---|
| P4-1 | ① 重连 **开**：杀掉隧道进程 | `state=offline — 转发断开，2s 后重连（第 1 次）` → 3 s 后 `$ ssh … -L …:4610 … -R …:2711` → `state=online — 转发已恢复（2.3.3）`；4610 重新 LISTENING |
| P4-2 | ① 重连 **关**（**运行中**由另一个进程 `remote switches --reconnect off` 改） | `state=offline — 转发退出（reconnect 关）：exit 4294967295`，20 s 内 4610 一直空——**不重连** |
| P4-3 | ② 自恢复 **开**：只启动 `supervise`，不给 `up` | 隧道自动建立并 online（档案里的 `restoreOnStart` 生效） |
| P4-4 | ③ 排队补发：开关可持久化 | `switches --replay on` 落盘并可读回；补发本身由实例自己的队列行为决定，我们只持久化这个口径（面板里对应 openchamber 的消息队列） |
| P4-5 | host 进程接线 | `src/cli/host.ts` 建 `remoteInstanceManager` + 启动 `ensureAll()` + 退出 `dispose()`（面板/`ocrc start` 的自恢复入口） |

**P4 期间抓到并修掉的 3 个真 bug**：
1. `supervise` 用了 CLI 的 detached 管理器 → 隧道压根不受监督（detached 分支不挂 exit 处理）——现在 supervised 与 detached 分开两个工厂；
2. `supervise` 的日志只进内存、终端看不到 → 重连/退避只能事后翻文件；现在每秒把新日志与状态变化打到终端；
3. **心跳 ticker 被 `unref()`** → 隧道一死、事件循环就空，监督进程正好在「该重连」的时刻自杀（实测表现为「杀了隧道什么也没发生」）；现在刻意不 unref。

另外补了一个跨进程的实时性缺口：运行中的监督进程只读内存档案，`ocrc remote switches --reconnect off` 在另一个进程里改了不生效 → `store.reload()`（有未落盘改动时跳过，避免把刚写的读没）在每次重连决策前重读。

---

## 4.5 P6 结论（2026-10-17，真机实测）— 终端

**实测（EL7 靶机）**：把 `node-pty` 的 prebuild 直接 require，得到的是
`/lib64/libc.so.6: version GLIBC_2.28 not found (required by …/prebuilds/linux-x64/pty.node)`，
同时该 `.node` 还要 `GLIBCXX_3.4.21/22`（宿主最高 3.4.19）。**关键点：卡的是 glibc，不是 libstdc++**
——所以原方案里的「① 随包带较新 `libstdc++.so.6` + `LD_LIBRARY_PATH`」**被证伪**（换 libstdc++
满足不了 `GLIBC_2.28`）。剩下的路只有两条：**按宿主 glibc 重建 `node-pty`**（devtoolset 不动 glibc，
所以可行，但要在构建侧准备工具链）或**走 Bun 的 pty**（bun-pty 自带 rust `.so`）。

**本轮交付**：不猜、也不让用户去撞墙——`buildTerminalProbeCommand` 在 `plan` 里**直接 require 那个
`.node`** 并如实转成一句人能读的话（面板/CLI 的预演里就能看到「终端暂不可用（GLIBC_2.28…）」）。
顺带发现 node-pty 加载器自己那句 `Cannot find module ./prebuilds/linux-x64/pty.node` 是**误导信息**
（文件就在那儿），真错只在 dlopen 时才现形——所以探测刻意绕开加载器。

**顺带修掉一个复发的真 bug**：探测里把带 `$HOME` 的路径整条单引号化 → 远端测的是**字面量路径**，
于是它报「找不到模块」（与 P2 里引擎探针那个 bug 同一类）。现在统一走 `quoteRemotePath`，
并用测试钉住「`$HOME` 必须留给远端展开」。

**修复（2026-10-17 补做，真机验证）**：参考现成先例 [BD7PIL/zcode-legacy-glibc](https://github.com/BD7PIL/zcode-legacy-glibc)
（ZCode 桌面版 remote 在 EL7 上的同款问题：CentOS7 容器 + devtoolset + `-static-libstdc++` 重建 node-pty，
替换进 `~/.zcode/server` 并留 `.official-glibc228.bak`，靠“只比版本号、不比 hash”的部署逻辑保持不被覆盖）。
我们照同思路落地 `scripts/remote-node-pty-glibc217.sh <ssh-target> [--verify|--rollback]`：**在对端就地重建**
（devtoolset-12 + rh-python38 + 我们推的 Node 24 头文件 + 它自带的 node-gyp；node-pty 版本取自对端已部署的包，
所以 openchamber 升级后重跑即可），替换 `<node-pty>/prebuilds/linux-x64/pty.node`，原文件留
`.official-glibc228.bak`。不碰系统库、不装 RPM、不改 openchamber 源码。

证据（对端 RHEL 7.9 / glibc 2.17，node-pty 1.2.0-beta.15）：

- 重建产物 396 KB，**GLIBC 上限 2.14、GLIBCXX/CXXABI 引用 0**（静态链接）。
- `require('node-pty')` → `pty.spawn('/bin/bash', …)` 真起 PTY：输出 `PTY_OK`、`/dev/pts/0`、用户 `user`，退出码 0。
- 服务端端到端：`POST /api/terminal/create`（经 4610 转发、带登录 cookie）返回
  `{"status":"running","mode":"interactive"}`，`GET /api/terminal/sessions` 可见该会话，`DELETE` 返回 `{"success":true}`。
- `--rollback` 还原官方 prebuild 后 `--verify` 如实失败：`符号上限 GLIBC_2.28；GLIBCXX/CXXABI 引用 26`。

取舍：**没有**把重建塞进 `ocrc remote apply`——对端不保证有 devtoolset，编译耗时也不该是默认装机步骤；
它是显式一步（OPS「排障」有命令）。备选路 ③（实例改走 Bun / `bun-pty` 自带 `.so`）仍未做，留作对端无 devtoolset 时的退路。


---

## 4.6 收尾补做（2026-10-17，用户验收前的一轮清理）

### A. 门禁归零（都是平台正确性，不是放宽断言）

| 失败 | 真因 | 修法 |
|---|---|---|
| `git-ops` discard 还原成 CRLF | 测试仓库吃了本机全局 `core.autocrlf` | 仓库内钉 `core.autocrlf=false` / `core.eol=lf`，量的是产品行为 |
| `init-wizard` ×3 读到 `undefined` | 用例把 `/test/.env` 写死，Windows 上产品写的是 `\test\.env` | 期望值改用同一条 `join()` |
| `remotes` 模式 0600 | Windows 无 POSIX mode（读回 0o666），由 ACL 管 | POSIX 上仍断言 0600；Windows 改断言落点 |
| `skills-manager` EPERM | 建符号链接要权限（非开发者模式） | 探测一次，**不支持就 skip 并写明原因**；同时补一条「不支持时 `toggleSkill` 必须如实返回 `{ok:false}`」——这条抓到了真产品缺陷（原先 EPERM 会冒出去，调用方拿到未捕获异常），已在 `toggleSkill` 里改为结构化失败 |
| `routes-light` 期望 500 却得 200 | 「不存在的绝对路径」在 Windows 上 `recursive mkdir` **会直接建出来** | 换成两平台都建不出来的靶子（在一个普通文件下面 mkdir → ENOTDIR） |

**结果**：后端 `1135 passed / 1 skipped / 0 failed`（117 文件全绿）。

### B. 扩展 flake 根因

`src/service/main.test.ts` 起真服务时用 `4600 + random(80)` 选端口，且 `afterEach` 发完 SIGTERM **不等退出**就删临时目录。
并行跑文件时既可能撞端口，也可能请求打到上一个还没退干净的服务（读一个已被删的 profiles 文件）——失败于是随机落在某个用例上，
看起来像断言不符。修法：服务端允许 `OPENCHAMBER_SERVICE_PORT=0` 并**报实际绑定端口**，测试据此连；`afterEach` 等 `exit`（3s 后 SIGKILL）。
**结果**：扩展套件连续 3 轮 `317/317` 全绿。

### C. 中继目标白名单（`proxy.allow`）

- 纯函数 `isTargetAllowed(host, allow)`：**点边界后缀**、大小写不敏感、只留有效条目（全空 = 不限制）；不引入通配符/正则/CIDR。
- 实例档案 `proxy.allow: string[]`；`ocrc remote proxy <id> allow <csv>` / `allow-clear`；`proxy-serve --allow`；面板页无需改（走同一份档案）。
- 拒绝发生在**拨号之前**（CONNECT 回 403、明文回 403），并进日志：`refused target <host>（不在白名单：…）`。
- 单测 11 项（含「表外拒绝且不计入出网」「表内照常走隧道」）。
- **真机证据**：白名单 `api.deepseek.com` 时——表内 `api.deepseek.com` → provider 回 **401**（说明通了），
  表外 `registry.npmjs.org` → `curl (56) Received HTTP code 403 from proxy after CONNECT`；日志记到放行与拒绝两条。清空后 `registry` 立刻恢复 200。
- **运维注意**（写进 OPS）：收紧白名单必须同时放行模型 provider 与引擎基础设施域名（`models.opencode.ai` 等），否则引擎能起不能用。

### D. 「一键 external」落到可负责的边界

调研结论：桌面版的实例列表是 settings 的 `desktopSshInstances`（registry 标注 `scope=instance, owner=desktop-shell, surfaces=[desktop]`），
**桌面外壳独占**；本机只跑过 web 版（`AppData/Roaming/openchamber` 里只有 `install-id-web`）。按猜测的形状写它 = 毁用户配置，不做。
落地的是「把三项算好交出去」：`ocrc remote connect <id> [--json] [--open]` + HTTP `GET /api/remote-instance/:id/connect`
（HTTP 面**不回密码**，只给 `hasUiPassword`，沿用 remotes 的纪律）。同时补了 `manager.probe(id)`：CLI/路由在**另一个进程**里
也能实测「现在到底在线吗」（之前新进程里 `status` 永远 `unknown`——用户真机一看就露）。单测 3 项 + 路由契约 1 项。

### E. 终端修复与验收脚本健壮性（2026-10-17 补做，参考 zcode-legacy-glibc）

- **终端真修**：见 §4.5「修复」段——`scripts/remote-node-pty-glibc217.sh`（对端就地重建 + 备份 + verify/rollback）。
- **验收脚本两处健壮性**：
  ① `[10b]` 的 `TERM_LINE=$(… | grep "终端暂不可用…" | head -1)` 在终端**可用**时 grep 无匹配，
  叠加 `set -o pipefail` 会把整个脚本带停（实测：输出停在 `[10b]`，退出码非零）——补 `|| true`；
  ② `[11]` 的 provider 判定由「一次查询」改为**轮询 60s + 区分鉴权失败**：引擎重启后要读完
  共享目录（`/mnt/hgfs/OpenCodeConfig/.config/opencode/opencode.jsonc`）上的用户配置才出 provider 列表，
  一次判定会把启动竞态误报成「没有 provider」（实测：误报 `[]` 后 10 分钟再查是 deepseek…）。
- **复跑证据**：`ACCEPTANCE OK`；`[10b]` 真起 PTY（`/api/terminal/create → status=running`，已 delete）；
  `[11]` 引擎 provider 非空（deepseek / zhipuai-coding-plan …，经实例 `/api/provider` 即中栏同一通路）。

---

## 4.7 官方 remote 复核（2026-10-17，用户质疑后补做）

§4.6 D 的结论不完整：当时只检查了 web 包和 settings registry，看到 `surfaces=[desktop]` 就把它当成“不可用”，
没有安装桌面壳实测。用户指出“RHEL7 已经装上 openchamber，Windows 这边的 openchamber 就应该能 remote 连上”，
复核后成立。

**实测（Windows 桌面版 2.4.0 ↔ RHEL7 自装 2.3.3）**
- 桌面版 per-user 安装（`OpenChamber-2.4.0-win-x64.exe /S`），读取 `~/.config/openchamber/settings.json`。
- `desktopSshInstances` 写一条：`sshCommand=ssh user@192.0.2.10`、`remoteOpenchamber.mode=external`、
  `preferredPort=2610`、`bindHost=127.0.0.1`；`desktopDefaultHostId` 指向它。
- 启动后桌面壳自己 spawn：`ssh ... -N -L 127.0.0.1:65410:127.0.0.1:2610 user@192.0.2.10`。
- 通过这条隧道：`/api/system/info` → `openchamberVersion 2.3.3, pid 6357`（对端进程）；
  `/api/fs/list?path=/home/user` → 对端目录；`/api/session` → 对端引擎会话（含之前的 `pong`，location `/home/user`）。
- external 模式**不安装、不接管**远端服务；版本不等只影响提示，不阻断（只要求 major=2 + `api.runtime-url.v1`）。

**结论修正**：官方 remote 是可行主路之一，不是只能靠浏览器转发。`ocrc remote connect` 仍不自动写列表
（桌面壳独占 settings），但人工合并已被证明可用；**web 版仍不能做**（SSH 是 Electron IPC，浏览器没有这个桥）。
凭据纪律：`auth.openchamberPassword.store="never"`、不写 `clientToken`，页面首开手输一次。

## 4.8 内嵌试验（2026-10-17，Phase 1 决策门）

问题：扩展 page/panel 能否直接 iframe 对端 UI？**结论：不能。** 运行中的 openchamber 2.3.3 返回的
guest CSP 是 `frame-src 'self' data: blob:`，不允许 `127.0.0.1:4610`；SDK 的 `origins` 能力只放宽
fetch/img/font/style/media，**从不放宽 frame-src**。即使绕过这一层，对端
`frame-ancestors 'self' openchamber-ui://app …` 也与 guest 的 opaque origin（`sandbox allow-scripts`）不匹配。
同一 sandbox 没有 `allow-popups`，`window.open` 也被拦（现在面板的「打开界面」用的就是它，Phase 4 改用
`host.openUrl`）。`service.surface` 是宿主 canvas 像素流，不是 DOM 内嵌，承载完整 UI 等于自造 VNC，v1 不做。

决定：回退桌面版原生 **Remote Instances**；扩展页面展示三项 + 复制 + `host.openUrl` 次入口。证据与复现命令见
[embedding-experiment.md](../research/embedding-experiment.md)。

## 4.9 CI 兼容包（Phase 3，2026-10-17 实测）

- **构建**：`scripts/build-app-pack.mjs` 产出两档（modern / legacy-glibc217）；legacy 调
  `scripts/build-pty-legacy-local.sh` 按宿主 glibc 重建 node-pty 并做 `objdump` 断言。CI 工作流
  `.github/workflows/ocrc-pack.yml`：modern 在 ubuntu + Node 24；legacy 在 centos:7 + devtoolset-11 +
  rh-python38 + glibc-217 Node；发布 GitHub Release `ocrc-remote-pack-<ver>`。
- **控制端**：`ensureAppPack` 依次查缓存 → `OCRC_PACK_DIR` → release manifest（sha512 校验）；
  `ensureAppPayload` 命中即返回，不再 `ensureAppTree`。tier 由 `apply` 的 `probeEnv`（对端 glibc）决定，
  `< 2.31` 走 legacy。
- **证据**：modern 包 53MB（Windows 本机构建，`cli --version` + pty smoke）；legacy 包 54MB
  （从 RHEL7 已修终端的树产出）；两档 `ensureAppPayload` 均走快路径且未创建 cross-install tree；
  RHEL7 真机 `ocrc remote apply --force` 推送成功，重启后远端 `pty.node` GLIBC 上限 2.14、
  `/api/terminal/create` → `running`、fs 90 / sessions 50 / providers 14。
- **Ubuntu 26.04 / glibc 2.43 第二靶机（2026-10-17）**：全新主机 `--provision` 走 **modern** 档
  （日志 `应用包档位：modern（对端 glibc 2.43）` + `应用包已就位`），没有触发控制端跨装；
  对端既有的 `~/.opencode/bin/opencode` 1.18.31 未被选中/改动，门禁选中我们推的 v2；
  `ACCEPTANCE OK`，含 terminal `running`、`-R 2713` 出网 200、provider deepseek、fs/sessions 正常。
  顺带发现并修掉验收脚本的可移植性 bug：Ubuntu 没有 `netstat`，中继端口探测改为有 `ss` 用 `ss`。
- **CI 已实际跑通（2026-10-17）**：三条流水线都在 GitHub Actions 上绿了——`CI`（Node 20/22 两腿）、
  `ocrc-follow`（51s，含引擎 pin 冒烟）、`ocrc-pack`（resolve → modern 27s → **legacy 1m2s** → publish 15s）。
  发布产物：Release `ocrc-remote-pack-2.3.3`，六件资产（两档 tar.gz + sha512 + tier manifest + 合并
  manifest）。控制端**从 Release 取件**两档均通过 sha512 校验（不再依赖 `OCRC_PACK_DIR`）。
  首轮暴露并修掉的 CI 问题：dwf 引擎需在 typecheck 前构建、`dist/` 需在测试前构建、`ocrc-follow` 内联
  脚本缺 import、GitHub 的 Node 24 action 在 glibc 2.17 容器里跑不起来（legacy 改为宿主机 checkout +
  `docker run centos:7`）、`gh release` 缺 `-R`、以及扩展 HostView 测试的渲染时序 flake。

---

## 5. 测试方案（分层）

### 5.1 单元测试（纯函数，不碰网络）
`provision.ts`（工件计划：平台/版本/sha 选择、缺口判定）、`push.ts`（脚本生成与输出解析）、
`launch.ts`（start/stop/status 脚本、PID 与端口解析）、`forward.ts`（端口选择、占用换端口、
重连退避序列）、`proxy.ts`（注入片段生成、NO_PROXY 规则）、`store.ts`（持久化与开关默认值）。
门槛：覆盖每个"失败也要如实报"的分支（无 ssh / 无 tar / sha 不符 / 端口占用 / 版本不符）。

### 5.2 契约测试（HTTP 路由）
沿用 `src` 既有风格（起真实服务 + 断言状态码/错误码）：
无凭据 401、无实例 404、未确认 400（`confirm:true` 门禁）、远端失败 502、
`/status` 在转发断开时如实返回 `degraded`（不得报 ready）。

### 5.3 验收脚本（可复跑，两种靶机）
**已落地**：`scripts/accept-remote-instance.sh`（fail-fast，1–10 步；P2/P3/P4 的步骤**显式打印 SKIP**，不用假绿糊过去）。

```bash
# 本轮（P1 手工装机之后）：显式 pin 引擎路径跑一遍
bash scripts/accept-remote-instance.sh --target user@192.0.2.10 \
  --engine-path /home/user/.ocrc-accept/package/bin/opencode
# 卸载：停实例（保运行时） / 连 ~/.ocrc/remote 一起清
bash scripts/accept-remote-instance.sh --target user@192.0.2.10 --teardown [--purge]
```

覆盖：ssh 与既有资产基线 → 运行时/应用版本 → **引擎 v2 门禁（v1 存在但未被选中）** → 实例 `/health` →
控制端转发（已在监听则复用）→ 经转发的 `/api/version` 与能力 → `compatible`+`2.0.27` →
**B1**（`/api/fs/home` 等于对端 `$HOME`，且对端真实条目出现在实例列举里）→ **B2**（`/api/session` 有数据）→
未实现项 SKIP → 卸载与"既有资产未变"断言（`~/.local/bin/opencode` 版本+md5）。

**脚本自身抓到的问题**：spike 里把解包目录重命名成短名 `node-v24.22.0`，而模块与脚本按 tarball 长名
找 → 第 2 步直接失败。已统一为短名，并把解包改成幂等（`if [ ! -x node-vX/bin/node ]; then … rm -rf … mv …`）。

### 5.4 人工 E2E（3 分钟，交付给用户）
见 §6 B1/B2/C1/C2。

### 5.5 门禁（CI/本地）
`npm run typecheck`、`npm test`（后端）、`cd web-next && npm test`（不回归）、
扩展改动时 `extensions/*` 的 typecheck/test/build + `git diff --exit-code` 产物一致 +
`scripts/check-guest-bundles.mjs`；新增路由的契约测试。

---

## 6. 验收清单（逐条可勾）

**A. 装机与连接**
- [ ] A0 **引擎版本门禁**：目标机只有 v1（或无引擎）时，`plan` 输出"需要先部署引擎"且**拒绝连 v1**；断言文案与实测一致（EL7 上既有 1.18.32 与 v2.0.27 并存时，选中的必须是 v2）
- [ ] A1 `ocrc remote plan <id>` 输出工件（运行时 + 应用 + sha）与落点，无实例时 409
- [ ] A2 未带 `confirm:true` 的 apply 一律 400
- [ ] A3 apply 后远端 `~/.ocrc/remote/runtime/node-v24.22.0/bin/node --version` = `v24.22.0`
- [ ] A4 start 后远端 `curl 127.0.0.1:2610/health` 200；日志里无未处理异常
- [ ] A5 控制端转发建立，`http://127.0.0.1:4610/api/version` 返回 `compatibility` 与能力列表
- [ ] A6 面板/状态里能看到实例所用引擎的**版本 + 来源绝对路径**（≥2.0.20 且 major=2）

**B. 能力条款（本方案的核心）**
- [ ] B1 **Add project**：浏览器打开转发 URL → 目录浏览器列出的是 **EL7 的目录**（能进 `/home/user`）→ 选中 `/home/user/develop/ate` 成功建项目；Files/Git 显示对端内容
- [ ] B2 **中栏对端引擎**：在该项目里发一句话 → 在 EL7 上对应引擎的 `/api/session` 能看到这条会话；模型为对端所配

**C. R6 / R10**
- [ ] C1 断掉被控端出网后：对话仍成功（经控制端代理）；关掉代理 → 立刻失败且错误可读
- [ ] C2 kill 转发 → 自动重连并恢复；重启控制端 → 实例与转发自动恢复（开关开）；三个开关分别关掉可观察到差别

**D. 无副作用**
- [ ] D1 对端既有 `~/.local/bin/opencode`、ocrc agent 文件、`~/.ocrc/*.log` md5 未变
- [ ] D2 卸载后 `~/.ocrc/remote/` 为空、无遗留进程、无开放端口（除用户既有 4096）

---

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| **v1 引擎混入（已发生两次）** | 控制端本机就是活例：`opencode-ai@1.18.31` 在 PATH 上 → openchamber 直接拒绝启动（`Failed to start OpenCode: OpenCode 1.18.31 is installed…`）。缓解：引擎二进制**显式 pin 绝对路径**（无 PATH 解析）、启动前断言 `major=2 && ≥2.0.20`、面板显示版本与来源路径（A0/A6） |
| glibc 2.17 与运行时 | 已验：Node v24.22.0 `glibc-217` 可用（24.14 无此构建）；Bun 1.4.3 为备选 |
| node-pty 需 GLIBCXX 3.4.21/22 | 终端懒加载，不挡启动；P6 三选一修复；未修时面板如实标注 |
| 端口冲突（4096 是用户引擎） | 实例端口与转发端口全部可配；转发侧自动换端口并在面板显示实际端口 |
| 对端资源 | 该机 15.8 GB 内存 / 6 核；实例常驻为单进程；提供"停实例"与"仅装机不常驻"两档 |
| 代理链路的证书/白名单 | P3 必须用**真实模型请求**验；`NO_PROXY` 覆盖本地与内网段；失败信息原样带回面板 |
| 上游版本漂移 | 应用版本 **pin** 在实例配置里；升级是一次显式动作（同 `plan → confirm → apply`） |
| 前提漂移（对端当前能出网） | 离线路线照做；P2 用**真断网**复验，不依赖"当前能不能出网"的假设 |

---

## 8. 回滚与清理

`ocrc remote remove <id> --keep-runtime` / `--purge`：停实例 → 撤转发 → 删应用（`--purge` 连运行时）→
断言 D1/D2。手工等价命令写在 OPS.md 里（`<prefix>/bin/cli.js stop --port N` + `rm -rf`）。
被控端只新增 `~/.ocrc/remote/` 一个目录，删除该目录即完全回到今天的状态。

---

## 9. 明确不做（v1）

不 fork openchamber、不改它的源码；不做 WSL/Docker 的实际支持（配置结构留位）；
不做云端 relay（v1 只保 LAN，跨网单开一轮）；不做手机端新增连接/装机；
不把"能力包"（MCP 运行时补齐/配置同步）并进本方案——它们留在既有扩展面。
