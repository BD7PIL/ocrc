# openchamber 基座替换可行性调研：功能面 + 扩展缝源码级摸底

> **已过时（2026-10-19）**：本文件描述的功能/入口属于**已删除的驾驶舱那一代**（Telegram/Web 通道、工作流、日程、技能、子代理、引擎级远程主机）。它们已从本仓库删除，会作为独立的 openchamber 扩展在别的项目里做；保留作为历史记录。当前产品见 [AGENTS.md](../AGENTS.md) 与 [docs/ARCHITECTURE.md](../ARCHITECTURE.md)。

- **调研日期**：2026-10-14
- **调研对象**：https://github.com/openchamber/openchamber（MIT，11.5k stars，main @ v2.3.1，2026-10-13 仍在推送）
- **定位**："Agentic Development Environment based on OpenCode AI agent"。与 ocrc 同类：包在 opencode 外面的驾驶舱，server = Express + Node（`@openchamber/web`），前端 = React（`packages/ui`），另有 Electron 桌面壳、VS Code 扩展、iOS/Android 原生 app。
- **方法**：全部结论落到官方文档原文（`packages/docs/content/docs/*.mdx`，即 docs.openchamber.dev 的源文件）或仓库源码文件；引用给出 URL 或 `repo:path`。
- **部署前提（调研期间确定）**：openchamber 本体只跑在 Windows/Mac（Node 24 无障碍）；EL7/glibc 2.17 虚拟机永远当**被控端**。EL7 已实测 opencode v2.0.27 原生可跑。

---

## 0. 一句话结论

openchamber 功能面显著大于 ocrc（终端、扩展系统、移动端、relay、多运行、Fusion、Spaces 容器沙箱、Walkthrough……），但**它没有把自己的 HTTP API 当产品卖**：所有第三方接入缝都是「装进它 UI 里的 iframe 扩展」，不是「连上它 server 的 API client」。第三方 Node 程序想不 fork 深度复用它的 server 能力（goals/multi-run/自动化的服务端实现），**只能 HTTP 层逆向或 fork**；想在它的 UI 里加面板，则有一条文档完备、权限模型严格的官方扩展缝。对被控端 EL7：**managed 模式直接不可行**（要求 Node ≥24.14 + 预装 opencode），正解是 **external（`OPENCODE_SKIP_START`）或纯 SSH 端口转发**，air-gap 形态（被控机零出网）在这两条路上自洽。

---

## A. 功能面全量清点（对照 ZCode 功能矩阵）

### A1. UI 功能

