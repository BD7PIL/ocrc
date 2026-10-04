# Architecture

> How ocrc is actually structured, as of **v0.26.5**. Everything here is
> grounded in the current source; file references are clickable anchors into
> `src/`. For runbooks see [OPS.md](OPS.md); for the SSH-remote design see
> [remote-provisioning-design.md](remote-provisioning-design.md).

## The one-paragraph version

ocrc is a long-lived **relay** sitting between your coding agent(s) and your
surfaces (Telegram + Web PWA). Agent events flow DOWN through a normalization
layer into per-session `StructuredCard`s on a **CardBus**; user messages flow
UP through the same relay into per-session, serialized turns against an
**AgentBackend**. The core speaks only these two seams, so the same core runs
in four host shapes (V1 plugin, V2 plugin, standalone, remote-driver) and any
number of backends.

## 分层原则（2026-10-05 定稿；产品定义见 [PRODUCT.md](PRODUCT.md)）

每个新需求必须先声明落点，不属于任何一层的不做：

| 层 | 内容 | 判据 |
|---|---|---|
| **核心** | relay / CardBus / registry / AgentBackend seam | 换掉任何壳它都不变 |
| **壳** | Telegram ✅ / Web PWA ✅ / ocrc Desktop（规划） | 可替换的表现面 |
| **宿主** | V1 插件 ✅ / V2 插件（待立项）/ standalone ✅ / SSH remote ✅ / Windows 被控（有界补丁：Node 端口探测、配置路径、e2e） | opencode 在哪跑 |
| **分发** | npm ✅ / 桌面安装器（随壳）/ 企业离线分发（未来） | 怎么装 |

**兼容基线**：被控端 opencode pin 1.18.x（V2 支持独立立项）；EL7 为遗留下限；
新部署 x86_64 现代 baseline。

**路线图**（2026-10-05 排定）：① 宪法 + pact 清理 → ② 左栏 v2（三桶/搜索/
归档/远程标识）+ 远程向导 v2 → ③ 企业中转（代理环境注入 + ProxyJump 文档）
→ ④ Windows 被控（看需求）→ ⑤ V2 迁移 → ⑥ ocrc Desktop 薄壳（**Electron
倾向**：opencode 2026-05 Tauri→Electron 迁移 + ZCode desktop 双先例；启动链
= 拉起守护 → 等端口 → 开窗，参考 opencode desktop 的 health-poll/Basic/kill
生命周期与 ZCode desktopTray 菜单）。

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

### AgentBackend (command path) — src/core/agent/backend.ts

Every operation the transports need, normalized: `prompt/abort`, session CRUD,
reads (`getHistory/getDiff/getTodos/getContext/...`), catalog, questions,
permissions, plus optional capability-gated extras (`getSkills`, `getVcs`,
`getControls`, `suggestFollowUps`, ...). `BackendCapabilities` drives honest
UI degradation per backend. Implementations:

- **OpencodeBackend** (opencode-backend.ts): SDK client for typed routes, raw
  `ocFetch` (HTTP Basic from `OPENCODE_SERVER_PASSWORD`) for the many
  endpoints the SDK doesn't type (skills/files/worktrees/questions/revert/
  tui-select). Reads the LOCAL filesystem only for `getVcs/getVcsDiff` (spawned
  read-only git — the server's /vcs takes minutes on huge worktrees) — omitted
  on remote backends. 0.26: per-backend `fetchImpl` + SDK client-level Basic
  headers for remotes.
- **AcpBackend** (acp-backend.ts): drives a spawned ACP agent over stdio
  (acp-connect.ts). OWNS its event source (`onEvent`); persists sessions +
  history itself (acp-store.ts — ACP agents expose neither); tombstones
  instead of deletes (kimi has no session/delete); recovers from session
  takeover by re-issuing `session/load` (resyncIfStolen).
- **V2Backend** (v2-backend.ts): ctx-domain calls; capabilities mostly off —
  honest empties where V2 ctx has no slice yet.

### AgentEvent (event path) — src/core/agent/event.ts

Six normalized kinds: `part` / `delta` / `idle` / `error` / `notice` / `role`.
Both opencode events (opencode-normalizer.ts) and ACP `session/update`
(acp-normalizer.ts — stateful: synthesizes part ids for ACP's id-less text
chunks) reduce to these, so relay logic is backend-agnostic.

### BackendRegistry — src/core/agent/registry.ts

`forSession(sid)` resolves the owning backend from state's persisted
`sessionBackends` map (tagged at creation and on every listing); untagged →
primary. New sessions route to `active()` (UI selection).

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
assistant card (upserts the streaming card in place via shared card id) and
stamps `markAssistantDelivered` so push doesn't double-notify.

**Correctness load-bearing details** (each pinned by tests in
tests/unit/relay.test.ts): user parts never enter the accumulator (`role`
events + race retraction); aborts stay mapped under BOTH provisional and
resolved session keys until turn end; `hasSession` treats only 404 as "gone" —
transport errors must not misroute; externally-initiated (TUI) turns are
adopted with a real timeout so they can't leak; ephemeral sessions (Tier2
suggestion side-calls) never surface to feeds.

