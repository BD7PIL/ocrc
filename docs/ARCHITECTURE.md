# Architecture

> How ocrc is actually structured, as of **v0.27.0-M0** (2026-10-07 rebuild
> kickoff). Everything here is grounded in the current source; sections marked
> **(0.27 规划)** are approved-but-not-yet-built plans from the rebuild
> blueprint. File references are anchors into `src/`. For runbooks see
> [OPS.md](OPS.md); for the SSH-remote design see
> [remote-provisioning-design.md](remote-provisioning-design.md); for product
> boundaries see [PRODUCT.md](PRODUCT.md).

## The one-paragraph version

ocrc is a long-lived **relay** sitting between your coding agent(s) and your
surfaces (Telegram + Web). Agent events flow DOWN through a normalization
layer into per-session `StructuredCard`s on a **CardBus**; user messages flow
UP through the same relay into per-session, serialized turns against a
**HarnessAdapter** (formerly AgentBackend — the seam is being formalized,
0.27 规划). The core speaks only these two seams, so the same core runs in
four host shapes (V1 plugin, V2 plugin, standalone, remote-driver) and any
number of backends.

## 分层原则（2026-10-05 定稿；产品定义见 [PRODUCT.md](PRODUCT.md)）

每个新需求必须先声明落点，不属于任何一层的不做：

| 层 | 内容 | 判据 |
|---|---|---|
| **核心** | relay / CardBus / registry / HarnessAdapter seam | 换掉任何壳它都不变 |
| **壳** | Telegram ✅ / Web：Svelte PWA（M4 退役）→ **web-next**（React，0.27 规划 M0 起）/ ocrc Desktop（规划，与 web 共用 app 层） | 可替换的表现面 |
| **宿主** | V1 插件 ✅ / V2 插件（待立项）/ standalone ✅ / SSH remote ✅（WSL/Docker 补真中）/ Windows 被控（有界补丁） | opencode 在哪跑 |
| **分发** | npm ✅ / 桌面安装器（随壳）/ 企业离线分发（未来） | 怎么装 |

**兼容基线**：被控端 opencode pin 1.18.x（V2 支持独立立项）；EL7 为遗留下限；
新部署 x86_64 现代 baseline；构建 node ≥ 20（Tailwind v4 门槛）。

**重建路线图（2026-10-07 定案，0.27.x 受控重建）**：`web-next/`（React）平行
新建，旧 Svelte 壳冻结只修 P0，M4 用户验收后一次性切换删除。每程 = CDP 全组
件矩阵 + 隔离栈门禁 + :4099 实测。
**M0 地基**（本文档/脚手架/搬运层/双 root/令牌重组）→ **M1 壳**（三栏+左栏+
命令中心+快捷键三层）→ **M2 聊天流**（时间线/markdown 管线/composer/dock）
→ **M3 右栏**（SidePane 页签族+TurnNavigator）→ **M4 ocrc 域+退役切换**
（新建任务页两态/provisioning UI/自动化主视图/BotsDialog/PlanHud 迁移）→
**M5 设置域** → **M6 分享+工作台+画板** → **M7 浏览器/browser-use** →
**M8 通道域升级**。

## Host shapes (one core, four entrypoints)

All four build the same core (`state + CardBus + relay + transports + push`)
— only the **ControlPlane** adapter differs (src/plugin/control-plane.ts):

| Shape | Entrypoint | Backend | Event source |
|---|---|---|---|
| **V1 plugin** (production) | `remoteControlPlugin` — default export called as `server(ctx)` | OpencodeBackend over `ctx.client` | the plugin `event` hook + a dedicated SSE for `question.*` only |
| **V2 plugin** | `dualEntry.setup(ctx)` — `setup` member | V2Backend over ctx domains | `ctx.event.subscribe` mapped to V1 shapes (plugin/v2/event-map.ts) |
| **Standalone host** | `ocrc host` (src/cli/host.ts) | registry from `OCRC_BACKENDS` | ACP backends own their stream; opencode backends get a spawned server + global SSE |
| **Remote driver** | folded into V1 entry (src/plugin/entry.ts:148) | one `remote:<id>` OpencodeBackend per enabled host in `remotes.json` | per-remote `/global/event` SSE (core/remote-events.ts) |