| 能力 | openchamber 有/无 | 证据 |
|---|---|---|
| 聊天流式渲染 | 有。SSE（`/api/event`、`/api/global/event`）+ WebSocket（`/api/event/ws` 等），OpenCode 2.x 单一全局事件流，每帧带 `location.directory` | docs/REVERSE_PROXY.md（端点清单）；`packages/vscode/src/DOCUMENTATION.md`（"OpenCode 2.x has one global stream, GET /api/event"） |
| 工具卡 | 有。内置工具卡 + 扩展可用声明式 `tools` 块为自己的 MCP/OpenCode 工具定义图标/标题/输出布局（table/json/markdown/code），零代码 | docs sdk.mdx §"Your tools in the chat"（repo: packages/docs/content/docs/sdk.mdx） |
| Markdown 管线 | 有。`MarkdownRenderer`/`MarkdownRendererImpl`/`markdown/decorate.ts`/图片画廊/图片授权路由（`markdown-image-grants/`） | `packages/ui/src/components/chat/MarkdownRenderer.tsx` 等；`packages/web/server/lib/markdown-image-grants/` |
| 会话列表/搜索 | 有。侧栏会话列表（Timeline 模式、置顶、归档、In-work 分区）+ 消息搜索（`server/lib/message-search/`，14 文件） | docs chats.mdx；`packages/web/server/lib/message-search/` |
| 分屏 | **无真分屏**。有 header 会话标签页（`SessionTabsStrip`）、multi-run 侧栏合行 + overview 屏、右栏多 tab；未见左右双会话同屏组件 | `packages/ui/src/components/layout/SessionTabsStrip.tsx`；`packages/ui/src/lib/multirun/runs.ts` |
| 文件浏览 | 有。侧栏文件树（`SidebarFilesTree`、`views/files/` 全套）+ 内置文件编辑器（文本/二进制、source 切换、全屏、保存）+ 扩展可注册自定义文件编辑器（`fileEditors`） | `packages/ui/src/components/views/files/`；docs sdk.mdx §"An editor for your file type" |
| Git 集成 | 有。右栏 Git tab：staged/unstaged 分组、stage/unstage、commit（AI 生成 commit message）、分支/历史/stash/push/pull、冲突交 agent 解决、git identities | docs git.mdx；`packages/web/server/lib/git/`（61 文件） |
| diff / Changes Walkthrough | 有，且是特色：Walkthrough 把 diff 重排为「stops」（Key change/Context 标签），锚定代码内容检测 Outdated/Not covered，按 diff 内容缓存、支持多语言/换模型重生成；scope：全部未提交/staged/unstaged/本分支/PR | docs walkthrough.mdx；`packages/web/server/lib/walkthrough/`（24 文件） |
| 权限/审批交互 | 有。三模式：Ask every time / Safety net（Jev 分类模型 4 秒内放行常规操作、拦危险操作，无分类器则禁用）/ Accept everything；模式存 server 端，关标签页仍生效；VS Code 无 safety net | docs permissions.mdx；`packages/web/server/lib/permission-auto-accept/` |
| 终端 | **有**。node-pty + `bun-pty` 后端（`server/lib/terminal/`：runtime/shells/history/ws-protocol），前端 xterm 系（`TerminalView`/`TerminalViewport`/ghostty 链接）；反代需单放 `/api/terminal/ws` | `packages/web/server/lib/terminal/DOCUMENTATION.md`；docs REVERSE_PROXY.md |
| 设置面（provider/model/agent） | 有。Providers 页（API key 或 device-flow 登录、自定义 OpenAI-compatible provider、`{env:VAR}` 引用）、Agents 设置、MCP、Skills + Skills Catalog、Commands & Snippets、Auto Model Routing、Classification Providers（Jev） | docs providers.mdx、mcp.mdx、skills.mdx、auto-model-routing.mdx、classification-providers.mdx |
| 命令面板 | 有。CommandPalette 组件 + Mod+K 系快捷键（如 ⌘K→B 开 Issues/PRs 板） | `packages/ui/src/components/ui/CommandPalette.tsx`；docs issues-and-prs.mdx |
| 快捷键 | 有。可自定义（`KeyboardShortcutsSettings.tsx`、`ShortcutRecordingDialog.tsx`、Mod+N 新会话） | `packages/ui/src/components/sections/openchamber/KeyboardShortcutsSettings.tsx`；docs chats.mdx |
| 移动端/PWA | 有，且是强项。原生 iOS（TestFlight）/Android（APK）app + 浏览器 PWA 安装；QR 一次性配对、每设备独立可吊销 token；移动端不加载扩展、不能发起 multi-run | docs mobile.mdx、connect-devices.mdx；`packages/mobile/` |
| 语音 | 有。听写（dictation/，sherpa-onnx 本地）+ TTS（tts/）+ OpenAI 直接调用（`OPENAI_API_KEY`） | `packages/web/server/lib/dictation/`、`tts/`；docs environment 页 |
| 通知 | 有。Web Push（`web-push` 依赖）、goal 完成推送、权限请求通知 | `packages/web/server/lib/notifications/`（23 文件）；docs notifications.mdx |
| 容器沙箱（Spaces） | 有（实验，默认关）。agent 在 Docker 容器副本里干活，gatekeeper 容器做唯一出口（仅 443 + 域名 allowlist + 屏蔽私网/元数据），完成后以分支或未提交变更 apply 回仓库；镜像约 1.6GB | `packages/web/server/lib/spaces/DOCUMENTATION.md` |

### A2. 自动化

