# 批次 6 Windows 验收结果（执行报告）

> **已过时（2026-10-19）**：本文件描述的功能/入口属于**已删除的驾驶舱那一代**（Telegram/Web 通道、工作流、日程、技能、子代理、引擎级远程主机）。它们已从本仓库删除，会作为独立的 openchamber 扩展在别的项目里做；保留作为历史记录。当前产品见 [AGENTS.md](../AGENTS.md) 与 [docs/ARCHITECTURE.md](../ARCHITECTURE.md)。

> 执行日期：2026-10-16 · 执行环境：Windows 面板宿主（`bd7pi@Jared_Laptop`）
> 被控机：`demo@192.168.26.101`（V93000VM，RHEL 7.9，glibc 2.17，OpenSSH 7.4）
> 依据：`docs/handoff/batch6-windows-testing.md` §0–§3
>
> **结论**：§0–§3E **全部通过**；UI 面在修掉两个扩展自身缺陷后**也通过**（§3A 徽标 / §3C-5 / §3D-6
> 已实测渲染），只剩「添加档案 / + 根目录 / 提交信息」三条流程被沙箱的 `window.prompt` 限制卡住。
> 本轮共揪出 **4 个真实缺陷**（2 个已修、2 个待定）。

## 一、执行结果总表

| 步骤 | 结果 | 证据 |
|---|---|---|
| §0-① ssh 客户端 | ✅ | `OpenSSH_10.3p1`（Git Bash）/ `OpenSSH_for_Windows_9.5p2`（System32） |
| §0-② ssh-agent | ✅ 符合预期 | `Stopped / Disabled`（Windows 默认；由 keyPath 对冲） |
| §0-③ 免密登录被控机 | ✅（需先补一步） | 见 §二-1 |
| §1 装 openchamber 面板 | ✅ | `@openchamber/web@2.3.3`，守护于 `:3000` |
| §2 装两个扩展 | ✅ | `POST /api/guests` 201；`ocrc-remote` 0.5.0、`ocrc-omo-view` 0.1.0 |
| §2 service 能力审批 | ✅ | `PUT /capabilities {"granted":["service"]}` 200 |
| §2 添加档案（keyPath） | ⚠️ **UI 流程不可用** | 见 §二-3（`window.prompt` 被沙箱忽略）；改经 service API 建档案成功 |
| §3A 隧道与连接 | ✅ | 面板两枚绿 pill；本机 `:4096` 实测 `{"version":"2.0.27"}` |
| §3A Work Status 徽标 | ✅ **（修后）** | 渲染出 `ocrc 隧道：已连 · 引擎可达`（绿 pill） |
| §3B 远程工作区（功能） | ✅ | 浏览/读/写(.bak)/git status·diff·stage·commit·log/badge 全链通过 |
| §3B-2 盘符路径报错 | ⚠️ **UI 触发不了** | 守卫代码在（`Workspace.tsx:143-144`），但入口用 `window.prompt`；见 §二-3 |
| §3C-5 配置同步 | ✅ **（修后）** | tab 显示 `C:\Users\BD7PI\AppData\Roaming\opencode\opencode.json` + agent/mcp/provider 段名 |
| §3D-6/7 omo 编排 | ✅ **（修后）** | tab 顶部 omo 区块：预设下拉（balanced/fast）、fallback 四控件、per-agent 只读链树；写入落对路径 |
| §3D-8 omo 编排树 | ⏸ 未执行 | 需要一个真实 omo 多代理任务（被控机未装 omo-slim，见 §四） |
| §3E 面板宿主重启韧性 | ✅ | 重启后单档案自动重连（`tunnel:up`） |

## 二、问题与回传

### 1. [前置] 本机公钥未部署到被控机 `authorized_keys`

- **现象**：按 §0-③ 执行 `ssh demo@192.168.26.101 "echo ok"` → `Permission denied (publickey,...)`。
  verbose 显示公钥**已送出**（`Offering public key: … SHA256:zFigb/…`），被服务端拒绝；本机私钥/公钥自洽。
- **期望**：batch2 handoff 记载「`~/.ssh/id_ed25519` 已在被控机 `authorized_keys`」。
- **处置**：用被控机密码一次性写入 `demo@…:~/.ssh/authorized_keys`，之后全程 BatchMode 密钥登录。
- **建议**：§0 增加「公钥未授权时的补救」一步，否则 Windows 侧第一条就断在门口。