## Upflow: user → agent

`IncomingMessage` (core/types.ts) from Telegram text/photo, web POST
/api/message, or the scheduler → `relay(msg)`:

1. **Queue**: per-session turn queue — a second message for a busy session
   waits; different sessions run concurrently; failures never wedge the gate
   (relay.ts:177-200). Telegram acks with「已排队」via the shared abort
   registry, not a local flag.
2. **Resolve target**: `msg.sessionId` (web pins the viewed session) → pinned
   → TUI-selected (if visible) → last → newest root session. Short suffixes
   normalize via `normalizeSessionId` (≥6 chars, unambiguous endsWith match,
   state.ts:90). Target validated with `hasSession` before submit.
3. **Submit** with per-message agent/model overrides;
   `submitWithRetry` — network-class errors only, 5 tries, 2s exponential
   (relay.ts:57).
4. Publish `thinking` + `user` cards (user card id = incoming message id so
   the web's optimistic card reconciles in place); install the response ctx;
   return. Finalization happens on `idle`.

## Telegram surface (src/transport/telegram/)

- **index.ts** — transport factory: allowlist middleware (silent drop), photo
  intake (largest PhotoSize → base64), reply-keyboard hears-routers, callback
  routing (`permission:*`, `q:*`, `menu:*`, `retry:*`, `sug:*`, `wt:*`,
  `ls:*`, `sk:*`, `tmode:*`, legacy `approve:*:*` with sha1 short tokens for
  the 64-byte callback_data limit), grammY polling with 409/401 fatal handling.
- **streaming-render.ts + streaming/response-streamer.ts** — the turn
  pipeline: streaming cards → per-part progressive throttle
  (1s→2s→5s→10s by session runtime, stream-throttle.ts) → editMessageText;
  429 honors retry_after; first native failure degrades the message to plain
  text; finalize flushes in place + appends a tools/meta footer (hidden at
  `standard` granularity) + regenerate action bar.
- **render/** — markdown → TelegramBlock (remark) → oversize splitting →
  chunker (32k char / 480 block budgets; plain fallback 3800) → parts.
- **managers/ + flows** — InteractionManager (single mutex slot + generation),
  PermissionManager (merges equal permission requests; one click fans out all
  requestIds), PermissionFlow, QuestionFlow (multi-select wizard, 30min TTL).
- **handlers.ts** — 35 commands; **i18n/** — zh/en (`OCRC_LOCALE`), flat
  namespaced keys, fallback zh→en→key.
- Historical note: the grinev pipeline was ported wholesale in P2b-M2; where a
  ported module is not yet wired into index.ts it is dead code — see the
  orphans list in CHANGELOG (Unreleased) before "cleaning up" render/streaming
  files.

## Web surface (src/transport/web/)

- **Auth**: pluggable `AuthStrategy` (connectivity/auth/) — `token`
  (constant-time compare; Bearer header, cookie, or `?token=` on the /ws
  upgrade ONLY) or `cf-access` (JWT via jose). devBypass requires a real
  loopback *socket peer* — a loopback bind alone is not a bypass signal
  (tunnels connect from 127.0.0.1).
- **Pairing (M11)**: surfaces issue 1-minute single-use PENDING tokens
  (`#pair=` fragment); the device exchanges at POST /api/pair/exchange for the
  permanent token. The onboarding landing page (pre-auth) shows a live QR +
  channel status only.
- **REST**: ~40 endpoints under /api (see web/src/lib/api/client.ts for the
  client-side list; server.ts registers the routes).
- **WS protocol** (ws-hub.ts): client sends `{type:'subscribe',sessionId,sinceSeq}`,
  `unsubscribe`, `ping`. Server replies `hello{sessions}`, `card`,
  `sdelta`, `replayEnd{lastSeq,complete}` — `complete:false` (client snapshot
  predates the ring buffer) tells the client to REST-resync. Cards carry
  monotonic per-session `seq` for dedupe/ordering. Proactive push cards are
  Telegram-only (the web already shows the turn live). maxPayload 64KB.
- **Static**: adapter-static SvelteKit output; immutable hashed assets cache
  forever, index.html always revalidates; SPA fallback serves index.html for
  navigation paths only.

## Remote hosts (0.26) — src/core/remote-host.ts

State machine `unknown→detecting→provisioning→launching→online` (+`needs-auth`
/`error`/`offline`/`disabled`). One ssh process does tunnel + remote serve
(`ssh -N -L local:127.0.0.1:remotePort host 'opencode serve …'`), so ssh death
kills everything it started; respawn 2s→60s backoff with fresh detect each
time (a stale "port listening" inspection would respawn-loop). Provisioning
pins the LOCAL opencode version (official installer; fallback: scp the local
binary — never a musl/compat build). Per-remote SSE feeds the same
dispatchEvent, so remote turns mirror exactly like local ones. Design detail
and the ZCode comparison live in
[remote-provisioning-design.md](remote-provisioning-design.md).

## State & persistence — `~/.ocrc/` (override: `OCRC_HOME`)

| File | Owner | Notes |
|---|---|---|
| `state.json` | core/state.ts | last/pinned/tui session, next agent/model, active workspace, session→backend map; 100ms debounced atomic write |
| `token` | connectivity/auth/token.ts | web access token, 0600 |
| `primary.lock` | core/primary-election.ts | PRIMARY election |
| `channels.json` | core/channels.ts | per-channel bot settings (0600) |
| `schedules.json` | core/scheduler.ts | scheduled prompts |
| `remotes.json` | core/remotes.ts | SSH remote hosts incl. generated server passwords (0600) |
| `acp-sessions.json` | agent/acp-store.ts | ACP sessions + history (standalone host) |
| `config.env` | installer/CLI | KEY=VALUE, 0600 |
| `ocrc.log` (+`.old`) | utils/logger.ts | 10MB rotate; 500-line ring buffer also served at /api/logs |
| `run/` | cli/service.ts | pid files, last.json (restore), paired-count |

All stores share the same pattern: in-memory cache → 100-200ms debounced
`*.tmp`+`rename` atomic write; corrupt file → warn + start empty.

## Configuration

Resolved in src/plugin/config.ts; FIRST dotenv file wins (`~/.ocrc/config.env`
→ plugin dir `.env` → cwd), fork names beat legacy upstream names
(`OCRC_*` > `WEB_*`). Highlights (full table in README):

| Var | Default | Note |
|---|---|---|
| `OCRC_WEB_HOST` / `_PORT` | `0.0.0.0` / `4099` | LAN-first fork decision; token gate non-optional |
| `OCRC_WEB_ENABLED` | `true` (env) | |
| `OCRC_STATE_PATH` | `~/.ocrc/state.json` | |
| `CHAT_TIMEOUT_MS` | `600000` | per-turn abort timer |
| `TG_CHUNK_SOFT_LIMIT` | `3500` | TG pagination |
| `OCRC_BACKENDS` / `OCRC_ACP_CMD` | — / `kimi acp` | standalone host only |
| `LOG_LEVEL` | **`warn`** | file-only logging (never stdout — it would pollute the TUI) |
| `OPENCODE_SERVER_PASSWORD` | — | enables HTTP Basic on ALL raw server calls |
| `OCRC_LOCALE` | `zh` | TG i18n |

## Extending

- **New backend**: implement `AgentBackend` (+ honest capabilities), register
  in the host's backend list, normalize its events into `AgentEvent`. Relay,
  transports, web UI gate off capabilities — nothing else changes.
- **New transport**: docs/transports/CONTRIBUTING-NEW-TRANSPORT.md.

## Intentional decisions (do not "fix" without reading the rationale)

- **busy 语义分叉**: the web Composer judges busy from the LAST card while
  +page/SessionList judge from ANY live card — deliberate (0.23 fixes,
  commit 9bc5317), not drift.
- **WS token in the query string**: browsers cannot set headers on a
  WebSocket; accepted on the /ws upgrade path only (token.ts:95).
- **`StrictHostKeyChecking=no` (not accept-new)**: EL7 ships OpenSSH 7.4 and
  the `accept-new` option needs 7.6+ (remote-host.ts:82).
- **No process.exit in the plugin**: an exiting plugin takes the opencode host
  down (entry.ts:49 guards absorb rejections instead).