| 能力 | 有/无 | 机制（一手证据） |
|---|---|---|
| 定时任务 | 有 | UI 建任务：daily/weekly/once/任意 cron，指定 prompt+provider+model+agent，到点自动开新会话发 prompt；**Loops**：任务可以是 `.agents/loops/*.md` markdown 文件（project 或 `~/.agents/loops` 作用域，frontmatter 含 name/schedule/model/agent/timezone，默认关闭需手动启用，文件为权威、运行态存项目配置）；只在 server 存活时触发。证据：docs scheduled-tasks.mdx；实现 `packages/web/server/lib/scheduled-tasks/`（runtime.js/loops.js/routes.js） |
| Session Goals（目标持续推进） | 有 | composer 目标按钮武装后首条消息即 objective；server 端循环（关浏览器仍跑）：agent 停 → 小模型/Jev 审计（只看 objective+最新回复）→ keep-going 则自动续发 / done 通知 / 连续 3 次 stuck 判 blocked；硬停：token 预算、自动续发上限、turn 错误；每会话一个 goal。存储：**goal 状态存 opencode session 的 `metadata.openchamber.goal`**，长 objective 存 `<data-dir>/goals/<sessionId>.md`。证据：docs session-goals.mdx；`packages/web/server/lib/session-goal/DOCUMENTATION.md` |
| Multi-run | 有 | 一个表单把同一 prompt（或多个变体）发给多个模型，每 lane 一个独立会话（可各配 worktree 分支隔离）；成员关系存 `session.metadata.openchamber.multirun`（UUID group、g1/g2 变体名、run/fusion 角色）；Keep 时非保留 lane 快照到 `refs/openchamber/runs/<group>/<session>` 后归档+删 worktree。**这是 UI 编排，非 server 常驻**：`createMultiRunStore` 在前端逐 lane 建 session 发 prompt。证据：docs multi-run.mdx；`packages/ui/src/lib/multirun/DOCUMENTATION.md` |
| Fusion（多模型合并） | 有（multi-run 附属） | 两模式：**answers**（judge 模型拿各 lane 最终回复合成答案，在项目目录）/**code**（每 lane worktree 快照到 git ref → judge 得到独立 worktree（从共同起始 commit）+ manifest（回复/diffstat/快照 commit），diff 小于 judge 上下文 10% 才内联，否则 judge 用 git 自查 → 在新 worktree 里重建合并结果）。autoFusion：全部 lane 跑完自动触发。**全部在前端 `fusion.ts` 实现**，server 无对应模块。证据：`packages/ui/src/lib/multirun/fusion.ts`、`autoFusion.ts` |

### A3. 集成

| 能力 | 有/无 | 证据 |
|---|---|---|
| GitHub | 有。Settings→Integrations device-flow 连接（可多账号，gh CLI 兜底）；从 issue/PR 起 worktree 会话（PR 可带 diff）；PR 创建/更新/ready/merge + AI 生成标题描述；消息可附 issue/PR 作上下文 | docs github.mdx；`packages/web/server/lib/github/`（24 文件，@octokit/rest） |
| GitLab | 有。Issues/PRs 板支持 GitLab（merge requests）；`@gitbeaker/rest` 依赖 + `server/lib/gitlab/`（23 文件） | docs issues-and-prs.mdx；`packages/web/package.json`；`packages/web/server/lib/gitlab/` |
| Linear | 有。Issues 板内置 Linear tab（多 workspace、状态/优先级过滤、从 Linear issue 起会话）；扩展可复用 Linear 账号（`host: {provider: "linear"}`） | docs issues-and-prs.mdx；`packages/web/server/lib/linear/`（21 文件）；docs sdk.mdx |
| VS Code 扩展 | 有（Marketplace，`openchamber-2.3.1.vsix`）。整个 openchamber UI 作为 webview 跑在扩展里，`bridge.ts` + 域模块（git/fs/config/proxy/SSE 代理）在 extension host 侧补齐 server 缺的本地能力；自己管理/拉起 opencode（managed-opencode-process）；依赖 `@opencode/client`；无 chats、无 safety net、无扩展加载、无 Walkthrough/mobile | `packages/vscode/src/DOCUMENTATION.md`；`packages/vscode/package.json`；docs permissions.mdx/walkthrough.mdx/extensions.mdx 的 VS Code 限制段 |
| Preview（应用内预览） | 有。浏览器面板（globe 按钮）自动发现本机监听端口（"looking at what is actually listening on your machine"）打开 dev server；终端里点本地地址、project action auto-open、聊天中本地链接都会自动开；**桌面版**远程实例场景自动建本地端口转发到远端 dev server（热更新/DevTools 可用）；Browser Panel 支持指向元素/画标注发给 agent、agent 驱动浏览器（`browser-control/`；扩展 service `provides:["browser"]` 可替位）。Web 版只能开本机 dev server | docs preview.mdx、desktop-browser.mdx；`packages/web/server/lib/browser-control/`、`dev-servers/` |
| 其他 | Worktrees（从 todo/issue/PR/扩展起 worktree 会话、Integrate 回主分支）、Magic Prompts（可覆盖的 prompt 模板）、Project Actions、Agent Control Tool、Auto Model Routing、Voice、Project Icons、Repository Config（`.openchamber/project.json` 团队共享配置） | docs 索引页各篇（packages/docs/content/docs/） |

### A4. 远程

| 能力 | 有/无 | 证据 |
|---|---|---|
| Remote Instances | 有，**desktop-only**。Settings→Remote Instances 加 SSH 命令+昵称；两模式：**managed**（openchamber 在远程机自装自启）/ **external**（连已运行实例）；向导式连接→provision→起 server→端口转发（SSH ControlMaster 支持 `-O forward`）；server 常驻远程、SSH 断了还在 | docs remote-instances.mdx；`packages/electron/ssh-manager.mjs` |
| Private Relay | 有。server 主动出站连 relay 基础设施并保活，设备侧也连 relay，端到端加密（relay 是"盲信使"）；按需自启/自停；密钥在 `~/.config/openchamber/relay-identity.json`；企业模式可自建 relay（`OPENCHAMBER_RELAY_URL`，开源 relay 仓库 openchamber/openchamber-relay） | docs private-relay.mdx、security.mdx；`packages/web/server/lib/relay/`（23 文件） |
| connect-devices | 有。QR 一次性配对（过期作废、单次有效），每设备独立 client token（与 UI 密码分离、重启存活、可吊销）；CLI：`openchamber connect-url --port 3000 [--relay] [--qr] [--api-only] [--lan]`；`openchamber://connect?v=2&p=...` 深链 | docs connect-devices.mdx |

#### managed 模式在远程机器上到底装什么（源码级）

证据：`packages/electron/ssh-manager.mjs`（全部为该文件行号）：

1. **安装**（`installOpenChamberManaged`，L1089-1126）：远程机需有 **bun 或 npm**（bun 优先，npm 可经 nvm 发现），执行 `bun add -g @openchamber/web@<version>` 或 `npm install -g --prefix ~/.openchamber/npm-global @openchamber/web@<version>`。**装的是整个 openchamber server 包**，不是轻量 agent。`@openchamber/web` 的 `engines: node >=24.14.0`（`packages/web/package.json`），即**远程机需要 Node ≥24.14（或 Bun）**；脚本不做 glibc 检查，Node 24 官方二进制本身要求 glibc ≥ 2.28。
2. **前置条件**（`startRemoteServerManaged`，L1168-1196）：远程机**必须已装 opencode CLI**（`resolveRemoteTool 'opencode'` 找不到就报错 "The opencode CLI is not installed on the remote machine. Install it there, then connect again"）。**managed 流程不负责装 opencode**。
3. **拉起**（L1187-1192）：`openchamber serve --hostname 127.0.0.1 --port <p>`，环境 `OPENCODE_BINARY=<远端opencode路径> OPENCHAMBER_RUNTIME=ssh-remote`（+可选 UI 密码）；openchamber server 自己再拉起/监管被控机上的 opencode。远程 server 是 daemon，SSH 断开仍存活（`adoptRunningRemoteServer` 注释）。
4. **端口**：本地桌面通过 SSH `-L` 转发远程 127.0.0.1:port 到本机（`spawnMainForward`，L1206+）；另支持 extra forwards：local（-L）/ **remote（-R）**/ dynamic（-D）三种类型（L1240-1243，L806）。

