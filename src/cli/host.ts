/**
 * Standalone host — runs OCRC against a spawned ACP agent (kimi/gemini/…) with NO
 * opencode. This is the parallel composition root to src/plugin/entry.ts: same
 * relay + Telegram + Web transports, but the backend is an AcpBackend and events
 * arrive via `backend.onEvent` (the backend owns its stream) instead of the
 * opencode plugin `event` hook. See docs/ACP_BACKEND_DESIGN.md (Phase 2).
 *
 * Launch:  ocrc host        (reads .env: TELEGRAM_BOT_TOKEN, ALLOWED_USER_IDS,
 *                            WEB_*, OCRC_ACP_CMD="kimi acp", …)
 */
import { loadPluginConfig } from '../plugin/config.js'
import { createFileBackedState } from '../core/state.js'
import { createCardBus } from '../core/card-bus.js'
import { createRelay } from '../core/relay.js'
import { startPushNotifications } from '../core/push.js'
import { createScheduler } from '../core/scheduler.js'
import { createChannelsStore } from '../core/channels.js'
import { createRemotesStore } from '../core/remotes.js'
import { createSharesStore } from '../core/shares.js'
import { createRemoteHostManager } from '../core/remote-host.js'
import { createPairingStore } from '../connectivity/pairing.js'
import { loadOrCreateToken } from '../connectivity/auth/token.js'
import type { AcpPermissionRequest } from '../core/agent/acp-backend.js'
import { createBackendRegistry } from '../core/agent/registry.js'
import { createAcpStore } from '../core/agent/acp-store.js'
import { buildHostBackends, parseBackendsSpec } from './host-backends.js'
import { dirname, join } from 'node:path'
import type { OcEvent } from '../core/opencode-events.js'
// (AgentEvent wiring now lives in host-backends.ts)
import { createTelegramTransport } from '../transport/telegram/index.js'
import { createWebTransport } from '../transport/web/index.js'
import { createOffPeakManager } from '../core/offpeak.js'
import { createGoalManager, type GoalManager } from '../core/goal.js'
import { selectAuthStrategy } from '../connectivity/auth/select.js'
import type { Transport } from '../transport/interface.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('acp-host')

