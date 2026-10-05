# Changelog

## 0.26.12 — ADOPT your own engine; the control-plane positioning lands (2026-10-06)

### feat(host): ADOPT an already-running opencode server (`OCRC_SERVER_URL`)
- **流式断开的真正根因**：用户自跑的 opencode（:4096）与 ocrc spawn 的引擎
  （:4097）**共享 session 存储（列表可见）但事件流隔离**——用户引擎里跑的
  会话在面板上永远静默，手动刷新只能靠 REST 拉历史。
- `OCRC_SERVER_URL=http://127.0.0.1:4096` → host 不 spawn，驾驶用户的引擎
  （事件 SSE / 会话 / 审批全指向它，Basic 凭证共用 config.env）。已部署生产
  实测：用户引擎的 streaming 事件恢复流入（TG 卡片与 WS 同步收到）。
- **PRODUCT.md 第零条**（定位落案）：ocrc = 以 opencode 为引擎的远程驾驶
  控制面；双拓扑（独立=第一公民 / 共生=轻量接入）= 同一功能矩阵；引擎关系
  二元性；**Windows 约束**（opencode desktop 版 → 壳走 adopt）；UI 原则
  「右栏显示能力 ≥ 中栏」+ E2E 门禁强制。

### feat(host): SSH remote 驱动补齐（功能矩阵对齐）
- remote:`<id>` 后端注册从插件入口**移植进 host**——第一拓扑此前只能配置
  远程主机却不能驾驶（面板在、引擎盲）。端口预留/Basic 凭证/降级语义与
  插件版一致。

### fix(web): token 回种死循环（流式/401 反复发作的第二根因）
- 长开 tab 的 URL 里挂着配对时代的 `#token=<旧>`：`captureToken` 每次 boot
  回种、401 处理器盲信 hash——撤销配对轮换后，旧凭证被反复复活。现在 hash
  仅在本地无 token 时采用；hash≠stored 时先向服务器验证再采信；WS 连续
  4 次升级失败自动探测并引导重新配对。

### feat(web): 对话中创建定时任务（ZCode 机制）+ 管理增强
- 注册 `schedule_create` / `schedule_list` agent 工具（ZCode 源码实证：
  创建的正解是模型调工具，不是 UI 按钮）——对话里说「每天 9 点做 X」即建。
- SchedulesPanel：每行 ▶ 立即运行（后端 `POST /api/schedules/:id/run`，
  暂停态拒绝）、空态引导文案。
- 右栏 homeId 正名：`config` 拆为 **定时任务** + **MCP** 两个 tab（含本地
  迁移）；auto 主题图标 = 半月+A（两处切换入口）。

### chore: E2E 发布门禁 + 运维脚本
- `scripts/release-smoke.mjs`（对生产跑真实断言：**发 prompt 断言流式
  到达**、WS live、右栏滚动、凭证间距、配对按钮）+ `scripts/pre-release.sh`
  （typecheck→全量测试→0/0→双 build→部署→smoke，全绿才允许打 tag）。
- `~/bin/restart-ocrc.sh`：幂等生产重启（杀净→等端口→起→等 web 200）。
- web：idle 自动展开右栏（60s 无输入；手动收起 10 分钟豁免）、tool 输出
  **MD 渲染切换**、凭证双框间距、构建版本悬停自查、SW 更新提示条。

## 0.26.11 — hotfixes: token rotate hardening, UI regression fixes, schedule tools (2026-10-05/06)
> 条目补记（发版时遗漏）。内容散于 0.26.10→0.26.12 之间的 main 提交：
> token 回种加固的第一版（mtime+size）、右栏 ZCode register 试验、homeId
> 正名、schedule 工具与 ⏰ 快速浮层、MD 切换、SW 更新提示、dependabot
> 实验合入（ACP SDK 1.6.1/zod4/diff9）。最终形态以 0.26.12 条目为准。

## 0.26.10 — proxy goes UI, repo diet (2026-10-05)

### feat(channels): Bot API 代理进面板
- 机器人管理面板的 Telegram 凭证区新增「Bot API 代理」输入框：与 token 同框
  保存（留空 = 不改），凭证来源行实时显示代理来源（面板凭证 / 环境变量 /
  直连）。生效优先级与 token 一致：**面板凭证 > TELEGRAM_PROXY >
  HTTPS_PROXY/https_proxy > 直连**，重启实例生效。
- 面板/插件两种形态同权：host 与 plugin 入口都从 channels.json 读取
  `credentials.proxy`。

### chore(repo): 结构瘦身
- 删除 pact 协议残留：`CLAUDE.md`（seat claude）、空壳 `.mcp.json`、仓库
  `opencode.json`（仅剩指向不存在二进制的 pact MCP——serve 每次启动的
  死配置噪音）。
- 7 份历史调研/审计报告归档至 `docs/research/`；6 个 ACP 探针/回滚脚本归档
  至 `scripts/spikes/`。正式文档（PRODUCT/ARCHITECTURE/OPS）与活跃脚本
  （spike-restart/v2-smoke/v2-restart）留在原位。

## 0.26.9 — every loose end closed: TG proxy egress, full i18n, zero warnings (2026-10-05)

### feat(telegram): proxy egress for blocked/corporate networks
- `TELEGRAM_PROXY`（回退 `HTTPS_PROXY`/`https_proxy`）→ undici ProxyAgent 挂进
  grammy baseFetchConfig：getMe/轮询/发消息全部走代理。api.telegram.org 不可达
  的受限网络从此是**配置问题**而不是等天气——config.env 写一行即通。
- 已知外部条件收口：此前「TG 真机 spike 等网络」由本项关闭。

### feat(i18n): Telegram 用户可见文案全量双语化
- 新增 103 个 key（en/zh 对齐，类型强制），接线 handlers/index/menus/
  main-keyboard 共 6 文件；发往用户的消息中文字面量归零（保留 2 处匹配
  锚点与注释）。主键盘「会话」按钮显示与路由共用同一 key，任意 locale
  不脱钩。

### fix(web): svelte-check 13 条 warning 清零
- a11y 三处按编译器豁免规则补语义（role="presentation" / listitem 包裹），
  死 CSS 8 处经全仓 grep 验证后删除，`tick` 改 `export const`——
  0 errors / **0 warnings**，140/140 web 测试过，视觉零变化。

### chore(deps): ACP SDK 1.6.1 + zod 4 + diff 9 合入；vitest 5 拒绝
- 全部经独立 worktree 实验裁决（typecheck + 594/594 + build）；
  vitest 5 因 mock 语义差异（1 测试需重写时序假设）+ 需手动补 vite peer，
  收益为零，拒绝并说明。dependabot 配置：去除上游残留 reviewer、
  minor/patch 分组降噪、覆盖 /web。

## 0.26.8 — exorcism: every bridge is gone (2026-10-05)