**结论**：managed 模式往远程机装的是「整个 openchamber（Node 24 运行时）+ 要求预装 opencode」，被拉起的是完整 openchamber server（内含对 opencode 的托管）。EL7（glibc 2.17）装不了 Node 24 官方发行版 → **managed 对 EL7 不可行**。

---

## B. 扩展缝源码级摸底

### B1. packages/sdk：它是什么、不是什么

- **`@openchamber/sdk` 是「面板扩展 SDK」，不是 API client**。`packages/sdk/package.json`：description = "Contract for OpenChamber guests: manifest parse and iframe host bridge."，唯一依赖 zod。导出（`packages/sdk/src/index.ts`）：manifest schema/zod schemas、`connectHost()` iframe 桥（host.ts，1172 行，基于 `window.parent.postMessage('*')` 的 request/response 协议）、guest frame policy、UI kit（`@openchamber/sdk/ui`：button/badge/banner/checkbox…）。
- **它不是 `@opencode/client` 的 wrapper，也与 `@opencode/client` 无关**：sdk 的 dependencies 只有 zod。`@opencode/client@2.0.27`（**官方 opencode 包，pin 到 opencode 2.0.27**）被 `packages/web`（server 自己连 opencode 用）、`packages/vscode`、`packages/ui` 直接依赖。
- **第三方 Node 程序能否直接用它连 openchamber server？——不能（无官方路径）**。SDK 的 `connectHost()` 只能在 openchamber 的沙箱 iframe 里工作（文档原文："connectHost only works inside OpenChamber. Opened as a plain file, every call rejects with HOST_UNAVAILABLE"，docs sdk.mdx）。openchamber server 的 HTTP 面（`/api/event`、`/api/openchamber/*`、`/api/fs/*`、`/api/goals/*`…）是给它自己的前端和扩展 iframe 的，**没有公开、无版本承诺的对外 API 契约**（SDK API.md 描述的是 iframe 桥，不是 HTTP）。
- **认证**：三层。① UI 密码（`OPENCHAMBER_UI_PASSWORD`）→ `POST /auth/session` 换 cookie/JWT（`OPENCODE_JWT_SECRET` 签名；TTL：普通设备 12h/信任设备 7d）；passkeys 支持（WebAuthn，`@simplewebauthn/server`）。② 配对设备 client token（与 UI 密码分离，可吊销）。③ 扩展 iframe 内由 host 代理外部 API 调用，token 永不进 iframe（docs sdk.mdx "Accounts and network"）。企业模式还有策略文件。

**判定：能（有条件）** —— 第三方可以拿 `@openchamber/sdk` **给 openchamber 写扩展**（这是一等公民缝）；**不能**拿它当 API client 连 server；想程序化连 server = 走未承诺的内部 HTTP API（能通但属逆向，随版本可破）或 fork。

### B2. CUSTOM_THEMES 与 REVERSE_PROXY

- **主题系统：只能配色，不能改布局/注入组件**。`docs/CUSTOM_THEMES.md`：JSON 主题文件放 `~/.config/openchamber/themes/`（≤512KiB，metadata.id/name/variant + colors：surface/primary/interactive/status/pr/chat/markdown/tools/syntax + config.fonts/transitions）；支持从 Open VSX 导入 VS Code 主题（服务端转换 TextMate/semantic token）。**没有任何布局/组件/CSS 注入缝**——想要「换肤」级别的定制只能改 `packages/ui` 源码（fork）。
- **反代自托管（docs/REVERSE_PROXY.md）**：暴露的实时端点全表——WS：`/api/event/ws`、`/api/global/event/ws`、`/api/terminal/ws`；SSE：`/api/event`、`/api/global/event`、`/api/notifications/stream`、`/api/openchamber/events`。要求：WS 升级、SSE 不缓冲（`X-Accel-Buffering no`）、大 body（附件）、长 read timeout、单层压缩（openchamber 自带 gzip ≥1KB）。附 Nginx/NPM/Caddy 完整示例。