Key facts per shape:

- **Election**: opencode loads the plugin per workspace; `tryBecomePrimary()`
  (core/primary-election.ts) elects exactly one PRIMARY per machine via an
  `O_EXCL` lock file (`~/.ocrc/primary.lock`, stale-pid reclaim). PASSIVE
  instances return inert hooks and never bind ports or poll Telegram.
- **V2 transient gate**: `opencode run` one-shot processes stand down
  (entry.ts:86) — no TG poller flapping against the resident service.
- **Single event source (V1)**: on 1.18.32 the plugin event hook carries ALL
  workspaces' events; wiring the global SSE too produced duplicate finalize
  cards (verified live — see control-plane.ts:67 comment). Sole exception:
  `question.*` never rides the hook, so a dedicated SSE forwards only those
  three types.

## The seams

### HarnessAdapter (command path) — src/core/agent/backend.ts

**(0.27 规划)** The existing `AgentBackend` seam is formalized into the
**HarnessAdapter** contract: opencode-1.18 is the first adapter; opencode-V2
and pi are future adapters. The formalization adds: (a) opencode-specific
concepts (part kinds, tool names, todo shape) quarantined inside the
opencode adapter instead of leaking into relay/web shapes, (b) explicit
capability negotiation per backend (the existing `BackendCapabilities`
extends), (c) the backend domain model below.

Every operation the transports need, normalized: `prompt/abort`, session
CRUD, reads (`getHistory/getDiff/getTodos/getContext/...`), catalog,
questions, permissions, plus optional capability-gated extras (`getSkills`,
`getVcs`, `getControls`, `suggestFollowUps`, ...). `BackendCapabilities`
drives honest UI degradation per backend. Implementations today:

- **OpencodeBackend** (opencode-backend.ts): SDK client for typed routes, raw
  `ocFetch` (HTTP Basic from `OPENCODE_SERVER_PASSWORD`) for the many
  endpoints the SDK doesn't type (skills/files/worktrees/questions/revert/
  tui-select). Reads the LOCAL filesystem only for `getVcs/getVcsDiff` —
  omitted on remote backends. Per-backend `fetchImpl` + SDK client-level
  Basic headers for remotes.
- **AcpBackend** (acp-backend.ts): drives a spawned ACP agent over stdio
  (acp-connect.ts). OWNS its event source (`onEvent`); persists sessions +
  history itself (acp-store.ts); tombstones instead of deletes; recovers from
  session takeover by re-issuing `session/load` (resyncIfStolen).
- **V2Backend** (v2-backend.ts): ctx-domain calls; capabilities mostly off —
  honest empties where V2 ctx has no slice yet.

### AgentEvent (event path) — src/core/agent/event.ts

Six normalized kinds: `part` / `delta` / `idle` / `error` / `notice` / `role`.
Both opencode events (opencode-normalizer.ts) and ACP `session/update`
(acp-normalizer.ts) reduce to these, so relay logic is backend-agnostic.

### BackendRegistry — src/core/agent/registry.ts

`forSession(sid)` resolves the owning backend from state's persisted
`sessionBackends` map; untagged → primary. New sessions route to `active()`.
**(0.27 规划)** remote backends register dynamically (no host restart to
appear in the session list — today's wart).

## Backend domain model (0.27 规划 — PRODUCT.md 第零点五条)

**backend = (transport × lifecycle)**：

- **transport**: 本地直连 / SSH 隧道 / WSL / Docker.
- **lifecycle**: **adopt**（已有引擎，host 只驾驶、永不 kill——本地
  `OCRC_SERVER_URL` 与远端纯隧道态）× **spawn**（host 拉起管生死；本地
  disposer、远端绑隧道共生）。

The new-session UI must present both states explicitly per transport
(已装→接入 vs 未装→拉起). ZCode has spawn-only everywhere; adopt-first is
ocrc's differentiator and the architectural basis of the "zero test traffic
through the user's engine" rule.

## Provisioning & updates (0.27 规划 — PRODUCT.md 第零点六条)

- **自持二进制缓存** `~/.ocrc/bin-cache/`: at host install/update time the
  host pulls official per-platform artifacts from the npm registry for the
  pinned version (linux-x64/arm64; win32-x64 bounded). Artifacts are selected
  by TARGET platform, decoupled from the host's own platform (today's scp
  same-platform check is retired).