export async function main(): Promise<void> {
  // Identity of this process, reported via /api/version and `ocrc status`:
  // the standalone host owns web/TG itself; the plugin entry sets 'plugin'.
  process.env.OCRC_MODE = 'host'
  // Keep the long-lived services alive through stray rejections (mirrors entry.ts).
  process.on('unhandledRejection', (r) => log.warn(`unhandledRejection absorbed: ${(r as Error)?.stack ?? String(r)}`))
  process.on('uncaughtException', (e) => log.warn(`uncaughtException absorbed: ${e?.stack ?? String(e)}`))

  const config = loadPluginConfig(undefined, { requireTelegram: false })
  const specs = parseBackendsSpec(config.backends, config.acpCommand)
  const telegramEnabled = !!config.telegramBotToken
  if (!telegramEnabled && !config.webEnabled) {
    throw new Error('ACP host: nothing to serve — set TELEGRAM_BOT_TOKEN and/or WEB_ENABLED=true')
  }
  log.info(`standalone host starting — backends=[${specs.map((s) => s.id).join(', ')}], telegram=${telegramEnabled}, web=${config.webEnabled}, port=${config.webPort}`)

  const state = createFileBackedState(config.statePath)
  const cardBus = createCardBus()

  // Late-bound so the permission bridge below can reach the Telegram transport
  // (which itself needs `backend`, which needs `onPermission` — a construction cycle).
  // Undefined in web-only mode (no Telegram token).
  let tgTransport: ReturnType<typeof createTelegramTransport> | undefined

  // ACP permission bridge → the SAME approve/deny UX as opencode permissions.
  // `handlePluginPermissionEvent` sends the Telegram inline buttons AND publishes
  // the Web approval card; both surfaces route the user's decision to
  // `backend.resolvePermission(sessionId, toolCallId, decision)`, which the
  // AcpBackend maps to the ACP optionId. We surface the request, then wait for
  // that decision — with a timeout so an unanswered prompt cancels the tool call
  // instead of hanging the turn.
  //
  // OCRC_ACP_AUTO_APPROVE=true bypasses the prompt and approves once (unattended
  // use). Default is interactive approval.
  const autoApprove = process.env.OCRC_ACP_AUTO_APPROVE === 'true'
  const onPermission = async (req: AcpPermissionRequest): Promise<string | null> => {
    if (autoApprove) {
      const allow = req.options.find((o) => o.kind === 'allow_once') ?? req.options.find((o) => o.kind?.startsWith('allow'))
      log.warn(`auto-approving permission: ${req.title}`)
      return allow?.optionId ?? req.options[0]?.optionId ?? null
    }
    // Surface the request. With Telegram, handlePluginPermissionEvent sends the
    // inline buttons AND publishes the Web approval card; web-only mode publishes
    // the card directly. Either way the user's decision routes to resolvePermission.
    if (tgTransport) {
      tgTransport
        .handlePluginPermissionEvent({
          type: 'permission.asked',
          properties: { id: req.requestId, sessionID: req.sessionId, title: req.title },
        })
        .catch((err: unknown) => log.error('failed to surface permission', err as Error))
    } else {
      cardBus.publish({ kind: 'approval', sessionId: req.sessionId, title: req.title, args: { options: req.options }, requestId: req.requestId })
    }
    // Resolution arrives out-of-band via backend.resolvePermission (Telegram
    // button callback / Web POST /api/approval). Here we only enforce a timeout.
    return new Promise<string | null>((resolve) => {
      setTimeout(() => resolve(null), config.chatTimeoutMs)
    })
  }

  // Persistent ACP session+history store (next to the state file) so kimi
  // sessions survive restarts and reopen with their history, like opencode.
  const acpStore = createAcpStore(join(dirname(config.statePath), 'acp-sessions.json'))
  const dataDir = dirname(config.statePath)
  const remotesStore = createRemotesStore(join(dataDir, 'remotes.json'))
  const sharesStore = createSharesStore(dataDir)
  const statusSink: { broadcast?: (frame: { sessionId: string; busy: boolean }) => void } = {}
  // sdelta side channel (0.25.0): relay → WS hub。plugin entry 同款接线——
  // web transport 启动时绑定 broadcast；web 关闭时 delta 在此丢弃。
  const streamDeltaSink: { broadcast?: (frame: import('../core/structured-card.js').StreamDeltaFrame) => void } = {}
  // N12 goal push channel: goal manager → WS hub (`goal` frames). Bound when the
  // web transport starts, like streamDeltaSink; a TG-only host simply drops them.
  const goalSink: { broadcast?: (frame: { sessionId: string; goal: import('../core/state.js').GoalRecord | undefined; verifying: boolean }) => void } = {}
  const remoteManager = createRemoteHostManager({ store: remotesStore })

  // Build every backend (spawning opencode server(s) + ACP agents) and wire each
  // one's event source to the relay below. The spawned server's port comes from
  // OCRC_SERVER_PORT (default 4096) and its probe must SKIP the web port — the
  // probe used to walk into :4099 when 4096/4097 were busy, grab it, and the
  // web transport then died on EADDRINUSE against our own child.
  const built = await buildHostBackends(specs, {
    cwd: process.cwd(),
    onAcpPermission: onPermission,
    store: acpStore,
    opencodePort: config.serverPort,
    skipPorts: [config.webPort],
    serverUrl: config.serverUrl || undefined,
    remotesStore,
    remoteManager,
    statusSink,
    state,
    onRegister: (entry) => registryRef?.registerBackend(entry),
  })
  let registryRef: ReturnType<typeof createBackendRegistry> | undefined
  const registry = createBackendRegistry({
    backends: built.backends,
    state,
    primaryId: built.backends.find((b) => b.id === 'opencode')?.id,
  })
  registryRef = registry
  // Boot-time: bring every enabled remote's tunnel up (was missing on the
  // host topology — plugin entry had ensureAll, host didn't).
  void remoteManager.ensureAll()

  const relay = createRelay({
    cardBus,
    registry,
    state,
    chatTimeoutMs: config.chatTimeoutMs,
    tuiVisible: false, // no local TUI in standalone mode
    onStreamDelta: (frame) => streamDeltaSink.broadcast?.(frame),
    // N12: turn end → goal loop. goalManager is assigned just below (the loop
    // needs the relay as its dispatch target, so the two are mutually
    // referential); this closure reads it lazily.
    onTurnEnd: (sid) => { void goalManager?.handleTurnEnd(sid) },
  })
  // N12 goal loop: verifier + continuation live host-side (the engine has no
  // goal concept). Built after the relay so dispatch can target it; cold
  // recovery runs immediately (active goals → paused, never auto-resumed).
  let goalManager: GoalManager | undefined
  goalManager = createGoalManager({
    state,
    registry,
    dispatch: async (msg) => { await relay(msg) },
    cardBus,
    onGoalChanged: (sessionId, goal, verifying) => goalSink.broadcast?.({ sessionId, goal, verifying }),
    isPlanMode: () => state.getNextAgent() === 'plan',
  })
  goalManager.recoverOnStart()

  // Persist finalized conversation cards for ACP sessions (recordCard no-ops for
  // opencode sessions, which aren't in the store) so they reopen with history.
  cardBus.subscribeAll((card) => {
    if ((card.kind === 'user' || card.kind === 'assistant') && 'sessionId' in card && card.sessionId) {
      acpStore.recordCard(card.sessionId, card, Date.now())
    }
    // M9 error latch: an error card marks the session failed in the sidebar;
    // the next user card (a fresh turn) clears it.
    if ('sessionId' in card && card.sessionId) {
      if (card.kind === 'error') state.setSessionError(card.sessionId, true)
      else if (card.kind === 'user') state.setSessionError(card.sessionId, false)
    }
  })

  // push needs a backend for the finish-summary history read; the primary backend
  // is a best-effort source (wrong-backend reads for other sessions degrade to no
  // summary, which the caller tolerates).
  const push = startPushNotifications({ cardBus, backend: registry.get(registry.primaryId())!, state })

  // Feature parity with plugin mode (2026-10-05): schedules, channel settings,
  // pairing and remote hosts are wired into the web surface exactly like the
  // plugin mode's entry does.
  const scheduler = createScheduler({
    path: join(dataDir, 'schedules.json'),
    dispatch: async (msg) => { await relay(msg) },
    // M8 cron 先订阅防漏推: buffer a status anchor BEFORE the turn starts —
    // fast runs always have a seq-cursor for the result push/panel.
    preDispatch: (msg) => {
      if (!msg.sessionId) return
      cardBus.publish({ kind: 'status', sessionId: msg.sessionId, fields: { 自动化: '已触发（定时任务）' } })
    },
  })
  scheduler.start()
  // N5 裁决③：闲时任务 = ZCode off-peak 取号语义（一次性工单，非 cron）。
  // 派发复用 registry 建会话 + relay 发消息；模型选择经 state.setNextModel 在
  // 派发前应到引擎（单并发 FIFO 下安全）；完成检测用 state 会话忙碌位。
  const offpeakWindow = (() => {
    const raw = process.env.OCRC_OFFPEAK_WINDOW ?? '00:00-08:00'
    const m = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec(raw.trim())
    return m ? { start: `${m[1]}:${m[2]}`, end: `${m[3]}:${m[4]}` } : { start: '00:00', end: '08:00' }
  })()
  const offpeak = createOffPeakManager({
    path: join(dataDir, 'offpeak.json'),
    window: offpeakWindow,
    createSession: async (directory, title) => {
      const backend = registry.active()
      const { id } = await backend.createSession({ directory: directory ?? '', title })
      registry.tag(id, backend.id)
      return id
    },
    sendMessage: async (sessionId, text) => {
      await relay({
        userId: 'offpeak',
        chatId: 'offpeak',
        text,
        messageId: `offpeak_${Date.now()}`,
        sessionId,
        origin: 'scheduler',
      })
    },
    applyModelSelection: (m) => state.setNextModel(m),
    applyApprovalPolicy: (sessionId, policy) => state.setSessionApprovalPolicy(sessionId, policy),
    isSessionBusy: (id) => state.hasActiveGeneration(id) || state.isSessionBusy(id),
  })
  offpeak.start()
  const channels = createChannelsStore(join(dataDir, 'channels.json'))
  const pairing = createPairingStore(() => loadOrCreateToken({ token: config.webToken }))

  // opencode permission events arrive on the SSE stream → forward to the same
  // approval UX (Telegram buttons + Web card). Web-only: publish the card directly.
  const onOpencodePermission = (ev: OcEvent) => {
    const p = (ev as any).properties ?? {}
    // 0.27 权限四档: session-level host approval routing (PRODUCT.md). 'edit'
    // auto-approves edit-class requests, 'yolo' approves everything — the
    // request never becomes an approval card; a status line keeps it auditable.
    // plan/build stay native engine modes.
    if (ev.type === 'permission.asked' && p.id && p.sessionID) {
      const policy = state.getSessionApprovalPolicy(p.sessionID)
      const permType = String(p.type ?? p.args?.type ?? '').toLowerCase()
      const editClass = /edit|write|patch|multiedit/.test(permType) || /edit|write|patch/i.test(String(p.title ?? ''))
      if (policy === 'yolo' || (policy === 'edit' && editClass)) {
        const backend = registry.forSession?.(p.sessionID)
        void (backend as { resolvePermission?: (id: string, requestId: string, d: 'once' | 'always' | 'reject') => Promise<void> } | undefined)
          ?.resolvePermission?.(p.sessionID, p.id, 'once')
          .then(() => cardBus.publish({ kind: 'status', sessionId: p.sessionID, fields: { 自动放行: `${p.title ?? (permType || 'permission')}（${policy} 策略）` } }))
          .catch((err: unknown) => log.warn('auto-approve failed; surfacing card', (err as Error).message))
        if (tgTransport) {
          tgTransport.handlePluginPermissionEvent({ type: ev.type!, properties: p })
            .catch((err: unknown) => log.error('opencode permission surface failed', err as Error))
        }
        return
      }
    }
    if (tgTransport) {
      tgTransport.handlePluginPermissionEvent({ type: ev.type!, properties: (ev as any).properties })
        .catch((err: unknown) => log.error('opencode permission surface failed', err as Error))
    } else {
      if (ev.type === 'permission.asked' && p.id && p.sessionID) {
        cardBus.publish({ kind: 'approval', sessionId: p.sessionID, title: p.title ?? 'Permission', args: p.args ?? {}, requestId: p.id })
      }
    }
  }
  const wireHandle = built.wire(relay, push, onOpencodePermission)

  const transports: Transport[] = []
  if (telegramEnabled) {
    // Panel credential wins at boot (parity with the plugin entry): a `proxy`
    // saved in the 机器人管理 panel overrides the env fallback.
    const panelProxy = channels.get('tg-default')?.credentials?.proxy || undefined
    tgTransport = createTelegramTransport({
      token: config.telegramBotToken,
      allowedUserIds: config.allowedUserIds,
      proxy: panelProxy,
      // Telegram is single-backend for now (piece 6 migrates it to the registry):
      // it drives the primary backend / pinned session.
      backend: registry.get(registry.primaryId())!,
      state,
      baseUrl: '',
      tgChunkSoftLimit: config.tgChunkSoftLimit,
    })
    tgTransport.onMessage(relay)
    transports.push(tgTransport)
  }

  if (config.webEnabled) {
    const auth = selectAuthStrategy({
      mode: config.webAuth,
      token: config.webToken,
      devEmail: config.webCfAccessDevEmail,
      devBypass: config.webCfAccessDevBypass,
      host: config.webHost,
      cfAccess: {
        team: config.webCfAccessTeam,
        aud: config.webCfAccessAud,
        devBypass: config.webCfAccessDevBypass,
        devEmail: config.webCfAccessDevEmail,
        host: config.webHost,
      },
    })
    const webTransport = createWebTransport({
      host: config.webHost,
      port: config.webPort,
      registry,
      auth,
      staticRoot: config.webStaticRoot,
      nextStaticRoot: config.webNextStaticRoot,
      scheduler,
      channels,
      pairing,
      streamDeltaSink,
      remotes: remotesStore,
      offpeak,
      offpeakWindow,
      remoteManager,
      onRemoteEnabled: (r) => wireHandle.registerRemoteBackend(r),
      settingsConfigDir: process.env.OPENCODE_CONFIG_DIR ?? join(process.env.HOME ?? '', '.config', 'opencode'),
      statePath: config.statePath,
      shares: sharesStore,
      telegramStatus: () => tgTransport?.status?.() ?? null,
      telegramMeta: {
        hasEnvToken: !!config.telegramBotToken,
        allowUsers: config.allowedUserIds.length,
        envTokenHint: config.telegramBotToken ? `••••${config.telegramBotToken.slice(-4)}` : undefined,
      },
    })
    webTransport.onMessage(relay)
    transports.push(webTransport)
  }

  await Promise.all(transports.map((t) => t.start({ cardBus, state })))
  log.info(`${transports.length} transport(s) started; backends=[${registry.list().map((b) => b.id).join(', ')}]`)

  const dispose = async () => {
    log.info('shutting down…')
    scheduler.stop()
    // N12: stop the goal loop before the transports go away — without this a
    // verifier/continuation could dispatch into a torn-down relay (the offpeak
    // manager shipped without its stop() and this is the same trap).
    goalManager?.stop()
    offpeak.stop()
    remoteManager.dispose()
    void wireHandle.dispose()
    push.stop()
    await void wireHandle.dispose()
    await Promise.allSettled(transports.map((t) => t.stop()))
    // Flush debounced writes (100ms debounce would otherwise be lost on exit).
    try { await state.flush() } catch { /* best effort */ }
    try { await acpStore.flush() } catch { /* best effort */ }
    process.exit(0)
  }
  process.on('SIGINT', dispose)
  process.on('SIGTERM', dispose)
}