**判定**：主题缝 = 只能换肤（能）；布局/组件定制 = 要 fork。反代缝 = 完整文档化（能）。

### B3. 插件/扩展机制（openchamber 自己的）

**有，且相当深**——但注意 docs 明说 "They are not the same thing as OpenCode plugins"（扩展 ≠ opencode plugin，两者独立存在；openchamber 对 opencode 侧另有 managed plugin 物化：`packages/web/server/lib/opencode/managed-config-file.js` 把 agent tools 生成插件目录写给 opencode 加载）。

**openchamber 扩展形态**（docs/extensions.mdx + docs/sdk.mdx，一手全文）：

- 一个目录：`package.json`（`openchamber` manifest 块，apiVersion=1）+ `panel/index.html` + IIFE main.js，跑在**沙箱 iframe**（origin null，fetch 默认仅包内资源）。
- 安装：Settings→Extensions 粘贴**文件夹绝对路径 / .zip / https git URL（可 #tag）/ SSH git 地址**；git 安装支持自更新（每小时检查）+ 权限升级再审批；企业模式限管理员列表。内置扩展走 `packages/extensions/registry.json`（当前 `{"version":1,"extensions":[]}`，**registry 为空**，builtin 扩展由构建脚本 `scripts/build-builtin-extensions.mjs` 生成）。
- 能力模型（capabilities，装时一次性审批）：`prompt`（写/发消息）、`sessions`（列项目/worktree/会话态、跨项目建会话）、`files`（项目内读写）/`filesystem`（声明 pattern 的项目外路径，原子写、2MB 上限）、`model`（Small Model 一次性生成）、`shells`（看/读/停 agent 的后台 shell）、`network`(integration)、`origins`（≤8 个 https 域）、`service`、`conversation`（session action 带 payload 时读全对话）。未授权调用返回 `NOT_GRANTED`。
- UI 注入点（都很深）：右栏 panel、+菜单 attach、全屏 page、Work Status 自定义 section（`statusSection`）、**自定义文件编辑器**（`fileEditors`，文本+二进制，接管 Cmd+S/autosave）、消息/会话右键 actions（可带全对话 payload）、slash 命令（`/task ABC-12` 解析成 chip）、rail 徽标、声明式工具卡。live-view：扩展可接管/让出 agent 的浏览器画面（Hand back to agent）。
- **本地 service**（`contributes.service`）：openchamber 替扩展拉起本机进程（用户全权限、无沙箱、审批警告），可 `provides:["browser"]` 顶替 agent 浏览器。例：`packages/sdk/examples/` 下 9 个完整示例（browser-provider-stub、git-graph-status、checklist-editor、tasks-demo、hello-kit…）。
- **扩展能落持久数据**：`host.storage` 存在 server 侧，随扩展删除而删。
- 明确不支持：VS Code 与 mobile **不加载扩展**。

**VS Code 扩展（第一方）与 server 通信**：不是 iframe 扩展那套——它在 extension host 里跑 `bridge.ts`，webview 消息由 bridge 在本地补齐（git/fs/config 直读本地），SSE 用 `sseProxy.ts` 代理 opencode 的 `/api/event`，`/api/<x>` 原样转发到 opencode 2.x（"OpenCode 2.x serves its own routes under /api"，`packages/vscode/src/DOCUMENTATION.md`）。**没有浏览器扩展**（仓库无 chrome/web extension 目录）。

**判定：能** —— 这是 openchamber 唯一文档化、带版本契约（apiVersion）和权限模型的第三方缝，深度足够注入 UI 与行为；但它只存在于 web/desktop 前端层，**够不到 server 的会话循环本身**。

### B4. docker-entrypoint.sh 与 Docker 支持

- **镜像发布**：**无官方预构建镜像**。仓库无 GHCR/Docker Hub 发布 workflow（release.yml 只发 desktop/npm/tgz/移动端；`gh search code ghcr.io/openchamber` 零命中）；根目录只有 `Dockerfile` + `docker-compose.yml`（`build:` 本地构建）。发布渠道实为：npm（`@openchamber/web`，157 个版本，dist-tags latest=2.3.1）、GitHub Releases（dmg/exe/AppImage/vsix/apk/tgz）。
- **容器里跑什么**（`Dockerfile` + `scripts/docker-entrypoint.sh`）：`oven/bun:1.4.2` 基镜像；builder 阶段构建 sdk+web；runtime 层 apt 装 nodejs/npm/git/openssh-client/python3/cloudflared，**全局预装 `@opencode/cli@2.0.27`**；entrypoint 生成 ed25519 SSH key、映射 `UI_PASSWORD`→`OPENCHAMBER_UI_PASSWORD`、可选装 oh-my-opencode、默认 `OPENCHAMBER_HOST=0.0.0.0`，最后 `exec bun packages/web/bin/cli.js` ——**容器里是「bun 跑的 openchamber server」这一个主进程**，由它再托管容器内的 opencode。
- **卷**（docker-compose.yml）：`./data/openchamber→~/.config/openchamber`（其全部自有数据）、opencode 的 share/state/config 三目录、`./data/ssh`、`./workspaces`（工作区）。compose 注释给出连外部 opencode 的开关：`OPENCODE_HOST=http://172.17.0.1:4096` + `OPENCODE_SKIP_START=true`；0.0.0.0 暴露时强制要 UI 密码。
- **tag 策略**：无（无镜像）；版本对齐 = npm `latest` + GitHub tag `v2.3.1`，opencode pin 2.0.27。