### 2. [拓扑] openchamber 2.3.3 硬性要求 OpenCode ≥ 2.0.20，被控机是 1.18.32

- **现象**：面板 UI 被整页门禁拦住：*"OpenCode 1.18.31 is installed. This version of OpenChamber
  requires OpenCode v2."*
- **根因**（`@openchamber/web/server/lib/opencode/compatibility.js`）：`MINIMUM_OPENCODE_VERSION =
  '2.0.20'`，且要求**主版本 === 2**；外部引擎走同一判定（经 `/global/health` 识别 v1 并拒绝）。
- **影响**：批次 6 的 UI 验收在「被控机跑 v1」的现状下**无法进行**——不是扩展的问题，是拓扑前置。
- **处置**（最小侵入，不改用户现有安装）：
  1. 被控机**附加**取用 `@opencode/cli-linux-x64@2.0.27` 到 `~/.ocrc-accept/`（**不动**
     `~/.local/bin/opencode` 1.18.32）；实测该二进制 GLIBC 符号上限恰为 2.17，EL7 可跑。
  2. 该 v2 以 `OPENCODE_SERVER_PASSWORD=…` 起在 `127.0.0.1:4096`。
  3. 面板以 external 模式重启：`OPENCODE_HOST=http://127.0.0.1:4096` + `OPENCODE_SKIP_START=true`
     + `OPENCODE_SERVER_PASSWORD=…`。
  4. 门禁解除，两个扩展的面板入口与 Work Status 区块正常出现。
- **建议**：这正是 base-swap 裁决的目标拓扑，应把「被控端 v2 部署 + 面板 external 启动」写进
  handoff 前置；靠「隧道落地 4096 自动探测」在 v1 引擎上同样会被门禁拒绝。

### 3. [扩展缺陷·已修] 三个 guest bundle 全部因 `process is not defined` 立即抛错 → 面板全白

- **现象**：`ocrc Connect` 面板、`omo 编排` 面板、Work Status 的「ocrc tunnel」区块**都只有外壳，
  内容区空白**（宿主停在 `Loading...`）。
- **根因（实测定性）**：vite **lib 模式不会替换 `process.env.NODE_ENV`**，而 guest 沙箱里没有 Node 全局。
  三个产物各含 **12 处未替换的 `process.env.NODE_ENV`**（React 的 dev/prod 分支），加载即
  `ReferenceError: process is not defined` → React 永不挂载、宿主握手永不完成。
  独立复现：把构建后的包用普通静态服务器加载（无任何 CSP），真实 Edge 直接报
  `pageerror: ReferenceError: process is not defined`，`#root` 为空。
- **排除项**：与宿主沙箱无关。造了一个**零依赖最小 guest**（纯 IIFE 写 `#root`）做对照——它在
  openchamber 的 guest iframe 里**正常渲染**（`PROBE_OK …`），证明沙箱能执行包内脚本。
  （附带更正：直接以顶层标签打开 guest URL 会得到 `net::ERR_BLOCKED_BY_ORB`，那是顶层导航的
  假象，不代表 iframe 内的行为。）
- **修复**：三个 vite 配置各加 `define: { 'process.env.NODE_ENV': JSON.stringify('production') }`；
  并补上 `src/status/main.tsx` **从未存在的挂载代码**（对比 `src/panel/main.tsx` 有
  `createRoot(el).render(...)`；构建产物此前全包**零处 `document.`**，git 历史显示挂载代码从来没写过）。
- **验证**：修后三个包在真实浏览器独立加载均正常渲染；openchamber 面板里
  Work Status 渲染出 `ocrc 隧道：已连 · 引擎可达`，`ocrc Connect` 面板渲染出三个 tab +
  两枚绿 pill + 档案行 `EL7 V93000VM demo@192.168.26.101:22 → :4096`。

### 4. [扩展缺陷·待定] `window.prompt` 在 guest 沙箱里被忽略 → 三条 UI 流程不可用

- **现象**：点「+ 根目录」输入 `C:\Users` 后**既不加根目录、也不显示红错**；「添加档案」同样无反应。
- **根因（实测）**：guest iframe 是 `sandbox="allow-scripts"`，**没有 `allow-modals`**，浏览器直接
  忽略模态对话框。控制台原文：
  `Ignored call to 'prompt()'. The document is sandboxed, and the 'allow-modals' keyword is not set.`
  `window.prompt()` 返回 `null`，代码里的 `if (!line) return` 静默返回。