### removed(install): directory bridges, everywhere, permanently
- 「桥」时代终结：0.2x 的 install 曾把 `ocrc.js` 桥散布到各配置家
  （`~/.config/opencode/plugins/`、1.18 迁移目标的 `~/.opencode/plugin(s)/`）。
  实验与生产双重确认其加载时机**不可预测**：opencode 实例会在任意时刻加载
  桥，派生出幽灵 ocrc 实例（1 PRIMARY + 4 PASSIVE 同屏），与真正的 host 抢
  PRIMARY 锁与 web 端口——日志里成对的 starting、幽灵 primary.lock pid、
  EADDRINUSE 重试都源于此。
- **install** 不再写任何桥：只写 .env + npm 数组条目（1.18.x 唯一可靠路径，
  0.26.7 已修复其对象 default 导出），并顺手清理环境中的一切旧桥。
- **uninstall** 清理所有历史布局的桥 + npm 数组条目 + 遗留配置项。
- 本机环境已手工清空（三桥 + /tmp 实验残留全部移除），生产 host 独占
  web 4099，无第二实例。

### docs: README 桥的最终结论同步

## 0.26.7 — the npm-plugin path actually works on opencode 1.18.3x; pairing revoke; mode visibility (2026-10-05)

### fix(plugin): default export must be an object (this is the serve-mode unlock)
- 实验闭环（opencode 1.18.34 源码 + 真机）：V1 加载器（readV1Plugin, strict）
  要求 default export 为 `{server()}` **对象**；裸函数 default 报
  "Plugin export is not a function"。此前 npm 数组路径装包成功、加载必败。
  现为 `{ id, server, setup }`：V1 调 `.server(ctx, options)`、V2 读 `.setup`，
  桥文件本就优先 `.server`（1.17 兼容不受影响）。
- 端到端验证：1.18.34 + plugin 数组 → 插件加载、赢得 PRIMARY、双路径启动。
- 同轮实验确认：**目录扫描（`~/.config/opencode/plugins/` 等任何布局）在
  1.18.32/1.18.34 serve 下均不生效**——npm 数组是唯一插件路径（README/OPS
  已同步）；npm 插件由 opencode 在 serve 时自动安装（无需人工装包）。

### feat(pair): 撤销所有配对设备
- `POST /api/pair/reset`：轮换 web token（auth 中间件按 mtime 每请求感知，
  跨进程生效）+ 配对计数清零；旧设备下一次请求即 401 回到配对页。
- CLI：`ocrc pair --reset`；面板：机器人管理弹窗新增配对计数 + 两段确认
  撤销按钮（含「当前设备也会被登出」的诚实提示）。
- 设计边界：设备共享单一令牌是刻意的单用户信任模型——按设备撤销需要
  per-device 凭证体系，v1 不做。

### feat: 运行模式可见
- `/api/version` 增 `mode: plugin|host`（入口自报）；`ocrc status` 直接显示
  `ocrc x.y.z (plugin|host mode, <commit>)`；README 写明三种判断方法。

### fix(web): 频道卡片一致性
- 钉钉换官方品牌矢量（源转录的 Google 蓝修正为官方 #0089FF，替代 16px ico）；
  微信/飞书/钉钉三张卡的「待接入（配置面板已预埋）」文案统一。

### chore(deps): hono 4.13.12、@opencode-ai/plugin 1.18.34、dotenv 18（全部实验验证后合入，dependabot PR #6/#7/#8/#9/#10 已裁决关闭）

## 0.26.6 — Telegram blackhole resilience, install writes the npm plugin entry, README as an independent project (2026-10-05)

### fix(telegram): status() survives a failed bot init
- grammy 的 `botInfo` getter 在 `bot.init()` 未成功（api.telegram.org 不可达）
  时是**抛异常**而非返回 undefined：TG 被墙时 `telegramStatus` 回调把
  `/api/pair/onboarding`（配对二维码！）与 `GET /api/channels` 一起炸成 500。
  现在降级为 `connected:false`，面板与二维码永远可用。
- host 模式接线 `telegramStatus`（此前缺失，面板看不到 bot 在线状态）——
  与插件入口 parity。

### feat(install): npm plugin array entry (1.18.x verified)
- 1.18.x 实测：serve 模式下 `plugin` **npm 数组是唯一可靠的插件加载路径**，
  目录扫描（`~/.config/opencode/plugins/` 等）不可靠——桥单独存在时 serve
  不加载。`ocrc install` 现在把 `"@bd7pil/ocrc"` upsert 进 opencode 配置
  （纯 opencode.json 自动写入；jsonc 永不改写，打印精确的手工编辑行）。
- 目录桥保留（1.17 兼容），但 npm 数组才是受支持的安装路径。

### docs: README 重写 — 独立项目定位
- ocrc 不再以 fork 自居：双运行形态（plugin / host）对照表、npm 安装与
  升级路径、EL7 兼容基线（glibc 2.17 / OpenSSH 7.4）、企业代理远程、
  release 流（tag → CI OIDC publish）全部落在 README。上游来源移入
  Credits（NOTICE 法律声明不变）。

## Unreleased — PRODUCT constitution, rail v2, remote wizard + enterprise relay (2026-10-05)

### docs: 产品宪法 + 架构分层定稿
- **docs/PRODUCT.md（新）**：一句话定义（远程驾驶自己/管辖的 opencode，企业
  内网受控环境延伸）、四层归属判据（核心/壳/宿主/分发）、组件分发模型、
  壳技术倾向 Electron（opencode 2026-05 Tauri→Electron 迁移 + ZCode desktop
  双先例）、兼容基线（pin 1.18.x、EL7 下限）、明确不做清单。
- ARCHITECTURE.md 增分层原则 + 路线图（Windows 被控三处 POSIX 补丁范围、
  V2 独立立项、薄壳蓝图出处）。
- **pact 死配置移除**：AGENTS.md 的 pact 协议块与 .mcp.json 的 pactify 条目
  （工具从未存在于本机，上游遗留）；AGENTS.md 改为指向真实文档的导读。

### feat(web): 左栏 v2（ZCode WorkspaceSidebar register）
- 三桶模型：置顶 → 常规（项目/时间两种视图，persist）→ 归档区（平铺 +
  取消归档 + 20 条分页）；归档为 UI 语义（localStorage 集合，opencode v1
  无 archive API，不动服务端数据）。
- 项目视图按 workspace 分组：组头 **云朵（remote: backend）/ 文件夹（本地）**
  图标 + 主机名 + 会话数，可折叠（persist）。
- 顶部动作区（新建会话 + 搜索）+ 底部快捷区（定时任务 → 配置面板、远程主机
  → Remotes，带计数）+ 行内搜索（标题/项目/主机/短 id）。
- 纯函数抽到 nav/railModel.ts（8 测试）；stores/archive.ts 归档集合。

### feat(remote): 四步添加向导 + 企业中转
- RemotesPanel 内联表单 → **向导弹窗**（选择方式[SSH 可选，WSL/Docker 待接入]
  → 填写配置 → 连接中[实时日志控制台+阶段文案+失败重试] → 完成），≤820px 全屏。