**判定：能（自构建）**——Docker 路径存在但纯 DIY（`docker build .`），且容器内仍是 openchamber 全家（bun + nodejs 双运行时），对被控端是重方案。

### B5. 会话数据模型：openchamber 自己存什么

- **自己有数据目录** `~/.config/openchamber/`（`OPENCHAMBER_DATA_DIR` 可改），内含（多处一手证据汇总）：`chats/`（非项目聊天的一次性文件夹，`OPENCHAMBER_CHATS_DIR`）、`themes/`、`goals/<sessionId>.md`（goal objective 正文）、`projects/<projectId>.json`（worktree setup 命令/project actions/draft starters，≤200 字符名超限用 `path_sha256_<digest>.json`）、`quota/`（exe-dev/zenmux 等 usage 凭据）、`relay-identity.json`（relay 密钥）、extensions 安装副本、settings、配对设备 token。**没有整体数据库**——是「文件目录 + opencode 自身存储」的组合。
- **会话/消息本体不存**：全部读 opencode 的存储（opencode 2.x 自己的 session store）；openchamber 只往 **session 的 `metadata.openchamber.*` 命名空间**写自己的标记（goal 状态机、multirun 成员关系），经自己的 merge-patch 路由 `/api/openchamber/sessions/:id/metadata`（RFC 7386）或 opencode 建会话时携带。
- goals 循环状态：`metadata.openchamber.goal`（id/objective/status/tokenBudget/tokensUsed/auditFailStreak/…，见 `session-goal/DOCUMENTATION.md`）；objective 长文外置 `goals/<sessionId>.md` 防止 metadata 膨胀。
- multi-run 记录：`metadata.openchamber.multirun` + git 快照 ref `refs/openchamber/runs/<group>/<session>`；lane 归档态由「无活跃成员即解散」推导，无独立 resolved 存储multirun（`multirun/DOCUMENTATION.md`）。
- 成本遥测：**没有自有成本账本**。Usage 页是对各 provider 配额 API 的实时拉取（`server/lib/quota/`，26 个 provider 适配器，凭据多来自 opencode `auth.json`），不是本地聚合统计；goal 的 tokensUsed 是从 opencode 会话快照差分算出来的。

### B6. 环境变量全集

来源：docs.openchamber.dev/zh-cn/environment/（即 `packages/docs/content/docs/environment.mdx`）。除 `OPENCODE_HOST`/`OPENCODE_SKIP_START` 外的关键项：

- **server**：`OPENCHAMBER_HOST`（监听地址）、`OPENCHAMBER_UI_PASSWORD`、`OPENCHAMBER_UI_SESSION_TTL_HOURS`(12)/`OPENCHAMBER_UI_TRUSTED_SESSION_TTL_DAYS`(7)、`OPENCHAMBER_API_ONLY`（无头，API 仍在）、`OPENCHAMBER_FRAME_ANCESTORS`（iframe 白名单）、`OPENCHAMBER_DATA_DIR`/`OPENCHAMBER_CHATS_DIR`、`OPENCHAMBER_LAN_URL`、压缩开关、`OPENCHAMBER_UPDATE_API_URL`。
- **opencode 托管**：`OPENCODE_PORT`、`OPENCHAMBER_OPENCODE_HOSTNAME`、`OPENCODE_BINARY`、`OPENCODE_CONFIG`、`OPENCODE_CONFIG_DIR`、`OPENCODE_DATA_DIR`、`OPENCODE_WSL_DISTRO`。
- **auth**：`OPENCODE_JWT_SECRET`。
- **终端/git**：`OPENCHAMBER_TERMINAL_SHELL`、`OPENCHAMBER_GIT_BINARY`（`GIT_BINARY` 兜底）。
- **代理**：`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`（**server 自身出站生效**，loopback 恒直连；`packages/web/server/lib/outbound-proxy.js`：`http.setGlobalProxyFromEnv`，Node 24/Electron 生效，Bun fetch 直接读变量）。
- **relay/enterprise**：`OPENCHAMBER_RELAY_URL`（自建 relay）、`OPENCHAMBER_JEV_URL`、`OPENCHAMBER_ALLOW_NETWORK_ACCESS`、`OPENCHAMBER_ALLOWED_EXTENSIONS`、`OPENCHAMBER_ALLOW_LOCAL_EXTENSIONS`（security.mdx 企业模式段）。
- **voice**：`OPENAI_API_KEY`、`OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS`；**tunnel**：`NGROK_AUTHTOKEN` + compose 里的 `OPENCHAMBER_TUNNEL_PROVIDER/MODE/HOSTNAME/TOKEN/CONFIG`（cloudflared）；**运行时**：`BUN_BINARY`/`BUN_INSTALL`、`VITE_OPENCODE_URL`。