- **Push is the primary path** (remote needs no internet);
  `curl opencode.ai/install` becomes the optional "self-install" path.
  Official artifacts only — never musl/compat builds.
- **Centralized updates**: host is the single version source; drift detection
  (remote `inspection.version` ≠ host pin) surfaces a one-click "push upgrade
  to pin" in the wizard/panel. Web assets ship with the host.
- Proxy env (`httpProxy/httpsProxy/noProxy/caPath`) covers BOTH the remote
  serve's LLM traffic and install/download channels (today's gap: the install
  curl inherits no proxy env).

## Downflow: agent → user

```
opencode event hook / global SSE / remote SSE / ACP callbacks
        │  normalize
        ▼
   AgentEvent ──► relay.handleEvent (core/relay.ts)
        │  per-session PluginSessionCtx:
        │  StreamAccumulator + partTextAcc + pendingDelta
        ▼
   StructuredCard ──► CardBus (core/card-bus.ts)
        │               per-session monotonic seq + 256-card ring buffer
        ├─► Telegram transport (streaming pipeline, below)
        ├─► WsHub (transport/web/ws-hub.ts) — 'card' frames + sdelta side channel
        ├─► push engine (core/push.ts)
        └─► acp-store recording (standalone host)
```

**Streaming protocol (0.25+)**: raw deltas are never broadcast per token.
`sdelta` frames coalesce per part on a 250ms timer and ALWAYS flush
immediately before a snapshot card — the wire order "deltas, then the
snapshot containing them" is what makes the client's wholesale-replace
append-safe (relay.ts:397-449). Snapshot cards are throttled by accumulated
volume: 1s floor, 2s past 50k chars, 3s past 150k. `idle` finalizes the
assistant card and stamps `markAssistantDelivered` so push doesn't
double-notify.

**Correctness load-bearing details** (pinned by tests in
tests/unit/relay.test.ts): user parts never enter the accumulator; aborts
stay mapped under BOTH provisional and resolved session keys until turn end;
`hasSession` treats only 404 as "gone"; externally-initiated (TUI) turns are
adopted with a real timeout; ephemeral sessions never surface to feeds.

## Upflow: user → agent

`IncomingMessage` (core/types.ts) from Telegram text/photo, web POST
/api/message, or the scheduler → `relay(msg)`:

1. **Queue**: per-session turn queue — a second message for a busy session
   waits; different sessions run concurrently (relay.ts:177-200).
2. **Resolve target**: `msg.sessionId` → pinned → TUI-selected → last →
   newest root session. Short suffixes normalize via `normalizeSessionId`.
3. **Submit** with per-message agent/model overrides; `submitWithRetry` —
   network-class errors only, 5 tries, 2s exponential (relay.ts:57).