- **企业代理**：remotes.json 增 per-remote httpProxy/httpsProxy/noProxy/caPath
  （0600；含凭据的 URL 面板脱敏）；`buildProxyExports` 注入远端 serve
  （大小写双份、NO_PROXY 强制含 127.0.0.1,localhost 防隧道劫持、CA 映射
  NODE_EXTRA_CA_CERTS）——ZCode「消毒+受控回注」的 ocrc 版。
- OPS.md 增企业内网场景章（A 代理注入 / B ProxyJump 零开发 / C 离线 scp 安装
  / provider `options.baseURL` 网关模式）。

### test
+14（railModel 8、proxy exports 5、redactProxyUrl 1）；后端 558 绿、web 140
绿、svelte-check 0 errors。

## source-review fixes, TG experience trio, remote config sync (2026-10-05)

A complete re-read of src/, tests/ and web/ (docs re-synced in the same pass,
see the docs/ commits) produced a debt list — then this series cleared it:

### fix(tg): the grinev experience trio
- **Signature dedup actually works now**: `deliveredSignature` returns the
  signature of what was REALLY delivered (`getTelegramRenderedPartSignature`);
  the old `fallbackText.slice(0,128)` never matched the streamer's rich
  signatures, so unchanged flushes re-edited every part.
- **Rich rendering on-line**: native parts go out via `sendRichMessage
  ({blocks})` — the ported render pipeline's output was computed and then
  thrown away at send time (plain `parse_mode: undefined` only). Native
  failure throws into the streamer's `plainOnly` degradation, which now
  genuinely engages. Finalize fallback delivers ALL parts (long finals no
  longer lose everything past the first chunk).
- **Live tool cards wired**: the orphaned `ToolCallStreamer` +
  `RunningToolTracker` render streaming-card tool blocks as one progressively
  edited message with elapsed-time ticks; `standard` granularity hides it.
- Hygiene: dead throttle-reset branch removed; duplicate `/workspaces`
  `/projects` registration dropped; permission-flow/question-flow copy moved
  into i18n (`question.flow.*` / `permission.flow.*` keys added to en+zh —
  the i18n module is wired for the first time); confirmed-dead orphans
  deleted (markdown-to-telegram-v2, question-manager, rename-manager,
  external-input/abort-suppression, finalize-assistant-response).

### fix(web)
- `+layout.svelte` stacked one `ocrc:resubscribe` window listener per
  navigation — registered once in onMount now, removed on destroy.
- `ansi.ts`: 38;5;n maps through the xterm 256-color palette; 48;2/48;5 emit
  background-color (both were swallowed before).
- Dead `stores/activeSession.ts` removed; `#token` fragment semantics
  cross-referenced (boot keeps it for iOS PWAs, auth failure strips it —
  complementary by design, now documented as such).
- svelte-check: all 7 pre-existing errors fixed (Inspector side-chat typing,
  visual-audit.mjs strictness) — 0 errors.
- stability-14.12 `expect(true)` placeholder replaced by a pointer to the
  real index-gating coverage.