---

## C. EL7 被控端接入路径判定（单列结论节）

前提：EL7 = glibc 2.17、kernel 3.10；opencode v2.0.27 已实测可跑；openchamber 面板只在 Win/Mac。**openchamber 的远程模型是「SSH 通 + 远程 127.0.0.1 有个 HTTP 服务可转发」**，桌面端对被控机本身的假设只有这两条（`ssh-manager.mjs` 全文无一处 glibc/发行版检查，探测用 curl/wget）。

### 路径 1：managed 全装 —— **不可行**

- 被控机要装完整的 `@openchamber/web`（`ssh-manager.mjs:1098-1101`），其 `engines.node >=24.14.0`（`packages/web/package.json`）；Node 24 官方 Linux 二进制要求 glibc ≥2.28，EL7 无解（源码编译不现实）。安装动作发生在**被控侧**（SSH 过去跑 bun/npm install，需要被控机能出网到 npm registry）→ **air-gap 形态 B 下双重不可行**。
- 即使有网，还要求被控机预装 opencode CLI（L1180），且 openchamber 版本必须与桌面端一致才被 adopt（L1317 前后）。

### 路径 2：external（裸 opencode serve）—— **可行（推荐基线）**

- 文档一手支持：`OPENCODE_HOST=http://<host>:4096 OPENCODE_SKIP_START=true openchamber`，面板宿主连「你已经在跑的 server」；auto-detect 默认端口 4096（docs opencode-server.mdx）。Remote Instances 的 external 模式同构：SSH 进被控机探活 `http://127.0.0.1:<port>/health` + `/api/system/info`（`ssh-manager.mjs:1129-1140`）再 `-L` 转发。
- 被「连」的对象是 opencode 本身（openchamber server 对 opencode 的全部读写在 HTTP 上，proxy 层原样转发 `/api/*`）。**被控机只需跑 `opencode serve`，无 Node 24 要求（opencode 单二进制在 EL7 已验证）**。注意 probe 脚本打的是 openchamber 端点，external 一台裸 opencode 时走的是「桌面→SSH→-L→被控 opencode」还是「面板 openchamber→OPENCODE_HOST」两条不同链路：前者 desktop Remote Instances 预期对端是 openchamber（probe `/api/system/info`），**对裸 opencode 要用 `OPENCODE_HOST` 方式（面板宿主的 openchamber 指向被控 opencode）**，这正对应形态 (A) 有网被控机：面板 openchamber 在 Win/Mac，被控 EL7 只跑 `opencode serve --hostname 127.0.0.1` + SSH `-L`/`-R` 把端口送到面板侧。
- **air-gap 形态 B 自洽性**：openchamber 对「被控 opencode 的 LLM 出网」无任何内置隧道——LLM 流量从 opencode 进程直接出（provider 调用在 opencode 侧）。官方给的唯一代理位是环境变量 `HTTP(S)_PROXY`/`NO_PROXY`（server 出站走它；被控 opencode 是 openchamber 的子进程时继承环境，`lifecycle.js:778` `inheritedEnv = overlayEnvironment({...shellEnv, ...process.env...}, getUserEnvironment())`），且 Settings→General→Environment Variables 可下发到被托管 opencode 的环境（environment.mdx 明说这些变量随托管进程走）。→ **组合方案**：面板侧 `ssh -R 18080:127.0.0.1:PROXY_PORT` 把本地 HTTP 代理推给被控机，被控机给 opencode 配 `HTTPS_PROXY=http://127.0.0.1:18080`（opencode 原生尊重代理变量；零 openchamber 参与，纯 opencode + SSH 语义）。这条在 openchamber 连接模型里完全自洽：它只要求 SSH 可达 + 端口可转发，对被控机出网无假设（extra forward 类型 `remote`(-R) 在 `ssh-manager.mjs:1240-1241` 有一等支持，说明「控制端→被控端反向送端口」是产品内建动作）。

### 路径 3：Docker 镜像当被控端 —— **技术上可行，不推荐**

- 官方无预构建镜像，需 `docker build .`（Dockerfile 基于 oven/bun 1.4.2 + apt nodejs，**宿主只需 Docker**，glibc 无关——容器内 Debian）。
- 但容器内跑的是整个 openchamber（还要容器内装 opencode、挂 5 个卷、0.0.0.0 暴露强制密码）；且 openchamber server 在容器里拉起 opencode 后，**agent 的 LLM 出网仍从容器出**——air-gap 下还得给容器配代理。为了一个「被控端」引入 openchamber 全家 + 自维护镜像，复杂度不划算。EL7 内核 3.10 跑现代 Docker 亦有兼容风险（不展开，本项目另测）。