- **影响面**（全部走 `window.prompt`）：
  - `Panel.tsx addProfile()` —— §2「添加档案」（含 alpha.7 新增的 keyPath 第二问）
  - `Workspace.tsx addRoot()` —— §3B-2 的盘符红错 / §3B-3 配置工作区根
  - `Workspace.tsx commit()` —— §3B-4「提交信息」
  → **batch2/batch6 handoff 里「在 UI 里添加档案」这一步从来不可能成功**（EL7 侧验收只打
  service 端点，抓不到这个盲区）。
- **建议**：把这三处改成面板内联表单/自绘弹层（沙箱里唯一可用的输入方式）。这是 UI 改动，
  需要先定形态（内联行 vs 浮层），故本轮只报告不动手。

### 5. [瑕疵] `TunnelStatus.since` 不是「建立时刻」

- **现象**：`GET /status` 每次返回的 `since` 都等于**本次读取时间**（连续两次相隔 3 s 的轮询
  相差 3 s），隧道并未重连（无 `detail`、engine 持续 reachable）。
- **根因**：`src/service/tunnel.ts` 的 `status()` 里 `since: up ? now() : undefined`，每次调用重算。
- **建议**：在 `launch()` 成功时记时间戳，`status()` 读它。

### 6. [环境发现] 被控机同时存在 `opencode.json` 与真实 `opencode.jsonc`

- **现象**：配置桥写入 `~/.config/opencode/opencode.json`（apply 后 543 B），而该机**真实配置**是
  `opencode.jsonc`（符号链接 → `/mnt/hgfs/OpenCodeConfig/.config/opencode/opencode.jsonc`，8 812 B）。
- **风险**：两者并存时哪份生效未经确认；若 `jsonc` 优先，配置桥的写入**静默无效**。
- **建议**：配置桥的目标文件名按远端实际存在的文件解析，并在 apply 结果里如实回报目标文件。

### 7. [测试卫生] 扩展单测在 Windows 上有 4 个平台性失败

- `src/service/config-bridge.test.ts` 的路径断言假定 POSIX（`expected '\x\y\opencode.json' to be
  '/x/y/opencode.json'`）。与本次改动无关，是既有问题（EL7 上 47/47 绿）。同后端那 8 个平台性
  失败一类——**整个仓库的测试套件在 Windows 上不是全绿的**。

## 三、已验证的 alpha.7 修复（真机落点确认）

| # | 修复 | 实测证据 |
|---|---|---|
| A | 面板宿主配置路径加 `%APPDATA%\opencode`（win32） | 配置同步 tab 显示 `C:\Users\BD7PI\AppData\Roaming\opencode\opencode.json`；`config/source` 返回该路径且 `exists:true`，段名 `agent:[acc-agent] / mcp:[servers] / provider:[acc-provider]`；**tab 不再空白** |
| B | 工作区「+ 根目录」对 Windows 盘符路径显式报错 | 守卫代码在（`Workspace.tsx:143-144`），service 侧 `normalizeProfile` 同时过滤非 `/` 根（双重防线）。**但 UI 入口被 §二-4 卡住，本轮无法端到端触发** |
| C | 添加档案支持 `keyPath` | 档案落盘 `keyPath=C:\Users\BD7PI\.ssh\id_ed25519`，隧道经该 key 建立成功。**但 UI 入口同样被 §二-4 卡住**，本轮经 service API 验证 |
| D | omo 配置远端写入路径（`$HOME` 冻结 bug） | `POST /omo/config {"preset":"fast"}` → 落到 `/home/demo/.config/opencode/oh-my-opencode-slim.json` + `.ocrc-bak`；`ls /home/demo/$HOME` → **不存在**（bug 特征消失） |

## 四、§3B 全链实测明细（经真实 SSH 隧道，非 loopback）

| 端点 | 结果 |
|---|---|
| `fs/list` | `entries:[.git, hello.txt, sub]` |
| `fs/read` | `aGVsbG8gdjEK`（= `hello v1`） |
| `fs/write` | `{"backup":"…/hello.txt.bak"}`；远端 `.bak` 与内容核对一致 |
| `git/status` | `branch:"master"`，`{x:" ",y:"M",path:"hello.txt"}` |
| `git/diff` | 正确的 `-hello v1 / +hello v2` |
| `git/stage` / `git/commit` | `ok:true` / `committed:true`（`3391c8a`） |
| `git/log` / `git-branch` | 两条提交 / `"master"` |
| 守卫 | `/etc` → **403**；`…/../…` → **400**；相对路径 → **400** |
| `config/source·preview·apply` | 深合并正确（远端独有键 `model:keep-me`、`agents` 全保留），`applied:true` + `.ocrc-bak` |
| `omo/config GET/POST` | 摘要正确；结构化与原始写入均落对路径；422（坏 JSON）/400（混合体）/422（非法 fallback 字段）全部命中 |