### feat(remote): sync-config — bring the opencode environment along
- `RemoteHostManager.syncConfig(id)`: tar the local `~/.config/opencode`
  whitelist (`opencode.json` incl. its mcp section, `AGENTS.md`, `CLAUDE.md`,
  `command/`, `agent/`, `skill/` — never `plugin/`) and apply it on the
  remote in one ssh round-trip; collisions back up to `*.ocrc-bak`
  (ZCode's no-silent-overwrite semantics). Design + ZCode mechanism
  comparison: docs/remote-provisioning-design.md.
- `POST /api/remotes/:id/sync-config` + RemotesPanel「同步配置」button.

### test
- 34 new tests: streaming-render (5), tool-stream-bridge (5), scheduler (5),
  channels (4), previously-uncovered web routes (8), v2-backend (5),
  control-plane (3), config-sync helpers + remotes routes (4+).
- Backend 544 green; web 132 green; svelte-check 0 errors.

### Still open (recorded deliberately)
- The i18n dictionary (~620 keys) is wired only for the two flows; the rest
  of the TG surface (handlers/menus/renderer) still has hardcoded copy.
- cli/host.ts + cli/install.ts remain untested (interactive entry points).

## v0.26.0 — v0.26.5 — 2026-10-04

Headline: **SSH remote hosts** — drive opencode on other machines from the
same panel (deploy-on-connect adapted from ZCode, system ssh only):

- `~/.ocrc/remotes.json` store (0600, secrets generated per host, redacted in
  API responses); state machine unknown→detecting→provisioning→launching→
  online (+needs-auth/error/offline/disabled).
- Provision = official installer pinned to the LOCAL opencode version; no-
  internet fallback scp's the local binary. Never a musl/compat build.
- One ssh process does tunnel + remote serve — ssh death kills everything it
  started; respawn 2s→60s backoff with fresh detect each cycle.
- Per-remote `/global/event` SSE into the same dispatchEvent — remote turns
  mirror exactly like local ones; `sync-auth` copies auth.json (0600).
- Remote backends derate honestly: no liveMirror/tuiSelect/local-git.
- Web: /api/remotes CRUD + inspect/provision/sync-auth; RemotesPanel.
- Patch train: EL7 OpenSSH 7.4 compat (no accept-new), port-detect without
  `ss` on non-interactive PATH, SDK fetch wrapper → explicit Request →
  client-level headers (the custom-fetch Authorization header was silently
  dropped inside opencode's embedded runtime).

## v0.25.0 — v0.25.2 — 2026-10-03

Headline: **sdelta incremental streaming** — WS bytes off the O(n²) path:

- `sdelta` frames carry raw text increments to the WS hub (bypassing CardBus);
  snapshots become sparse checkpoints: 1s floor, 2s past 50k chars, 3s past
  150k (relay streamGap).
- 0.25.1: deltas coalesce per part on a 250ms timer; 0.25.2: flush only where
  a snapshot actually publishes. Wire order "deltas, then the snapshot
  containing them" keeps client replace append-safe.

## v0.22.0 — v0.24.4 — 2026-10-03

- **Session revert/unrevert** (POST /session/:id/revert with {messageID});
  history cards carry the opencode message id; post-cutoff cards hidden.
- Web: side chat pane (SelectionSideChatPane), ZCode pane summon, busy = any
  live thinking/streaming card, right pane as a separated surface, perf audit
  (hot-read caches, single WS serialization, hidden-tab gating), mobile
  popover/textarea fixes, context ring semantics + wheel fix.

## v0.18.0 — v0.21.0 — 2026-10-01/02

- Web: right pane becomes a dynamic tab system (workspaceSidePane register);
  zero pinned tabs; ZCode three-pane register with multi-subscribe WS (live
  subagent tabs); bottom-left identity rail + context category breakdown;
  composer send⇄STOP; mobile ⋯ menus; theme auto tier.
- VCS: the server's /vcs is unusable on big worktrees (279s) — spawn
  read-only git locally instead (16ms), 120s server-side cache, per-file lazy
  patches with a 400k cap (whole-tree diff hit 47MB here).

## v0.16.0 — v0.16.3 — 2026-09-30

Tabbed inspector (opencode-web pattern); plan HUD recoverable dismiss + ghost
chip + storage-key resets; tool-arg summarizer hardening (never String()
inputs — edit batches render as 'N edits').

## v0.15.0 — v0.15.2 — 2026-09-30

Desktop pass: two-tone canvas, ZCode plan window, resizable panes, foldable
inspector; surface unification; visual repair after the two-tone pass.

## v0.14.0 — v0.14.3 — 2026-09-29/30

Headline: **octg-simple lifecycle** — supervision always on (adopt-or-spawn,
crash auto-restart incl. SIGKILL/OOM, stop-file graceful stop, `ocrc restore`
for @reboot); `--watch` accepted and ignored. Streaming stops echoing user
messages; plan HUD overlap + tool-arg fixes; mobile/desktop overflow; desktop
goes neutral (ZCode register), orange stays accent-only.

## v0.13.0 — v0.13.6 — 2026-09-29

First-run onboarding landing (unauthenticated, ZCode-style; pending QR +
channel status only); real channel logos + ink-ring mark; supervisor/
restore/restart argv fixes; SIGKILL/SIGSEGV treated as crashes (OOM heals);
paired-state transition; onboarding lock hints.

## v0.12.0 — v0.12.4 — 2026-09-29

`ocrc start --watch` supervisor + `restore` (run-N.sh semantics); service
argv contract fix; README rewrite.

## v0.11.0 — 2026-09-29

HTTP Basic support for password-protected opencode servers
(`OPENCODE_SERVER_PASSWORD`) — octg cutover prerequisite.

## v0.10.0 — 2026-09-29

**Pending-token pairing (M11)**: /pair surfaces issue 1-minute single-use
tokens (`#pair=`); devices exchange at POST /api/pair/exchange; the permanent
token never travels in a URL again. ZCode-style QR block.

## v0.9.0 — v0.9.1 — 2026-09-28

Headline: parity + surfaces batch over the grinev UX port (P2b/P2c):

- **M8**: skills/files/worktree surfaces (backend + web panels + TG /skills
  /ls /open /worktree). **M9**: bot-channels management (channels store, web
  机器人 panel, TG consumption). **M10**: interactive question tool on
  Telegram + web — incl. the discovery that `question.*` never rides the V1
  event hook (dedicated SSE filter).
- Parity batch: TG subs/mode/cleanup/regenerate/suggestion chips, background
  notify, web zh UI, motion layer (seven-rule spec), plan orb (enso mark) +
  subagent jumps, windowed long-session rendering + offset pagination,
  replay completeness flag + REST resync (heals torn feeds).
- npm/GitHub publish (CI Trusted Publisher), grammY migration leftovers
  removed, photo intake + prompt-queue ack, reply keyboard 2x2.

## ocrc fork — 0.8.1-ocrc.1 (2026-09-25)

Forked from agentjoey/opencode-remote-control at `9b89b79` (v0.8.1).
Fork identity: `@bd7pil/ocrc`, config home `~/.ocrc/`, CLI `ocrc`.
See docs/development-plan.md for the full fork plan. Deltas so far:

- **Naming**: config home `~/.ocrc/` (token `token`, lock `primary.lock`,
  state `state.json`, log `ocrc.log`, env file `config.env`); CLI/bin `ocrc`;
  npm scope `@bd7pil/ocrc`; bridge file `~/.config/opencode/plugins/ocrc.js`.
- **Web network defaults** (LAN-first decision, token gate unchanged):
  `OCRC_WEB_HOST` default `0.0.0.0` (upstream 127.0.0.1), `OCRC_WEB_PORT`
  default `4099` (upstream 17081). Legacy upstream variable names still work.
- **web: bind errors surfaced** — listen errors (EADDRINUSE/EACCES) are now
  re-thrown asynchronously so the transport retry loop sees them, instead of
  being absorbed as unhandledRejections leaving the server silently unbound.
- **web: first-visit pairing token race fixed** — fragment token captured at
  module init (before any component mounts) and the fragment is stripped when
  a rejected token is cleared; kills the flashing reload loop seen on phones.
- **branding**: pactify linx → ocrc (PairGate, Titlebar, manifest, PWA title).

## v0.8.1 — 2026-07-24


Headline: **big review pass — core correctness, transport hardening, and
frontend accessibility / motion hygiene.**

### Core & transport fixes
- **Session routing hardening**
  - `SessionState.normalizeSessionId()` now guards `undefined`/`""` input,
    requires a `>=6` char suffix, and refuses ambiguous suffix matches so a
    short display id can no longer silently resolve to the wrong session.
  - All ingress points now normalize short ids: relay fallbacks, Telegram
    approval/pin, web routes (`/session`, `/abort`, `/diff`, `/todo`, `/context`,
    `/controls`, `/files`, `/rename`, `/commands`, `/approval`), and WebSocket
    subscribe.
- **Relay correctness**
  - Fixed an `AbortController` leak that kept `hasActiveGeneration()` stuck
    `true` forever, blocking Telegram input.
  - Per-session serialization so two messages targeting the same session can't
    clobber each other's timers, abort registration, or stream accumulator.
  - External/TUI-adopted turns now get a real timeout and register in the abort
    map.
  - `hasSession()` no longer swallows network errors; transient backend failures
    surface an error card instead of rerouting the prompt to a different session.
- **ACP lifecycle**
  - Canceled/rejected ACP connection promises are cleared so the backend can
    reconnect.
  - Spawned ACP children are killed on initialize failure and on host shutdown.
- **Telegram hardening**
  - HTML output is escaped everywhere (approval titles, `/sessions`, `/rename`,
    `/todo`, error replies) so `<`/`&` no longer 400 the reply.
  - 429 `retry_after` is honored with backoff; multi-chunk sends are paced.
  - `callback_data` ids that exceed Telegram's 64-byte limit are mapped to
    sha1 tokens.
  - Local and remote `/abort` now target the same resolved session.
  - Persistent 409 (another bot) / 401 (bad token) are logged as FATAL instead
    of silently dying.
- **Web transport**
  - WebSocket clients register synchronously on attach so early subscribes are
    not dropped and dead sockets can't leak.
  - `maxPayload` capped at 64KB; unexpected `verifyUpgrade` errors destroy the
    socket cleanly.
  - Query-param credentials (`?token=`, `?cf_access_jwt=`) are now only accepted
    on the `/ws` upgrade path, never on plain HTTP.
  - `/api/abort` and `/api/approval` validate their bodies and return 400 for
    malformed input instead of 500.
- **Plugin / host**
  - `.env` precedence reversed: the plugin's own `.env` is authoritative; the
    cwd `.env` can only supplement, not hijack token/allowlist.
  - `.env` written by the installer is created with `0600` permissions.
  - Transport start failures retry with exponential backoff instead of giving up
    on a transient boot error.
  - State and ACP store are flushed on SIGINT/SIGTERM so debounced writes aren't
    lost.
  - Log file rotates at 10MB.

### Web UI — terminal output & design audit
- **Terminal-style tool output** ships as production: multi-line or long tool
  args render in `TerminalBlock`, ANSI SGR colors convert to spans, and output
  over 20 lines collapses behind a show-more toggle.
- **Accessibility & motion**
  - Global `prefers-reduced-motion` fallback.
  - Session-row action buttons are visible on `:focus-within`, not just hover.
  - Focus trap + focus restore for NewSessionModal and CommandPalette.
  - Chip dropdowns (`AgentModelChip`, `SessionControls`) get
    `aria-haspopup`/`aria-expanded`, Escape, and click-outside dismissal.
  - Status dots carry accessible text; busy vs idle are distinguished by color
    (`--ok` vs `--accent`) as well as pulse.
  - Placeholder-only inputs receive `aria-label`s.
- **Theming / anti-patterns**
  - Banned 2px side-stripes removed from error and think-stream cards.
  - Added `--scrim`, `--bg-code`, and a semantic `--z-*` scale; swept ~15
    hard-coded colors and duplicated scrims onto tokens.
  - Layout-property animations (rail width, progress-bar width, modal padding)
    moved to transform-based animations.

### Also
- `TerminalBlock` ANSI parsing fixed for combined reset+color sequences
  (`\x1b[0;31m`) and 256/truecolor parameter groups.
- Web `feeds` store prunes inactive sessions to bound memory.
- Inspector panels discard stale async results when the user switches sessions.

## v0.8.0 — 2026-06-22

Headline: **OCRC becomes Pactify Linx** — a full console redesign around an
**agent-as-top-axis** information architecture, plus the Pactify brand (cool-slate
palette, chain-link mark). Built multi-agent: backend/contract by the orchestrator,
the UI by real **kimi-code** sessions driven headlessly.

### Rebrand — Pactify Linx
- Cool-slate theme (`#0a0e14` base) replacing warm charcoal; chain-link brand mark
  (role-colored arcs + silver "pact" square) and a `pactify linx` wordmark; refined
  per-agent accent themes, a fixed conversation palette (`--cv`), brand role colors,
  and regenerated app icons. App/manifest renamed to Pactify Linx.

### Console redesign (desktop + mobile)
- **Agent axis** — agents (backends) are the top-level axis: a left-panel agent
  dropdown + picker, sessions scoped to the active agent, and a per-agent chrome theme
  (the conversation stays emerald). `/api/backends` now reports name/host/status.
- **Chat** — session switcher in the sub-header; signature **EXECUTION** panel; reasoning
  toggle; code/list blocks; meta + copy/retry; in-place approval flow.
- **Inspector** — Tasks (scrolling middle) + pinned Working dir / **Usage** (tokens-first)
  / Context.
- **New session** modal (agent + working dir + recents + branch) and a `+ New` menu.
- **Command palette** — Agents (switch) + sessions across all agents + commands.
- **Mobile** — dual-screen Sessions↔Chat flow, bottom-sheet inspector, horizontal agent
  switcher row, and a FAB speed-dial.

### Also
- Telegram command-menu self-heal now confirmed active in the plugin hub.

## v0.7.3 — 2026-06-21

Headline: **the full ACP enhancement backlog (#1–9) ships** — kimi sessions reach
near-parity with opencode across diffs, history, images, @-mentions, mode/model
switching, MCP, the command palette, and terminal-style output. Built multi-agent via
Pactify orchestration (backend by the orchestrator, frontend by the kimi seat).

### Inspector & transcript
- **Red/green diff viewer** — the working-dir panel expands each changed file to a
  normalized, render-ready inline diff (`DiffEntry`: add/del/ctx lines) across all backends.
- **tier-2 history replay** — opening a native/TUI kimi session (no OCRC-recorded cards)
  now replays its history via `session/load` and rebuilds the conversation — fixes the
  "no message" blank on agent-native sessions.
- **terminal-style tool output** — tool-call output renders as a monospace terminal block
  (ANSI-aware, collapsible) instead of plain text.

### Composer & input
- **Image input** — attach or paste images; sent as ACP image content blocks to backends
  that advertise `promptCapabilities.image` (kimi). Gated by the `imageInput` capability.
- **@-mention file picker** — typing `@` lists the session's workspace files
  (`GET /api/session/:id/files`); selecting inserts an `@path` reference.
- **Mode + model switching** — kimi sessions expose their mode (plan/acceptEdits/…) and
  model via pickers (ACP `session/set_mode` + `set_config_option`); `sessionControls` cap.

### Backend surfacing
- **MCP** — the inspector MCP panel now shows an ACP agent's OWN configured servers
  (e.g. kimi's `~/.kimi-code/mcp.json`); `mcp` capability flips on for ACP.
- **Command palette** — lists the *viewed* session's backend commands with the right label
  (no more hardcoded "opencode commands").

### Telegram
- **Command-menu self-heal** — bot init now clears stale narrower command scopes
  (`all_private_chats`/`all_group_chats`) so the default 18-command menu can't be shadowed.

## v0.7.2 — 2026-06-20

Headline: **ACP backends surface working-dir diffs and TODO lists** — kimi (and
any ACP agent) now lights up the inspector's Task panel and changed-files list,
matching opencode. Plus adaptation to the kimi-cli → kimi-code-cli 0.18 rewrite.

### ACP capabilities (kimi + any future ACP agent, e.g. Claude Code)
- **TODO / plan list** — the inspector Task panel now populates for ACP agents.
  Reads both the ACP `plan` update (older kimi-cli / Gemini) and kimi-code 0.18's
  todo tool call (`rawInput.todos`), so it works across agent versions.
- **Working-dir diff** — files an ACP agent edits (captured from `tool_call`
  `diff` content, deduped by path) now show in the inspector's working-dir panel.
- The `diff`/`todos` capability flags flip to true for ACP backends — entirely
  backend-side, no frontend change.

### kimi-code-cli 0.18
- kimi-cli (Python, `KimiCLI/1.47.0`) → kimi-code-cli (Node/TS, `0.18.0`). The
  `kimi acp` ACP entrypoint is unchanged (no wire changes); the TODO list moved
  from the ACP `plan` update to a tool call carrying `rawInput.todos` — handled
  above.
- Ops: data dir `~/.kimi` → `~/.kimi-code`, OAuth not migrated (re-run `/login`);
  the launchd host template gains `KIMI_CODE_HOME` + a headless-auth note. See
  docs/OPS.md → 升级 kimi → kimi-code 0.18.
- `scripts/acp-field-probe.mjs` — a diagnostic that dumps live ACP `session/update`
  payloads, for re-confirming field shapes when an agent's CLI changes.

## v0.7.1 — 2026-06-19

Headline: **ACP sessions are now first-class** — kimi (and any ACP agent) gets
persistent sessions with history, per-session working directories, and a session
list scoped to the selected agent. The standalone multi-backend host now serves
the production domain (`ocrc.agentjoey.ai`).

### ACP sessions
- **Persistent sessions + history** — ACP agents resume across connections but
  don't list sessions or replay history, so they used to vanish on host restart.
  OCRC now persists the session list (id/title/dir) and finalized conversation
  cards itself (`acp-sessions.json`), and `resumeSession`s a session before
  prompting it. kimi sessions survive restarts and reopen with their history,
  like opencode.
- **Per-session working directory** — new ACP sessions take a user-entered
  directory (opencode-style workspace UX, applied to all ACP agents). The web
  shows a free-form directory input with a datalist of known dirs; the agent runs
  in that directory and the inspector shows it. New capability flags
  `workspaces`/`freeformWorkspace` drive picker-vs-input.
- **Slash-commands** — `listCommands` is populated from ACP
  `available_commands_update` (kimi exposes `/init`, `/compact`, …).

### Multi-backend UX
- **Backend switcher moves you to that agent** — selecting a backend opens its
  most-recent session (or the empty state to start one) instead of leaving you on
  the previous session.
- **Session list scoped to the selected backend** — pick acp:kimi and the sidebar
  shows only kimi sessions (active only when >1 backend is served).
- **Working dir shows for ACP** — the inspector's working-dir was wrongly gated on
  the `diff` capability; now the directory always shows, only the diff file list
  is gated.

### Deployment
- The standalone multi-backend host (`opencode + kimi`) now serves the production
  domain; the cloudflared `ocrc` ingress points at the host's web port. Uses the
  persisted web token, so paired devices need no re-pairing.

## v0.7.0 — 2026-06-18

Headline: **multi-agent** — OCRC can now drive non-opencode agents over ACP
(validated live with Kimi), and one standalone instance can serve **opencode + an
ACP agent at once** with an in-UI backend switcher. Plus the earlier mobile/PWA
polish.

### Multi-agent (ACP + multi-backend)
- **ACP backend** — a second `AgentBackend` (`AcpBackend`) drives any Agent Client
  Protocol agent over stdio (`@agentclientprotocol/sdk`); validated end-to-end
  against `kimi acp` (streaming text + reasoning, tool calls, permission approval).
  Normalizes ACP `session/update` → the relay's `AgentEvent` (Phase 2 event seam).
- **Standalone host** (`oprc host`) — run OCRC against spawned agents with **no
  opencode**, web-only or with Telegram. `scripts/run-acp-host.sh` + `.env.acp`
  make it turnkey; `OCRC_ACP_AUTO_APPROVE` gates tool approval.
- **In-UI backend switching** — set `OCRC_BACKENDS="opencode, kimi=kimi acp"` and
  one host serves both: the host spawns its own opencode server, the web titlebar
  shows a backend switcher (sets where new sessions go), `/api/sessions`
  aggregates across backends, and each session routes to its owning agent.
- **Per-backend capability gating** — the UI hides affordances a backend can't
  serve (workspaces/diff/todos/agent-model/MCP/commands), keyed off the *viewed*
  session's backend. ACP slash-commands are surfaced from `available_commands_update`.

### Mobile web / PWA
Headline: the input now follows the iOS keyboard smoothly, safe areas are correct,
and a stale token self-heals.
smoothly, safe areas are correct, and a stale token self-heals.

### Mobile web / PWA
- **Composer follows the keyboard** — on phones (≤820px) the input floats over the
  chat and tracks the keyboard/bottom-toolbar by translating a published `--kb`
  inset on the GPU, so it glides rather than resizing the app each frame. The
  home-indicator padding telescopes away once the box lifts, so there's no dead
  gap above the keyboard.
- **iOS safe areas fixed** — the app uses `height:100vh` (not `100dvh`/`100%`); on
  standalone PWAs those mis-size on cold start and break `viewport-fit=cover`, so
  `env(safe-area-inset-*)` resolved to 0 and a dark strip showed below the input.
  Now the app fills to the physical screen bottom with real insets.
- **Dim-under-input** — chat content fades to low brightness as it scrolls beneath
  the floating input (a CSS fade mask, not a frosted panel).
- **Latest message stays reachable** — the chat reserves the composer height (plus
  the keyboard inset) and re-pins to the bottom, fixing the "can't scroll to the
  newest message after switching sessions" bug.
- Browser tabs and installed PWAs share the same `--kb` math; Safari's bottom
  toolbar no longer hides the input at rest.

### Fixed
- **Stale web token self-heals** — a 401 while a token is stored now clears the
  token and drops to the in-app PairGate to re-pair, instead of looping forever on
  "reconnecting". The Cloudflare Access reload path is unchanged for that mode.

### Internal / foundation
- **Pluggable agent backend (Phase 1)** — the relay, every web route, the Telegram
  handlers, push, and history now run behind an `AgentBackend` interface; opencode
  implements it (zero behavior change). Adds `GET /api/capabilities` and a
  backend-id chip in the web titlebar. This is the groundwork for driving
  non-opencode agents over ACP (Kimi/Gemini/Cursor/Codex/Claude) without touching
  the card model or transports — see `docs/ACP_BACKEND_DESIGN.md`. Read-path
  verified against a live opencode hub. Only the event stream stays
  opencode-specific (Phase 2).

## v0.6.1 — 2026-06-12

Headline: **token auth works end-to-end** — pair a device and run the web PWA
without Cloudflare Access. Plus real app icons and PWA cache fixes.

### Added
- **Token auth, end-to-end** — the web app captures a pairing token (`#token=…`)
  on load, persists it to localStorage, strips it from the address bar, and
  attaches it to every API request (`Authorization: Bearer`) and WebSocket
  connect (`?token=`). Pairing now works **without Cloudflare Access**,
  completing the P2 goal of decoupling auth from CF Access.
- **Auto-detect the Cloudflare Tunnel hostname for `/pair`** — when
  `WEB_PUBLIC_URL` is unset, scan `~/.cloudflared/*.{yml,yaml}` for an ingress
  hostname mapped to the web port and emit that HTTPS URL instead of an
  unreachable LAN IP. Resolution order: `WEB_PUBLIC_URL` > cloudflared hostname >
  LAN IP > loopback.
- **Real PWA app icons** — replace the 1×1 placeholder icons with a rendered
  brand mark (rounded `any` + full-bleed `maskable` 512, apple-touch 180,
  favicon 48); add the missing favicon and an `apple-touch-icon` link. PWA
  `name`/`short_name` → `OCRC`.

### Fixed
- **Service worker precache no longer captures stale assets** — `addAll` honored
  the browser HTTP cache, so a precache could pin an asset still under a CDN
  `max-age` (icons showed mixed old/new generations). Each entry is now fetched
  with `cache: 'reload'`, straight from the network.

### Docs
- README / OPS: token-default auth, device pairing, and **remote access without
  a domain** (Tailscale, cloudflared quick tunnel, or SSH port-forward).

### Ops
- When fronting the PWA with a CDN (e.g. Cloudflare), add a **cache-bypass rule**
  for `/service-worker.js`, `/manifest.webmanifest`, `/icon-*`,
  `/apple-touch-icon.png`, `/favicon.png` so PWA updates propagate on `build` +
  restart without a manual purge. (Hashed `_app/*` assets keep long caching.)

## v0.6.0 — 2026-06-12

Headline: **multi-instance ready**. A single-machine fleet of opencode instances
now elects one PRIMARY to own the global web/Telegram singletons; the web/bot can
switch between workspaces; auth and public exposure are pluggable (no longer
Cloudflare-Access-only); and the web chat got a substantial UX pass.

### Added — Multi-instance foundation (P1)
- **PRIMARY election** (`src/core/primary-election.ts`) — atomic lock file
  (`~/.opencode/oprc-primary.lock`, `openSync(path,'wx')`) elects one instance to
  own the global web/Telegram singletons; others stand down PASSIVE. Stale-PID
  reclaim; lock released on construction failure or shutdown.
- **Cross-workspace global event stream** (`src/opencode/global-events.ts`) —
  `startGlobalEvents()` subscribes `client.global.event()` with reconnect, so the
  PRIMARY observes events from sibling workspaces over HTTP.
- Plugin entry gates web/bot on election; the per-instance `event` hook remains
  the in-worker dispatch source (the global stream does not deliver inside the
  plugin worker — see `docs/decisions/2026-06-12-cross-workspace-streaming.md`).

### Added — Pluggable connectivity & auth (P2)
- **Auth strategies** (`src/connectivity/auth/`) — `WEB_AUTH=token` (default) or
  `cf-access`. `TokenAuth` generates/persists an app token (0600 at
  `~/.opencode/oprc-token`), verifies HTTP + WS with `timingSafeEqual`. CF Access
  is now optional, decoupled from transport.
- **Exposure provider** (`src/connectivity/exposure/`) — `resolvePublicUrl()`
  prefers `WEB_PUBLIC_URL` > physical LAN > loopback.
- **Device pairing** (`src/connectivity/pairing.ts`) — `oprc pair` / `/pair`
  emit a QR + URL (token in the URL fragment) to onboard a device.

### Added — Workspace UX (P3)
- **Workspace switcher** — `GET /api/workspaces`, sidebar switcher; sessions
  filter to the active workspace.
- **Create session in a workspace** — `POST /api/session`; Telegram `/new`.
- **`/workspaces`** Telegram command lists known workspaces.
- **Custom commands in the web command palette** — `GET/POST /api/commands`
  run opencode custom commands against the active session (⌘K).
- **Session rename** — inline rename in the web sidebar +
  `POST /api/sessions/:id/rename` + Telegram `/rename`.

### Added — Web chat UX
- **Syntax highlighting** — highlight.js + marked-highlight; inline `` `code` ``
  renders green (file/command/path), fenced code blocks get full multi-color
  highlighting (keywords purple, functions yellow, classes cyan, numbers orange,
  comments gray, strings green).
- **GFM table rendering** — markdown tables now styled (borders, header band,
  zebra rows, horizontal scroll).
- **Top search box** — replaces the top-bar session ID; opens the command
  palette (sessions + commands), matching ⌘K.
- **Session status dots** — solid green = connected + recently active, blinking
  green = a turn is streaming, hollow gray = disconnected/inactive.
- **De-emphasized in-progress streaming** — thinking/streaming text renders
  smaller and gray; the finalized answer stays full-size.
- **Redesigned system cards** — compact status/approval/abort/info cards;
  approval buttons are filled (Allow / Always / Reject).
- **Enter-to-send** — Enter sends, Shift+Enter newlines (IME-safe).

### Fixed
- Restore the per-instance event hook as the in-worker dispatch source after P1
  routed dispatch through the global stream (which delivers zero events inside
  the worker) — this had broken web/Telegram message receipt and streaming.
- Adopt externally-initiated turns in the relay so TUI- and command-initiated
  turns stream to the web (previously dropped for lack of a session ctx).
- `theme.css` syntax colors were dropped because `:global()` is Svelte-only and
  invalid in plain CSS — rewrote the 25 hljs rules without it.
- Default `WEB_PORT` to `17081` (was `7081`, opencode 1.17's own server port).
- Telegram `ws:set` callback exceeded the 64-byte limit (short-token map);
  `notify` tool uses the tool context's `sessionID`.

### Docs
- `docs/decisions/2026-06-12-cross-workspace-streaming.md` — records that
  cross-workspace *streaming* is not supported with current opencode (worker SSE
  doesn't deliver; sessions are directory-bound). Accepted as a known limit.

---

## v0.6.0-rc.1 — 2026-05-31

### Added
- **Plugin Registry mode** — `npx opencode-remote-control install` deploys as
  opencode plugin; Telegram bot + Web PWA auto-start with `opencode`
- `src/plugin/entry.ts` — Plugin entry exporting `remoteControlPlugin: Plugin`
- `src/plugin/config.ts` — Plugin-mode config loader (openCode env + process.env)
- `src/cli/install.ts` — interactive/CI-friendly plugin installer (`--yes`, `--local`)
- `src/cli/uninstall.ts` — remove plugin from opencode config
- `rc-status` tool — status command visible in opencode TUI
- `relay.handleEvent()` — event-hook compatible event dispatch for Plugin mode
- `@opencode-ai/plugin` dependency
- `package.json` exports `./plugin`, `./install`, `./uninstall`

### Changed
- Relay deps: `eventStream` and `baseUrl` are now optional (Plugin mode compatible)
- Transport constructors: `baseUrl` and `eventStream` are now optional
- `ARCHITECTURE.md` — Plugin mode as primary deployment, sidecar as legacy
- `package.json` — removed `engines.node` restriction (Bun compatibility)

### Deprecated
- launchd deployment — replaced by Plugin auto-start
- `src/launcher/` — opencode itself is the launcher in Plugin mode
- `src/index.ts` legacy path — use `RC_MODE=legacy` to opt back in

## v0.5.7 — 2026-05-21

### Removed
- **Telegram streaming** — `renderStreaming()`, `renderThinking()`, `retryEdit()`,
  all throttling/chunking logic deleted. Telegram now delivers final result only
  via `sendMessage()`. Web transport keeps streaming unchanged.

### Fixed
- **SessionId mismatch with thinking card** — thinking card now published after
  `sessionId = resolvedId`, ensuring the sessionId in the card is always the
  correct resolved one. Early `setActiveAbort` restored for pre-submit abort.
- **Delta accumulation** — `message.part.delta` sends incremental text (not full).
  Relay now tracks `partTextAcc` Map per partId, appends deltas, and passes the
  full accumulated text to the accumulator. Root cause of truncated responses.
- **Empty text overwrite** — accumulator skips `text=""` updates when block
  already has non-empty text (SDK sends empty on some `part.updated` events).
- **TCP hang** — all sendMessage calls now have 10s timeout via `withTimeout()`/
  `sendTimed()`. Previously stuck connections hung forever.
- **429 retry_after cap** — capped at 5s; longer cooldowns force immediate
  fallback to sendMessage instead of prolonged retries.
- **push.ts fetchSummary race** — retries after 3s if first attempt returns empty
  (opencode persistence race on session idle).

### Changed
- **finalize() error handling** — catches all errors, logs them, and attempts a
  last-resort sendMessage with truncated text (3800 chars). Previously fatal
  errors silently dropped responses.
- **Thinking card** — no more `showStop` functionality (Stop button removed).
- **UI cleanup** — Stop button removed from thinking/streaming cards; Part N
  headers („·done“/„·streaming…“) removed; continuation shows just „⏳“.
- **sendInfo retries** — 3 attempts with 2s delay for ECONNRESET/ETIMEDOUT.

## v0.5.6 — 2026-05-20

### Fixed
- **Delta accumulation** — `message.part.delta` sends incremental text, not full text.
  Relay now tracks `partTextAcc` per partId, appends deltas to baseline, and passes
  the full accumulated text to the accumulator. This was the root cause of truncated/
  partial assistant responses in Telegram.
- **finalize() robust fallback**: `retryEdit()` now returns boolean. If Telegram
  edit fails, `finalize()` falls back to `sendMessage()` instead of silently
  dropping the response.
- **TCP hang protection**: all `sendMessage` and `editMessageText` calls now have
  10s timeouts via `withTimeout()` helper and `sendTimed()` wrapper method.
  Previously stuck TCP connections caused `retryEdit` and fallback `sendMessage`
  to hang forever.
- **push.ts timing race**: `fetchSummary()` retries after 3s if the first
  attempt finds no assistant message (opencode server may not have persisted it
  yet).

### Changed
- **Remove Stop button** — streaming/thinking messages no longer include ⏹ Stop
  inline keyboard.
- **Remove Part N headers** — pagination chunks no longer show `Part N · done` or
  `Part N · streaming…` prefixes. New continuation chunk shows just `⏳`.

## v0.4.0-rc.1 — 2026-05-16

### Added
- **Single-command launcher** — `oprc` (or `opencode-remote-control`) spawns
  opencode if needed, waits for health, then starts the bot. Handles
  SIGINT/SIGTERM clean shutdown of both processes.
- **Subprocess management** — `SPAWN_OPENCODE=true` auto-starts `opencode serve`
  with exponential backoff on crashes (2s→4s→8s→16s→30s), SIGTERM→SIGKILL
  fallback, and log capture to `LOG_DIR`.
- **Multi-user allowlist** — `ALLOWED_USER_IDS=a,b,c` accepts comma-separated
  Telegram user IDs. Backward-compatible with legacy `ALLOWED_USER_ID`.
- **TUI ↔ Bot state sync** — bot tracks the TUI's selected session and current
  agent in realtime via SSE events, with 5s polling fallback.
- **Info commands** — `/diff` (per-file patch preview), `/todo` (status markers ✓/▶/○),
  `/context` (agent, model, tokens, cost with next-override display).
- **Inline tool calls** — streaming cards show `▸ bash · cmd`, `▸ read · path`,
  `▸ grep · pattern` lines (configurable via `TOOL_CALLS_INLINE`).
- **Push notifications** — pushes to Telegram when: (a) a task runs >60s then
  finishes, (b) a test failure is detected in bash output. Rate-limited to
  10/hour with per-session 5min cooldown.
- **Inline Stop button** — all streaming/thinking cards include a ⏹ Stop button
  that immediately aborts the current generation.
- **Cost footer** — every assistant response shows `💰 $X.XX · ↑in ↓out · agent · model`.
  `/status` aggregates daily session costs.
- **Init wizard** — `npx -y opencode-remote-control init` interactively
  prompts for bot token, user IDs, and spawn preference, tests Telegram
  connectivity, writes `.env`.
- **CLI binary** — `oprc` (shortcut for `opencode-remote-control`).
- **Two-step `/model` picker** — select provider, then model; avoids
  Telegram's 4000-char message limit.
- **launchd plist + install/uninstall scripts** for macOS background service.

### Changed
- `/context` now shows pending next-agent and next-model overrides.
- `/help` and `setMyCommands` now include `/diff`, `/todo`, `/context`.
- Approval handler supports both v1 (`permission.updated`) and v2
  (`permission.asked`) event types with compatible field mapping
  (`title`↔`permission`, `permissionID`↔`requestID`, `response`↔`reply`).
- `.env.example` now documents `TOOL_CALLS_INLINE` and `PUSH_TEST_FAILURES`.

### Fixed
- Approve requests correctly push to Telegram bot regardless of opencode
  server version (v1 or v2 event schema).

## v0.3.0-rc.1 — 2026-05-16

### Added
- **SDK-native submission** — default path is now `client.session.prompt()`;
  TUI inject is optional (`TUI_VISIBLE=true`)
- **Transport abstraction** — `Transport` interface with `Card`/`Button` types;
  Telegram is the first implementation
- **Persistent state** — `data/state.json` stores `lastSessionId`, `nextAgent`,
  `nextModel` across restarts
- **Per-message agent/model override** — `/agent` and `/model` set sticky
  overrides applied to subsequent prompts (no more TUI cycle/picker)
- **New env vars** — `TUI_VISIBLE`, `STATE_PATH`, `TRANSPORT`
- **OSS docs** — `LICENSE` (MIT), `SECURITY.md`, public `README.md`,
  `docs/ARCHITECTURE.md`, per-transport docs
- **CI** — GitHub Actions workflow (`npm ci`, `npx tsc --noEmit`, `npm test`)
- **Issue/PR templates**

### Changed
- Restructured `src/bot/` → `src/core/` + `src/transport/telegram/`
- Moved `src/bot/reply.ts` → `src/transport/telegram/reply-stream.ts`

### Removed
- `src/bot/` directory and all its contents (replaced by new architecture)
- Obsolete unit tests for old handlers

## v0.2.0 — 2026-05-15

### Added
- `/files` command showing file operations from session messages
- `/session` pin/unpin with inline buttons
- Cardified commands (`/status`, `/start`, `/help`, `/current`)
- Callback handler framework

## v0.1.0 — 2026-05-14

### Added
- Initial MVP: Telegram bot relaying to local opencode TUI
- SSE event stream subscriber
- TUI inject submission path
- Approval flow with inline buttons
- launchd deployment