### 路径 4：纯 SSH 端口转发（零安装）—— **可行（air-gap 最优）**

- 被控机除 opencode 外**什么都不装**：`opencode serve --port 4096`（监听 127.0.0.1），面板宿主 `ssh -L 4096:127.0.0.1:4096 user@el7` 后 `OPENCODE_HOST=http://127.0.0.1:4096 OPENCODE_SKIP_START=true openchamber`。
- air-gap 补一条 `ssh -R` 反向代理 + 被控 opencode 的 `HTTPS_PROXY` 即闭环（见路径 2 论证）。openchamber 侧唯一要求：`OPENCODE_HOST` 必须带显式端口、无 path（docs environment.mdx；opencode-server.mdx）。connect-devices/Private Relay 配对流程在「被控机只有裸 opencode」时**不可用**——配对、token、relay 全是 openchamber server 的功能，没有 openchamber 实例就没有可配对的服务端（docs connect-devices.mdx 全文以「machine running OpenChamber」为主语）。

### 判定汇总表

| 路径 | EL7 可行 | air-gap(形态B) | 被控机要装什么 | 证据锚点 |
|---|---|---|---|---|
| managed 全装 | 否 | 否 | Node≥24.14 的 openchamber + 预装 opencode；下载在被控侧 | ssh-manager.mjs L1089-1196；packages/web/package.json engines |
| external 裸 opencode | **是** | **是（ssh -R 代理）** | 仅 opencode serve | docs opencode-server.mdx；outbound-proxy.js；lifecycle.js L778 |
| Docker | 是(仅 Docker) | 勉强（容器代理） | openchamber 全家容器（自构建） | Dockerfile；docker-compose.yml |
| 纯 SSH 转发 | **是** | **是（最优）** | 仅 opencode serve，零 openchamber | docs environment.mdx；REVERSE_PROXY.md 端点面 |

---

## D. 对 ocrc 的启示（基座替换判定）

1. **替换基座 = 引入一个功能更全但缝更闭的产品**。openchamber 的 API 面无契约承诺，第三方深定制只有两条正路：写它的 iframe 扩展（够不着 server 会话循环）或 fork（MIT 允许，但 6600 文件的 monorepo，跟进成本远高于 ocrc 现状）。
2. **ocrc 的卡片流契约（card/sdelta/seq/replayEnd）在 openchamber 里没有对应物**——它直接吃 opencode 2.x 的全局事件流，N 系列两层契约要重新映射，且失去对渲染管线的控制权。
3. **被控端故事互补**：openchamber 压根没有「轻量被控 agent」概念（remote = 桌面连另一台 openchamber）；ocrc 若做 EL7 被控端，反而可以用「opencode + ocrc 轻量 agent + SSH」覆盖 openchamber 的 managed 模式覆盖不了的场景（glibc 老、air-gap），这是差异化而非对齐点。
4. 可借鉴的具体机制：Loops 的 markdown 文件化定时任务（`.agents/loops/`）、goal 存 opencode session metadata 而非自有库、multirun 用 git refs 快照 lane、扩展 manifest 的能力审批模型、REVERSE_PROXY 级别的反代文档。

## 引用来源

- 仓库：https://github.com/openchamber/openchamber（以下 `repo:` = 该仓库 main 分支路径）
- 文档站各页 = repo: `packages/docs/content/docs/<name>.mdx`（本文引述原文均核对源文件）
- repo: `packages/electron/ssh-manager.mjs`（managed 安装/启动/转发，行号见文内）
- repo: `packages/web/package.json`（engines、依赖）、`package.json`（monorepo engines）
- repo: `packages/sdk/package.json`、`packages/sdk/src/index.ts`、`packages/sdk/src/host.ts`、repo: `docs/CUSTOM_THEMES.md`、repo: `docs/REVERSE_PROXY.md`
- repo: `scripts/install.sh`（MIN_NODE 24.14）、repo: `scripts/docker-entrypoint.sh`、repo: `Dockerfile`、repo: `docker-compose.yml`
- repo: `packages/web/server/lib/opencode/DOCUMENTATION.md`、`lifecycle.js`、`outbound-proxy.js`、`injected-env.js`
- repo: `packages/web/server/lib/session-goal/DOCUMENTATION.md`、`packages/ui/src/lib/multirun/DOCUMENTATION.md`、`fusion.ts`、`autoFusion.ts`
- repo: `packages/web/server/lib/quota/DOCUMENTATION.md`、`packages/web/server/lib/spaces/DOCUMENTATION.md`
- repo: `packages/vscode/src/DOCUMENTATION.md`、`packages/vscode/package.json`、`packages/extensions/registry.json`
- npm：https://registry.npmjs.org/@openchamber/web（dist-tags、版本数）
- GitHub Releases：https://github.com/openchamber/openchamber/releases/latest（资产清单）
- Workflows：repo: `.github/workflows/release.yml`（无镜像发布）、`.github/workflows/vscode-extension.yml`