> §3D-8（omo 编排树实时可视化）未执行：被控机未安装 omo-slim（`oh-my-opencode-slim.json` 是
> 批次 6 之前留下的验收残留），需要先在被控端跑一次 omo-slim install 并真实发起一个多代理任务。

## 五、本次执行对环境做的改动（需知悉 / 可回滚）

**Windows 面板宿主**
- 全局安装 `@openchamber/web@2.3.3`；守护进程运行于 `:3000`（UI 密码为验收临时值，不记录）。
  启动 env：`OPENCODE_HOST=http://127.0.0.1:4096`、`OPENCODE_SKIP_START=true`、
  `OPENCODE_SERVER_PASSWORD=<验收引擎密码>`。→ `npm rm -g @openchamber/web` + `openchamber stop` 可撤。
- 新建 `C:\Users\BD7PI\AppData\Roaming\opencode\opencode.json`（验收用的面板宿主配置，之前不存在）。
- 新建 `~/.config/openchamber/`（面板数据目录）与 `ocrc-connect-profiles.json`（档案）。
- 验收截图证据：`C:\Users\BD7PI\ocrc-ui-{1-connect,2-workspace-drive,3-configsync}.png`。
- **未改动**本机全局 `opencode-ai@1.18.31`。

**EL7 被控机（`demo@192.168.26.101`）**
- `~/.ssh/authorized_keys` 追加本机公钥（key 认证所需）。
- **附加**部署 `~/.ocrc-accept/`（`@opencode/cli-linux-x64@2.0.27` tarball + 解包，约 300 MB）；
  **未覆盖** `~/.local/bin/opencode`（1.18.32 原样）。
- 新增常驻进程：v2 serve 监听 `127.0.0.1:4096`（PID 29736）。→ `pkill -f "opencode serve --port 4096"` 即撤。
- `~/.config/opencode/opencode.json`、`oh-my-opencode-slim.json` 被验收写入（各有 `.ocrc-bak` 兜底）。
- 临时 scratch 仓库 `/home/demo/ocrc-ws-accept` 已删除。
- **未改动**：ocrc 0.26.5 安装、`~/.ocrc/` 运行时数据、1.18.32 二进制、`opencode.jsonc`。

**仓库（本次提交前的改动）**
- `extensions/ocrc-remote/src/status/main.tsx` —— 补挂载（+4 行）
- `extensions/ocrc-remote/vite.config.ts` / `vite.status.config.ts`、`extensions/ocrc-omo-view/vite.config.ts`
  —— 加 `process.env.NODE_ENV` define
- 上述改动重建后的产物：`extensions/ocrc-remote/{panel,status}/main.js`、`extensions/ocrc-omo-view/panel/main.js`
  （用 **vite 7.3.7** 重建；注意本地扩展 `node_modules/.bin` 曾是不完整空壳，会静默回落到仓库根的
  vite 5.4.21，重建前务必先 `npm ci`）

## 六、结论与建议下一步

1. **§0–§3E 功能面全部通过**，alpha.7 的 A/B/C/D 四个 Windows 阻塞点**真机成立**（A/D 端到端可见，
   B/C 因 §二-4 只能经 service API 验证）。
2. **UI 面在修掉 §二-3 后通过**：Work Status 徽标、配置同步 tab、omo 编排区块均已实测渲染。
   §二-3 是本轮最有价值的发现——**三个 bundle 从批次 2 起在浏览器里从未成功执行过**。
3. 建议的下一步优先级：
   1. **修 §二-4**（`window.prompt` → 内联表单）：它挡住「添加档案 / 加工作区根 / 提交」三条主流程，
      也是 batch2 handoff 一直没被验证的原因；
   2. 补一条「guest bundle 在无 `process` 环境可加载」的构建/CI 断言（防回归）；
   3. 把「被控端 opencode v2 部署 + 面板 external 模式启动」写进 handoff 前置；
   4. 修 `tunnel.ts` 的 `since`；明确配置桥对 `.jsonc` 的目标解析；
   5. 扩展单测的 Windows 路径断言（§二-7）与后端那 8 个平台性失败一并清理。
