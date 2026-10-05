# OCR 审查报告 — glm-5.3-flash × 17 commits（2026-10-05）

总览：44 文件 / 68 条（1 critical · 7 high · 25 medium · 35 low）/ 18m9s / 4.85M tokens（Coding Plan 额度）

处置：critical+high 全部处置（详见各 commit）；medium 修 20 条；low 35 条为风格建议未逐条采纳。

## Critical

### [CRITICAL] src/transport/telegram/streaming-render.ts:119
sendRichMessage is not a real Telegram Bot API method and nothing in this codebase implements it: the bot is a plain `new Bot(cfg.token)` with no grammy transformer/plugin registered (no `api.config.use` anywhere in src/), and a repo-wide search finds sendRichMessage only here (behind `as any`, which hides the type error) and in unit-test mocks. Against the real Telegram API every block-bearing part will 404. Since renderTelegramParts always emits source:"blocks" parts, this is the primary path: live streams will always take the plainOnly degradation (one wasted failing round-trip + error log per stream message; rich rendering never works), and the no-partials fallback in onFinalize throws with no degradation at all, so short answers lose their final message (index.ts's onCard catch only logs it). Implement an actual client-side rich sender (blocks → HTML/entities via sendMessage/editMessageText, e.g. registered as a grammy transformer) or degrade to the plain path here instead of relying on a nonexistent API method.

## [HIGH] desktop/main.js:48
The child process is spawned with no 'error' event listener. If `ocrc` is not on PATH (the default `OCRC_BIN`) or points to a missing/non-executable file, Node emits an unhandled 'error' event, which becomes an uncaught exception in the Electron main process and crashes the shell during boot — the most likely misconfiguration path produces a hard crash instead of continuing the health-poll/exit flow. Verified that nothing in the repo wires or validates OCRC_BIN, so this is the default behavior o

## [HIGH] src/transport/lark/index.ts:205
This routing is effectively broken for concurrent users: `sessionChats` is keyed by Lark's own event `session_id` (which never equals the agent's sessionId — the im.message.receive_v1 message entity doesn't even carry that field), so `chatIdOf` practically always falls through to `lastChat`, i.e. the most recent p2p chat that messaged the bot. With two users active, assistant replies, approval cards and errors for user A are delivered into user B's chat — cross-user message leakage. The relay pu

## [HIGH] src/core/remote-host.ts:626
The tar→ssh pipe has no 'error' listener on ssh.stdin. If ssh dies before the archive is fully written (unreachable host, auth failure, remote `tar` missing so the script exits before reading stdin), the pending pipe write raises EPIPE as an unhandled 'error' event on ssh.stdin, which crashes the whole Node process (this code runs inside the opencode serve/plugin host — one failed sync-config click takes down the server). Also, tar's exit code is never awaited: a tar failure that isn't a spawn '

## [HIGH] src/cli/service.ts:185
When the adopted instance's pid can't be determined (non-Linux, or Linux without `ss`/unparseable output), `childPid` stays null and the wait condition `childPid === null || alive(childPid)` is permanently true — even after the adopted server dies, the supervisor sleeps forever and never restarts the service. This directly contradicts the portOwner doc comment ('null is fine on other platforms — the supervisor then restarts instead of adopting') and defeats the supervisor's core purpose exactly 

## [HIGH] web/src/lib/components/ChannelsModal.svelte:104
This save is a silent no-op for all three non-Telegram channels. Server-side, the PATCH handler only persists credentials when `credentials.token` is a non-empty string (`src/transport/web/routes/channels.ts`: `const draftToken = body.credentials?.token; ... patch.credentials = { token: ... }`), but the wechat/lark/dingtalk field sets here contain no `token` key — so `patch.credentials` is never set, `channels.update` applies nothing, and the route still returns `{ channel }` with no `error`. Th

## [HIGH] src/transport/dingtalk/index.ts:183
The `?? lastSender` fallback delivers any card whose session has no bound DingTalk sender to whichever user happened to message the bot last. This is not a rare path: proactive cards (session-finished/test-failure notifications) and outputs of sessions initiated from the web panel or scheduler are never bound via the `user:${messageId}` echo, so they all go to `lastSender` — i.e., one user's session content (assistant replies, error text, tool output summaries) is silently pushed to a different 

## [HIGH] src/cli/service.ts:309
The stop command's port-level fallback conflates 'port is free' with 'port is owned but pid unknown'. On non-Linux hosts (or Linux without `ss`) — exactly the platforms this refactor targets — `portOwner` returns `{ pid: null }` for an owned port, so this branch prints the false message "not running (nothing on port X)", deletes the pid file, and returns without stopping anything. When the supervisor pid file is missing (crashed supervisor) the server is left orphaned while the operator is told 

## Medium（修 20 条，摘要）
[M] desktop/main.js:19 — PANEL_PORT is declared but never used, and the real gap behind it: PANEL_URL's default hardcodes port 4099 while ignoring OCRC_WEB_PORT — the canonical port env var honored by the daemon (.env.example

[M] desktop/main.js:98 — With the default OCRC_WORK_DIR = null (nothing in the repo ever sets it, so the spawn branch is effectively unreachable), a cold launch with the panel down shows no window and no tray for up to 60s (O

[M] desktop/shell-health.ts:1 — This module is consumed only by tests/desktop/shell-health.test.ts; desktop/main.js never imports it and re-implements the poll loop inline with already-divergent behavior (single attempt, fixed 500ms

[M] src/transport/web/routes/channels.ts:106 — The Telegram-only getMe validation is applied to any channel id, not just the telegram binding. The channels store now carries wechat-default/lark-default/dingtalk-default bindings (wechat credentials

[M] src/transport/web/routes/channels.ts:103 — body.enabled is copied into the patch without a type check, unlike replyGranularity and workspaces which are validated above. Since it comes from an unvalidated JSON body, a malformed value like the s

[M] web/src/lib/components/SessionList.svelte:244 — The search box is only rendered when `!showArchived`, but `archivedRows` is derived from `searched`, which still applies `query`. A query typed in the normal view therefore silently filters the archiv

[M] web/src/lib/components/AgentPanel.svelte:118 — The 60s poll runs unconditionally: every error is swallowed (including 401s), so a logged-out or erroring backend generates endless failed requests forever; and because visibility is only checked insi

[M] src/transport/dingtalk/index.ts:138 — Inbound robot messages are accepted from any `senderStaffId` with no allowlist: any coworker who can reach the app can drive the agent (invoke tools, read session output, trigger notifications) — a ma

[M] src/transport/dingtalk/index.ts:142 — `senderByMessageId` gets an entry for every inbound robot message and is never evicted (no delete on bind, no TTL, no cap). In a long-running enterprise bot this map grows without bound and leaks memo

[M] src/transport/lark/index.ts:174 — If `sendCard` resolves with an empty message_id (create response missing `data.message_id`), the streaming slot keeps `messageId: ''`, every streaming patch is dropped by the `!existing.messageId` gua

[M] src/transport/dingtalk/index.ts:107 — A fresh `DWClient` is constructed on every `getAccessToken()` call, defeating the SDK's per-instance token cache the comment itself mentions. Since the cardBus subscriber calls `rest()` + `getAccessTo

[M] src/core/remote-host.ts:610 — syncConfig ships the local opencode config (opencode.json can embed provider API keys / MCP credentials) over an SSH connection with host-key verification disabled. This mirrors buildSshArgs' existing

[M] src/cli/service.ts:94 — The active bind probe has two edge cases: (1) during waitPort's 500ms polling while a child is starting, this probe can hold 127.0.0.1:port at the exact moment the spawned server tries to bind, handin

[M] src/cli/service.ts:247 — `existing` is now the `{ pid }` wrapper object, so this unchanged log line prints 'already running (pid [object Object], port …)'. Every other call site was migrated (stop/status use `?.pid ?? null`, 

[M] src/core/remotes.ts:70 — Redaction silently fails open: an unparseable proxy string is returned completely unredacted, so a credential-bearing value with odd syntax flows raw to the panel/API. Note the sibling hole too — a sc

[M] src/transport/telegram/streaming-render.ts:220 — This direct fallback bypasses the ResponseStreamer's plainOnly degradation. deliverPart deliberately THROWS on native failure, and renderTelegramParts always produces blocks-bearing parts, so any tran

[M] desktop/main.js:66 — win.loadURL(PANEL_URL) returns a promise that is never caught. If the daemon dies (or the port is stolen) between ensureDaemon() succeeding and the load completing, the main process gets an unhandled 

[M] desktop/main.js:69 — `quitting` is only ever set by the tray 退出 item, so any other quit path (the default menu's Exit accelerator — still reachable via Alt despite autoHideMenuBar — OS logout, or any future app.quit() cal

[M] web/src/lib/components/inspector/RemotesPanel.svelte:108 — `wizRun` is only incremented inside `runConnect`, so closing a「后台继续」session and reopening the wizard does NOT invalidate the in-flight run: the stale run's `run !== wizRun` guards still pass against t

[M] web/src/lib/components/inspector/RemotesPanel.svelte:156 — Every retry duplicates the host row: the server's POST /api/remotes calls `remotes.upsert(...)`, and `upsert` generates a brand-new id (`remote-${Date.now()...}`) when `id` is absent — so after a fail

[M] web/src/lib/components/inspector/RemotesPanel.svelte:163 — The new enterprise proxy fields are silently discarded on the wizard's primary path. Cross-file check: the server's `createRemotesStore.upsert` insert path builds `fresh` from an explicit field list (

[M] web/src/lib/nav/railModel.ts:13 — `remoteHostOf` assumes the `remote:` segment is a host, but the backend id is `remote:${r.id}` (src/plugin/entry.ts) where `RemoteHost.id` is an opaque generated key (`remote-${Date.now().toString(36)

[M] src/cli/service.ts:336 — Same conflation as the stop path: when the port is owned but the pid can't be read (non-Linux / no `ss`), `portPid` is null and status reports `DOWN` even though `portOwner` just determined the port i

[M] src/transport/telegram/tool-stream-bridge.ts:53 — The bridge's sendText/editText call the Telegram API without any timeout guard. streaming-render.ts deliberately wraps every grammy call in a 15s withTimeout because "TG API calls must never hang the 

[M] web/src/lib/components/inspector/RemotesPanel.svelte:133 — The wizard's async flows are never cancelled when the component is destroyed. RemotesPanel is conditionally rendered (Inspector.svelte mounts it under `{#if activeTab?.homeId === 'remotes'}`), and `us