4. Publish `thinking` + `user` cards (user card id = incoming message id so
   the web's optimistic card reconciles in place); finalization on `idle`.
5. **Turn end** fires `RelayDeps.onTurnEnd(sid)` (relay.ts, idle branch) — the
   single point where a turn is known to be over. The goal loop hangs off it.

## Session goals (N12) — src/core/goal.ts

The engine has no goal concept (the 185 MB opencode binary contains none of it),
so the whole ZCode goal loop lives host-side and hangs off the relay's turn-end
hook. Per session:

    turn ends → account usage → budget gate → completion verifier (child
    session, tool-less) → pass ⇒ complete / not-satisfied+nextAction ⇒
    continuation turn / else ⇒ paused + notification

Three gates stop a runaway loop: the token budget (upstream has it), an
iteration cap (12) and a no-progress detector (two identical nextActions in a
row) — the latter two are ours. The verifier **fails closed**: bad JSON, a
thrown call or an empty reply pauses the goal, where upstream fails open and
assumes the goal passed.

Prompt text is ported from upstream's `contracts/src/tools/target.ts` so both
sides mean the same thing by "done"; the record's authoritative copy is the
per-session `goals` slot in state.json (upstream keeps projection states out of
storage — so do we: the vendor's six-state vocabulary is derived in the /z/
bridge from our four-state record plus the transient `verifierRunning`).

Continuation turns are **visible**: origin `goalContinuation` on the relay's
user card, and a `[ocrc-goal-continuation]` first line carrying a short display
text (the /z/ bridge folds the prompt body into the vendor's epilogue
disclosure; Telegram suppresses the synthetic bubble). A goal is mutually
exclusive with plan mode. Cold recovery pauses every active goal — never
auto-resumes — matching upstream.

Surfaces over the same record: `GET /api/session/:id/goal` + `POST /api/goal`
(set|pause|resume|clear), Telegram `/goal set|pause|resume|clear|status` with
inline buttons, and the ws `goal` frame → `state.updated` for the panel.
Setting a goal kicks off its first turn (upstream's command runs its own turn);
off-peak tasks pass `kickoff: false` because their own prompt is turn 1.

## Dynamic workflows (P0–P4) — src/core/workflow/ + vendor/zcode-dwf/

ZCode 的 workflow 是**上游引擎 + 官方钩子工具面 + host 侧状态**的组合，不是自研编排
执行引擎（PRODUCT.md 的硬边界）。三层各是谁的：

- **引擎 = vendor 的上游**（`vendor/zcode-dwf/`，Apache-2.0，登记制见 PATCHES.md）。
  两包只依赖 `typescript` + node 内建，src 对 `@zcode` 零 import。它是**纯确定性状态机**：
  决定该发生什么、把决定落 journal，副作用一律交给 driver。脚本编译（TS API）、typed
  schema 合成、repair/nudge 裁决、replay/resume、`vm` 裸 realm 沙箱都在里面。
- **driver = 我们**（`src/core/workflow/driver.ts`）。把引擎的决定落到 ocrc 的引擎上：
  铸 actor 会话（映射落 journal，resume 时重挂）、下发 prompt、abort、把 turn 结束经
  `WorkflowReportSink` 回报。两处接缝值得记：actor 会话**journal 化**（不是推导出来的，
  因为 ocrc 的 backend 自己铸 session id），turn 结束**由 host 送进来**（relay 的
  onTurnEnd，fire 在最终卡片发布之后，所以给引擎的文本与用户看到的是同一份）。
- **host = 我们**（`src/core/workflow/{manager,journal,world,artifacts,saved,approval}.ts`）。
  run id 铸造、run 行、进程并发上限与 run 级 seat gate、token 预算闸、取消、冷恢复、
  amend 的 lineage、world 读的 caps、artifact 字节、saved workflows、world.run 的人工门。

**journal**：每 run 一个 `<ocrcHome>/workflows/runs/<runId>.jsonl`，同步追加、内存索引按需
从文件重建。选 JSONL 而不是上游的 SQLite：本机下限 EL7/glibc 2.17，native 模块是真实风险，
而 `appendFileSync` 是 O(1) 且崩到最后一个完整行。**事件由引擎写一次**（`driver.emit` 只做
实时扇出，绝不当第二个写入者——这条踩过坑，见 workflow-p2-record.md）。

**工具面**（`src/plugin/workflow-tools.ts`，挂在 ATTACHED 插件上）：作者侧
`CreateWorkflow / AmendWorkflow / GetWorkflowRun / ListWorkflowRuns / ResumeWorkflowRun /
SaveWorkflow / ListSavedWorkflows / EvalWorkflowSnippet / GetWorkflowSkill`，actor 侧
`submit_result / escalate / ResolveWorkflowQuestion`。每个都是打回 host 的薄 HTTP 调用、
无状态（run id 由 host 分配）。**技能门**：创建类工具在本会话未加载 `dynamic-workflows`
技能前直接拒绝（上游同款），开门走 `GetWorkflowSkill` 或 opencode 官方 `skill` 工具的
`tool.execute.before` 钩子。

**P0 的架构改动（插件与 host 共存）**：锁文件记 `role`（`host` / `plugin`）与 host 的 web
URL；host 启动即取锁标 `role:'host'`；插件读到活着的 host 就进 **ATTACHED**——只注册工具、
零 transport、零端口、连 Telegram token 都不需要（host 拥有 bot）。没有 host 时逐字维持
旧行为。这是「引擎里的 ocrc 工具」能存在的前提。

### P4：面板面（/z/ 里的 workflow）

引擎与工具面（P0–P3）只解决「能用」；P4 解决「看得见」。四层各归各位：

- **投影**（`src/core/workflow/projection.ts`）：journal → vendor 的 `WorkflowRunState`。
  上游用增量 reducer 从实时进度事件喂出这份状态，冷回放另有一条「按 journal 行补种」的路径；
  ocrc 是后者形状的生产者（journal 是唯一权威、每次读都重算），所以这是那条补种路径的对应物。
  派生：`usage.nodesUsed`、`nodes[].phase`（事件）、`phases/phaseNames/currentPhase/phaseAlongside`、
  `reports[]`、`pendingQuestions[]`（引擎事件 ∪ actor 侧 `escalate` 登记表）、`artifacts[]`、
  `resumable`（与 `manager.resume` 同一谓词）、`resultPreview`。**每张表按 vendor 线上界裁剪并
  置 `truncated`**——超界不是丢一个键，是整帧解析失败。
- **相位表**（`phases.ts`）：`run-launched` 里的 `phaseNames/phaseAlongside` 由提交方从因果图填入，
  上游在「run 行还不存在」时才转录这条事件；ocrc 刻意先建行再启动，所以**由宿主自己在
  `run-started` 之后补写**（元数据本来就是宿主写的）。
- **七条读面**（`queries.ts` + `display.ts`）：`workflowRunEvents` / `workflowRuns` /
  `workflowRunArtifacts` / `workflowRunArtifactData` / `workflowRunArtifactRead` /
  `workflowRunWorkspace` / `workflowRunNodeResult`，形状逐字照 vendor（渲染端会校验），
  授权按 vendor 的契约（`sessionId` 必须是 run 的 parentSessionId，不符与「无此 run」同一个 404）。
  另有 `display.ts`：工具卡的因果图（run 侧页画的就是它），用同一份 vendored 分析器产出。
- **桥**（`web-next/src/zcode-services/{workflowProjection,zcodeAgentService}.ts`）：投影进
  `snapshot.workflowRuns`、键级增量用 vendor 自己的 `diffWorkflowRunsState`（容器 revision 归
  消费侧）、ws `workflow` 帧只是「这条 run 动了」的提示（面板回读投影，单一时钟）、
  sessions-index 的 `workflowActivity`、`backgroundWorks` 的 `kind:'workflow'`（workId ≡ runId）、
  4 条命令 + 6 条 saved 方法。**`display` 挂在发起行的 `display` 上**，join 键由宿主记下的
  `(messageID, toolName)` 与桥自己的工具行解析（工具卡的 `toolCallId` 由引擎在调用返回后才铸出）。

**P4b（amend 的导入缓存与转录种子）**：driver 在 ask 交换结束时补写
`NodeRecord.messageBoundary`（单位是 actor 会话的**卡片条数**，读 1000 条的窗口而不是
`getHistory` 默认的 50 条页；typed ask 在 `respondToSubmit` 的 accept 先写**临时值**、在
`notifyTurnEnd` 写**权威值**——vendored 契约把边界定义在「完整交换（含 repair/nudge 与 submit
之后的收尾消息）结束之后」。权威值所属的 turn end 常常在 run 结算**之后**才到，而引擎在
`run-settled` 后立刻 `dispose()`（会清空在飞表），所以边界义务存在一张**不随 dispose 清空**的
队列里，由 manager 的 `settledDrivers` 接住，并按**每会话 FIFO** 归属最老的在飞交换）。
宿主另记一行 `ask-boundary`（与 `run-join` 同族，含边界消息 id），`imported-cache.ts` 据此从
前驱 journal 构建 `ImportedRunCache`（preflight 与上游同规：任一条缺边界即整体拒绝；计数优先读
宿主那行，旧 run 回落到节点字段）。

**转录种子已实现**：分歧 actor 的会话由 `forkSession(sourceSessionId, …)` 从前驱转录复制而来。
实测钉死的引擎语义：**fork 的切点不含**被指的那条消息，所以 driver 读一次源转录、把 fork 指向
边界**之后**那条消息（源会话正好停在边界时用不带 id 的尾拷）。按后端能力降级：没有
`forkSession`（v2/ACP）就铸空会话并记一行日志，**不拒绝 amend**。仍有的两处降级（写在
`imported-cache.ts` 文件头与 docs/workflow-p4-record.md）：不带 in-flight 条目（半场对话不续），
resume 只回看一代前驱。

**P4b 之后的剩余项**：vendor 验收表上已无非 ✅ 的 workflow 项（四道门禁逐项对账，见
`docs/workflow-p4-record.md` 与 `web-next/vendor/CHECKLIST.md`）；如实保留的降级只有 imported-cache
那两处，加上边界归属在「同会话快速连答」这一边角上的不精确（记录里有专门一段）。

## Telegram surface (src/transport/telegram/)

- **index.ts** — transport factory: allowlist middleware, photo intake,
  hears-routers, callback routing, grammY polling with 409/401 fatal handling.
- **streaming-render.ts + streaming/response-streamer.ts** — progressive
  editMessageText pipeline with per-session throttle and markdown→plain
  degradation. (Three-way audit 2026-10-07: best-in-class vs ZCode bots and
  grinev — this stays the base.)
- **managers/ + flows** — InteractionManager, PermissionManager, PermissionFlow,
  QuestionFlow.
- **handlers.ts** — 35 commands; **i18n/** — zh/en.
- **(0.27 规划 M8)** absorb from ZCode: cross-process polling lock (atomic
  rename + lease + pid liveness), manual offset ack (persist, advance only on
  success), runtime status sink (polling/idle/error/occupied → ChannelsModal),
  command policy + BotFather menu sync, universal attachment pipeline
  (photo/document/video/audio/voice → download → prompt), cron "subscribe
  before dispatch" (no missed pushes on fast runs). Absorb from grinev:
  media output (asset extraction → sendPhoto/sendMediaGroup), session deep
  commands (/undo /redo /compact /usage, live model switch). Voice
  transcription and admin tiering are OUT (PRODUCT.md 第五条).

## Web surface (src/transport/web/)

- **Auth**: pluggable `AuthStrategy` — `token` (constant-time compare) or
  `cf-access`. devBypass requires a real loopback *socket peer*.
- **Pairing (P-remote, aligns ZCode v3.15.1; no relay, LAN direct)**: two
  credential tiers. ANCHOR devices hold the permanent token (`#token=` links
  `ocrc start` prints; session refresh/stop never kick them — revocation =
  `ocrc pair --reset`). PHONES pair through the remote-control SESSION
  (`connectivity/pairing.ts` store): while live, the `#pair=` pending QR is
  multi-use and exchange mints per-device in-memory session credentials
  (never the anchor token); `refresh` opens a new epoch (all phones kicked —
  the official 刷新二维码), `stop` closes the gate, host restart clears all.
  Session lifecycle endpoints (`POST /api/pair/session/start|refresh|stop`)
  are auth-gated + loopback-only (403 non-loopback, 409 under cf-access);
  `/status` is readable by any authed device. The same store rides the token
  auth strategy (`sessions` opt), so middleware/verifyUpgrade accept "anchor
  token OR live session credential".
- **REST**: ~48 endpoints under /api.
- **WS protocol** (ws-hub.ts): `{subscribe,unsubscribe,ping}` up; `hello`,
  `card`, `sdelta`, `replayEnd{lastSeq,complete}` down; `complete:false` →
  REST resync. Monotonic per-session `seq`. maxPayload 64KB. **This wire
  contract is frozen across the rebuild** — web-next speaks it unchanged.
- **Static (0.27 规划 M0)**: dual static root — `web/dist` (frozen Svelte
  shell) at `/` and `web-next/dist` (React shell) at `/next/` during
  migration (index.html revalidate, hashed assets immutable, SPA fallback per
  root); M4 switches the roots and deletes `web/`.

### web-next (0.27 规划 M0 起) — web-next/

React SPA replacing the Svelte shell: React 19 + react-router + Vite +
@tailwindcss/vite + zustand + vitest. Register sources: ZCode `packages/ui`
(mitigated via Apache-2.0 + NOTICE), dsh `ui-theme` global sheets, opencode
`packages/app` patterns. Migrated verbatim from the Svelte app (framework-free
layer + tests): ws/client, api/client+types, markdown/sanitize, ansi,
auth-token, auth-reload, nav/*, notify, summarizeTodos, contextBreakdown;
stores logic ports to zustand (seq/epoch resync semantics preserved
line-for-line). Precise-replication checklist: visualViewport `--kb` keyboard
tracking, pre-paint theme script (FOUC), SPA fallback + trailing-slash shapes,
index.html revalidate, service worker rewrite (Vite manifest; `/api` `/ws`
never intercepted). Platform seam (web no-op implementation) reserved for the
future Electron shell (register: ZCode `IPlatformService`).

## Remote hosts (0.26) — src/core/remote-host.ts

State machine `unknown→detecting→provisioning→launching→online`
(+`needs-auth`/`error`/`offline`/`disabled`). One ssh process does tunnel +
remote serve, so ssh death kills everything it started; respawn 2s→60s
backoff with fresh detect each time. Two session shapes per start(): remote
port already listening → pure tunnel (adopt, a user-managed serve); else
tunnel + our own serve (spawn, tunnel-bound lifecycle). Provisioning today:
official installer pinned to the local version; fallback scp of the local
binary (same platform only). Per-remote SSE feeds the same dispatchEvent.
**(0.27 规划 M4)**: bin-cache push as primary path (target-platform
artifacts), proxy env into install, drift warnings, path UI, dynamic
registration. Design detail in
[remote-provisioning-design.md](remote-provisioning-design.md).

## State & persistence — `~/.ocrc/` (override: `OCRC_HOME`)

| File | Owner | Notes |
|---|---|---|
| `state.json` | core/state.ts | last/pinned/tui session, next agent/model, active workspace, session→backend map, /z/ sidebar bookmarks+unread+archived, task groups, **per-session goals** (N12); 100ms debounced atomic write |
| `token` | connectivity/auth/token.ts | web access token (ANCHOR devices), 0600. Remote-control SESSION credentials are in-memory only (connectivity/pairing.ts store, shared into the token auth strategy) — restart clears them |
| `primary.lock` | core/primary-election.ts | PRIMARY election |
| `channels.json` | core/channels.ts | per-channel bot settings (0600) |
| `schedules.json` | core/scheduler.ts | scheduled prompts (cron semantics — TG /tasks) |
| `offpeak.json` | core/offpeak.ts | off-peak one-shot tickets (queued→running→completed/failed, FIFO single-concurrency, low-peak window) |
| `remotes.json` | core/remotes.ts | SSH remote hosts incl. generated server passwords (0600) |
| `acp-sessions.json` | agent/acp-store.ts | ACP sessions + history (standalone host) |
| `config.env` | installer/CLI | KEY=VALUE, 0600 |
| `ocrc.log` (+`.old`) | utils/logger.ts | 10MB rotate; ring buffer at /api/logs |
| `run/` | cli/service.ts | pid files, last.json (restore) |
| `bin-cache/` | core/remote-host.ts (0.27 规划) | pinned official opencode artifacts, per-platform |

All stores share the same pattern: in-memory cache → 100-200ms debounced
`*.tmp`+`rename` atomic write; corrupt file → warn + start empty.

## Configuration

Resolved in src/plugin/config.ts; FIRST dotenv file wins. Highlights (full
table in README):

| Var | Default | Note |
|---|---|---|
| `OCRC_WEB_HOST` / `_PORT` | `0.0.0.0` / `4099` | LAN-first; token gate non-optional |
| `OCRC_WEB_ENABLED` | `true` (env) | |
| `OCRC_STATE_PATH` | `~/.ocrc/state.json` | |
| `CHAT_TIMEOUT_MS` | `600000` | per-turn abort timer |
| `OCRC_BACKENDS` / `OCRC_ACP_CMD` | — / `kimi acp` | standalone host only |
| `LOG_LEVEL` | **`warn`** | file-only logging (never stdout) |
| `OPENCODE_SERVER_PASSWORD` | — | enables HTTP Basic on ALL raw server calls |
| `OCRC_LOCALE` | `zh` | TG i18n |

## Extending

- **New backend (adapter)**: implement the HarnessAdapter contract (+ honest
  capabilities), register in the host's backend list, normalize events into
  `AgentEvent`. Relay, transports, web UI gate off capabilities — nothing
  else changes.
- **各家 harness 优点吸收总账 + 适配器候选评估**: docs/research/harness-best-of.md
  （六家参照系逐项落地证据 + pi/omp/gjc 可行性 + gap 表）.
- **New transport**: docs/transports/CONTRIBUTING-NEW-TRANSPORT.md.

## Intentional decisions (do not "fix" without reading the rationale)

- **busy 语义分叉**: web Composer judges busy from the LAST card while
  +page/SessionList judge from ANY live card — deliberate (0.23 fixes), not
  drift. (M2 port must preserve.)
- **WS token in the query string**: browsers cannot set headers on a
  WebSocket; accepted on the /ws upgrade path only (token.ts:95).
- **`StrictHostKeyChecking=no` (not accept-new)**: EL7 ships OpenSSH 7.4;
  `accept-new` needs 7.6+ (remote-host.ts:82).
- **No process.exit in the plugin**: an exiting plugin takes the opencode
  host down (entry.ts:49 guards absorb rejections instead).
- **Remote spawn is tunnel-bound**: ssh death kills the remote serve —
  anti-stale/anti-drift by design (remote-host.ts header comment).
- **Fonts**: no `-webkit-font-smoothing: antialiased`, no
  `text-rendering: optimizeLegibility`, integer px sizes only, mono stack
  carries the CJK chain — the 0.26.22 发虚 fixes must not regress in
  web-next.

## 1.0-rc 收官状态（2026-10-07）

重建蓝图 M0–M8 全部落地（alpha.1 → 1.0.0-rc.1，17 个 alpha + rc）：

- **web-next/ 成为唯一 Web 壳**（M4-3 退役切换，Svelte 壳已删除）。
- **M5 尾巴已补**：技能源管理（源注册 + symlink 生效开关 + 名称冲突检测，
  约定 = 源目录注册表 `~/.ocrc/skills-sources.json`，生效 =
  `~/.config/opencode/skills/<name>` → symlink）。
- **M7/M8**：侧车浏览器（CDP 复用 :9222 headless shell）+ MCP 工具
  `ocrc mcp-browser`；通道域八件（runtime lock / offset journal / runtime
  状态 sink / 命令策略+菜单同步 / 附件管道 / cron preDispatch / 媒体输出
  相册 / 深命令）。
- 遗留：Terminal 页签（产品裁决不做）、技能源跨机同步（未来）。

验证基线：host vitest 601、web-next vitest 121、CDP 套件
`scripts/cdp/m*.mjs` 13 套全绿、隔离栈 E2E 10/10 + 12/12 ×2。
