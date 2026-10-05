import { tool } from '@opencode-ai/plugin'
import type { Plugin } from '@opencode-ai/plugin'
import { loadPluginConfig } from './config.js'
import { createTelegramTransport, type TelegramTransport } from '../transport/telegram/index.js'
import { createWebTransport } from '../transport/web/index.js'
import { selectAuthStrategy } from '../connectivity/auth/select.js'
import { createFileBackedState } from '../core/state.js'
import { createRelay } from '../core/relay.js'
import { createBackendRegistry, type RegisteredBackend } from '../core/agent/registry.js'
import { createOpencodeClient } from '@opencode-ai/sdk'
import { normalizeOpencodeEvent } from '../core/agent/opencode-normalizer.js'
import { createCardBus } from '../core/card-bus.js'
import { startPushNotifications } from '../core/push.js'
import { tryBecomePrimary, type PrimaryLock } from '../core/primary-election.js'
import { createScheduler } from '../core/scheduler.js'
import { createChannelsStore } from '../core/channels.js'
import { createPairingStore } from '../connectivity/pairing.js'
import { createRemotesStore } from '../core/remotes.js'
import { createRemoteHostManager } from '../core/remote-host.js'
import { startRemoteEvents, type RemoteEventsHandle } from '../core/remote-events.js'
import { buildBasicHeaders } from '../utils/oc-server-auth.js'
import { loadOrCreateToken } from '../connectivity/auth/token.js'
import type { OcEvent } from '../core/opencode-events.js'
import type { Transport } from '../transport/interface.js'
import { createLogger } from '../utils/logger.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createV1ControlPlane, createV2ControlPlane, type ControlPlane } from './control-plane.js'
import { createOpencodeBackend } from '../core/agent/opencode-backend.js'
import type { V2Context } from './v2/types.js'

// Read from package.json at runtime (tsc emits unbundled JS, so ../../package.json
// resolves from both src/plugin and dist/plugin) — never hardcode a version here.
const VERSION = (() => {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '../../package.json')
    return (JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string }).version
  } catch {
    return 'unknown'
  }
})()
const log = createLogger('plugin')

// opencode 1.17 runs plugins in a worker thread. Any unhandled rejection or
// uncaught exception in our long-lived services (web server, telegram polling,
// timers) would otherwise crash that worker — opencode reports "Worker has been
// terminated", the web transport dies (→ 502 at the tunnel), and opencode's own
// session reads start failing. Absorb them here: log and keep the worker alive.
// We deliberately NEVER call process.exit (opencode issue #27557: plugins that
// exit on rejection take the host down with them).
let guardsInstalled = false
function installProcessGuards() {
  if (guardsInstalled) return
  guardsInstalled = true
  process.on('unhandledRejection', (reason) => {
    log.warn(`unhandledRejection absorbed: ${(reason as Error)?.stack ?? String(reason)}`)
  })
  process.on('uncaughtException', (err) => {
    log.warn(`uncaughtException absorbed: ${err?.stack ?? String(err)}`)
  })
}

export const PLUGIN_ID = 'ocrc'

/**
 * Dual-export (development plan §7.1/§7.2, officially sanctioned upstream):
 * V1 hosts invoke `server` (the classic plugin function); V2 hosts invoke
 * `setup`. Both funnel into startCore() — the host-agnostic core (state,
 * CardBus, relay, transports, push) is shared; only the ControlPlane adapter
 * differs.
 */
const v2Setup = async (ctx: V2Context, options?: Record<string, unknown>) => {
  installProcessGuards()
  process.env.OCRC_MODE = 'plugin'
  log.info(`v${VERSION} starting (V2 setup)`)

  // Transient-process gate (V2): `opencode run` is a one-shot client that also
  // loads plugins. Letting it host transports means a TG poller / web server
  // that die when the run exits — flapping the bot and 409-conflicting with
  // the resident service's poller. There is no ctx marker distinguishing
  // serve from run (both report app.channel="latest", app.name="cli" —
  // verified on 2.0.15), so gate on the CLI subcommand instead. Long-lived
  // processes (serve, TUI, service) proceed to the election; only the run
  // one-shot stands down. Revisit if V2 ships a proper role marker.
  const subcommand = process.argv[2]
  if (subcommand === 'run') {
    log.info('transient V2 run process — transports owned by the resident service; standing down')
    return async () => {}
  }

  const config = loadPluginConfig(options ?? ctx.options)
  const primary = tryBecomePrimary()
  if (!primary.isPrimary) {
    log.info('PASSIVE instance — web/bot/events owned by another opencode instance; standing down')
    return () => primary.release()
  }

  const plane = createV2ControlPlane(ctx)
  const hooks = await startCore(plane, config, primary)
  // V2's setup contract returns a cleanup function.
  return () => hooks.dispose()
}

export const remoteControlPlugin: Plugin = (async (ctx, options) => {
  installProcessGuards()
  // Identity of this process, reported via /api/version and `ocrc status`
  // (the standalone host entry sets 'host' the same way).
  process.env.OCRC_MODE = 'plugin'
  // Dual-load guard: hosts that support both entry styles may invoke `server`
  // with a V2-shaped context (no SDK client, event.subscribe iterator). Such a
  // call can only mean a V2 host — delegate to the V2 path instead of crashing
  // on missing ctx.serverUrl/client.
  const anyCtx = ctx as any
  if (anyCtx && typeof anyCtx === 'object' && !anyCtx.client && typeof anyCtx.event?.subscribe === 'function') {
    log.info('V2-shaped context on the V1 entry — delegating to setup path')
    return v2Setup(anyCtx as V2Context, options ?? anyCtx.options)
  }
  log.info(`v${VERSION} starting`)

  const config = loadPluginConfig(options)
  const primary = tryBecomePrimary()
  if (!primary.isPrimary) {
    log.info('PASSIVE instance — web/bot/events owned by another opencode instance; standing down')
    return {
      // Minimal inert hooks: do nothing, so this workspace's plugin never
      // competes for the web port or the Telegram bot. The PRIMARY instance's
      // global event stream already covers this workspace.
      event: async () => { /* no-op (PASSIVE) */ },
      dispose: async () => { primary.release() },
    }
  }

  const plane = createV1ControlPlane(ctx as any)
  return startCore(plane, config, primary)
}) as Plugin

/**
 * Host-agnostic core startup. Everything below is shared between V1 and V2
 * hosts; every host-specific access goes through the ControlPlane.
 */
async function startCore(plane: ControlPlane, config: ReturnType<typeof loadPluginConfig>, primary: PrimaryLock) {
  log.info(`transport=${config.transport}, web=${config.webEnabled}, port=${config.webPort}, baseUrl=${plane.serverUrl ?? '(in-process)'}`)

  try {
    const state = createFileBackedState(config.statePath)
    const cardBus = createCardBus()

    const backend = plane.backend
    // The opencode plugin serves a single backend; wrap it so the relay's
    // per-session routing has a registry to resolve against.
    // 0.26.0 SSH remote hosts: one `remote:<id>` backend per enabled host.
    // Local ports are RESERVED at boot so the SDK clients can be built before
    // any tunnel exists — backends ping false (offline in the panel) until the
    // manager's ssh process comes up and the serve answers through it.
    const ocrcDir = config.statePath.replace(/[^/]+$/, '')
    const remotesStore = createRemotesStore(`${ocrcDir}remotes.json`)
    const remoteManager = createRemoteHostManager({ store: remotesStore })
    const remotePorts = new Map<string, number>()
    const remoteBackends: RegisteredBackend[] = []
    for (const r of remotesStore.list()) {
      if (!r.enabled) continue
      try {
        const localPort = await remoteManager.assignPort(r.id)
        remotePorts.set(r.id, localPort)
        const headers = buildBasicHeaders('opencode', r.serverPassword)
        const base = `http://127.0.0.1:${localPort}`
        remoteBackends.push({
          id: `remote:${r.id}`,
          backend: createOpencodeBackend({
            id: `remote:${r.id}`,
            host: r.host,
            remote: true,
            baseUrl: base,
            // Auth rides the SDK's OWN client-level headers (merged into the
            // Request at construction): custom-fetch wrappers proved unreliable
            // inside opencode's embedded runtime (diagnosed live: 401 with the
            // header silently dropped). fetchImpl below still covers the raw
            // paths (string-URL fetch(url, init) is engine-safe).
            client: createOpencodeClient({ baseUrl: base, headers }) as never,
            fetchImpl: (url: string, init?: RequestInit) => fetch(url, { ...init, headers: { ...(init?.headers ?? {}), ...headers } }),
          }),
        })
      } catch (err) {
        log.warn(`remote ${r.id} backend setup failed: ${(err as Error).message}`)
      }
    }

    const registry = createBackendRegistry({ backends: [{ id: backend.id, backend }, ...remoteBackends], state })

    // sdelta side channel (0.25.0): relay → WS hub. The web transport binds the
    // sink when it starts; without web enabled, deltas are simply dropped here.
    const streamDeltaSink: { broadcast?: (frame: import('../core/structured-card.js').StreamDeltaFrame) => void } = {}

    const relay = createRelay({
      cardBus,
      registry,
      state,
      chatTimeoutMs: config.chatTimeoutMs,
      tuiVisible: config.tuiVisible,
      onStreamDelta: (frame) => streamDeltaSink.broadcast?.(frame),
    })

    // P2b-M7: cross-channel scheduled prompts. Due schedules dispatch through
    // the same relay as any message; store persists at ~/.ocrc/schedules.json.
    const scheduler = createScheduler({
      path: `${config.statePath.replace(/[^/]+$/, '')}schedules.json`,
      dispatch: async (msg) => { await relay(msg) },
    })
    scheduler.start()

    // M9: bot-channel settings at ~/.ocrc/channels.json — consumed by the TG
    // transport (reply granularity / workspace scope) and the web channels API.
    const channels = createChannelsStore(`${config.statePath.replace(/[^/]+$/, '')}channels.json`)
    const tgChannel = () => channels.get('tg-default')

    // M9: the channels panel can disable a channel (enabled=false) — the
    // transport is then not created at all (takes effect on restart).
    const tgChannelCfg = channels.get('tg-default')
    // 0.27: the panel's credential field is real — a token saved there wins
    // over config.env at boot (restart-effective, more recent user action).
    // The allowlist got the same treatment: the panel's list (when non-empty)
    // wins over ALLOWED_USER_IDS. Either way the list still gates: with no
    // allowlisted user the bot could only silently drop every message, so it
    // stays down instead.
    const panelToken = tgChannelCfg?.credentials?.token || undefined
    const tgToken = panelToken ?? config.telegramBotToken
    // Proxy follows the same panel-wins-at-boot precedence as the token: a
    // `proxy` credential saved in the 机器人管理 panel overrides config.env.
    const panelProxy = tgChannelCfg?.credentials?.proxy || undefined
    const panelAllowUsers = tgChannelCfg?.allowUsers?.length ? tgChannelCfg.allowUsers : undefined
    const allowedUserIds = panelAllowUsers ?? config.allowedUserIds
    // M12: web-only is a first-class shape — an empty token means the Telegram
    // surface simply doesn't exist (no grammY retry spam); the web panel and
    // its onboarding page carry the product on their own.
    const tgEnabled = (tgChannelCfg?.enabled ?? true) && !!tgToken && allowedUserIds.length > 0

    // M11: pending-token pairing — /pair surfaces (TG + web QR) issue a
    // short-lived single-use token instead of the permanent access token.
    const pairing = createPairingStore(() => loadOrCreateToken({ token: config.webToken }))
    let tgTransport: ReturnType<typeof createTelegramTransport> | undefined
    const transports: Transport[] = []
    if (tgEnabled) {
      tgTransport = createTelegramTransport({
        token: tgToken,
        allowedUserIds,
        proxy: panelProxy,
        backend,
        state,
        baseUrl: plane.serverUrl,
        tgChunkSoftLimit: config.tgChunkSoftLimit,
        scheduler,
        channels: tgChannel,
        pairing,
      })
      transports.push(tgTransport)
      tgTransport.onMessage(relay)
    }

    // 0.27: enterprise channels — Lark / DingTalk / WeCom. Each starts when
    // its channel is enabled AND credentials exist (channels.json panel value
    // wins over the env fallback). See docs/PRODUCT.md enterprise matrix.
    const larkCfg = channels.get('lark-default')
    const larkId = larkCfg?.credentials?.app_id ?? process.env.LARK_APP_ID
    const larkSecret = larkCfg?.credentials?.app_secret ?? process.env.LARK_APP_SECRET
    if (larkCfg?.enabled && larkId && larkSecret) {
      const { createLarkTransport } = await import('../transport/lark/index.js')
      const larkTransport = createLarkTransport({ appId: larkId, appSecret: larkSecret, backend, state })
      transports.push(larkTransport)
      larkTransport.onMessage(relay)
    }
    const dingCfg = channels.get('dingtalk-default')
    const dingId = dingCfg?.credentials?.client_id ?? process.env.DINGTALK_CLIENT_ID
    const dingSecret = dingCfg?.credentials?.client_secret ?? process.env.DINGTALK_CLIENT_SECRET
    if (dingCfg?.enabled && dingId && dingSecret) {
      const { createDingTalkTransport } = await import('../transport/dingtalk/index.js')
      const dingTransport = createDingTalkTransport({ clientId: dingId, clientSecret: dingSecret })
      transports.push(dingTransport)
      dingTransport.onMessage(relay)
    }
    const wecomCfg = channels.get('wechat-default')
    const wecomUrl = wecomCfg?.credentials?.webhook_url ?? process.env.WECOM_WEBHOOK_URL
    if (wecomCfg?.enabled && wecomUrl) {
      const { createWeComTransport } = await import('../transport/wecom/index.js')
      const wecomTransport = createWeComTransport({ webhookUrl: wecomUrl })
      transports.push(wecomTransport)
      // push-only: no inbound (WeCom app callbacks need a public URL)
    }

    let webTransport: ReturnType<typeof createWebTransport> | undefined

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
      webTransport = createWebTransport({
        host: config.webHost,
        port: config.webPort,
        registry,
        auth,
        staticRoot: config.webStaticRoot,
        scheduler,
        channels,
        pairing,
        streamDeltaSink,
        remotes: remotesStore,
        remoteManager,
        telegramStatus: () => tgTransport?.status?.() ?? { connected: false },
        telegramMeta: {
          hasEnvToken: !!config.telegramBotToken,
          allowUsers: config.allowedUserIds.length,
          envTokenHint: config.telegramBotToken ? `••••${config.telegramBotToken.slice(-4)}` : undefined,
        },
        })
      webTransport.onMessage(relay)
      transports.push(webTransport)
    }

    // Start transports in background — bot.launch() blocks on polling and must not hold up plugin init.
    // The event hook must be returned immediately so opencode can dispatch events.
    // Each transport retries independently with exponential backoff (base 1s, cap
    // 30s — same pattern as opencode/global-events.ts), so a boot-time failure
    // (Telegram unreachable, web port briefly taken) recovers instead of leaving
    // the transport permanently dead, and one failing transport never blocks another.
    let shuttingDown = false
    const startTransport = (t: Transport): void => {
      const run = async () => {
        let attempt = 0
        while (!shuttingDown) {
          try {
            await t.start({ cardBus, state })
            log.info(`transport ${t.name} started`)
            return
          } catch (err) {
            if (shuttingDown) return
            const delay = Math.min(1000 * 2 ** attempt, 30000)
            attempt++
            log.warn(`transport ${t.name} start failed (retry ${attempt} in ${delay}ms): ${(err as Error).message}`)
            await new Promise((r) => setTimeout(r, delay))
          }
        }
      }
      void run()
    }
    for (const t of transports) startTransport(t)

    // Push notifications — driven by the plugin event hook
    const push = startPushNotifications({ cardBus, backend, state })

    // Poll the TUI-selected session to keep the current agent in sync.
    // V2 hosts have no TUI navigation — the plane omits getSession there.
    const pollTimer = plane.getSession
      ? setInterval(async () => {
          const sid = state.getTuiSelectedSession()
          if (!sid) return
          try {
            const data = await plane.getSession!(sid)
            if (data?.agent) state.setCurrentAgent(data.agent)
          } catch {
            // best effort
          }
        }, 15000)
      : undefined

    // Unified event dispatch. On V1, driven primarily by the per-instance
    // `event` hook (opencode pushes events — reliable in the worker) and
    // supplemented by the global stream for OTHER workspaces only. On V2,
    // driven entirely by the control plane's mapped event iterator.
    async function dispatchEvent(ev: OcEvent): Promise<void> {
      const eventType = ev.type
      if (!eventType) return

      // Feed all events to push notification engine (fire-and-forget, but never
      // let a rejection escape to the global guard).
      void Promise.resolve(push.handleEvent(ev)).catch((err) =>
        log.warn('push.handleEvent failed', err as Error),
      )

      switch (eventType) {
        case 'permission.asked':
        case 'permission.replied':
        case 'permission.updated':
          tgTransport?.handlePluginPermissionEvent({ type: eventType, properties: (ev as any).properties } as any).catch((err) =>
            log.error('handlePluginPermissionEvent failed', err as Error),
          )
          break
        case 'tui.session.select': {
          const sid = (ev as any)?.properties?.sessionID
          if (typeof sid === 'string' && sid) {
            state.setTuiSelectedSession(sid)
            log.info(`[plugin] TUI session select: ${sid.slice(-8)}`)
          }
          break
        }
        case 'question.asked': {
          const p = (ev as any)?.properties ?? {}
          const sid = typeof p.sessionID === 'string' ? p.sessionID : ''
          const requestId = typeof p.id === 'string' ? p.id : ''
          if (sid && requestId) {
            // Stable id so the resolved republish (below) upserts in place.
            cardBus.publish({
              kind: 'question', sessionId: sid, requestId, id: `question:${requestId}`,
              questions: Array.isArray(p.questions) ? p.questions : [],
            })
          }
          tgTransport?.handlePluginQuestionEvent({ type: eventType, properties: p }).catch((err) =>
            log.error('handlePluginQuestionEvent failed', err as Error),
          )
          break
        }
        case 'question.replied':
        case 'question.rejected': {
          const p = (ev as any)?.properties ?? {}
          const sid = typeof p.sessionID === 'string' ? p.sessionID : ''
          const requestId = typeof p.requestID === 'string' ? p.requestID : ''
          if (sid && requestId) {
            cardBus.publish({
              kind: 'question', sessionId: sid, requestId, id: `question:${requestId}`,
              questions: [],
              resolved: eventType === 'question.replied' ? 'replied' : 'rejected',
              answers: Array.isArray(p.answers) ? p.answers : undefined,
            })
          }
          // External resolution (TUI/other device) — let TG close its wizard.
          tgTransport?.handlePluginQuestionEvent({ type: eventType, properties: p }).catch((err) =>
            log.error('handlePluginQuestionEvent failed', err as Error),
          )
          break
        }
        case 'session.deleted': {
          // Free per-session memory (card buffer, costs, delivery marks, aborts).
          const sid = (ev as any)?.properties?.sessionID ?? (ev as any)?.properties?.info?.id
          if (typeof sid === 'string' && sid) {
            cardBus.drop(sid)
            state.dropSession(sid)
            log.info(`[plugin] session deleted, evicted: ${sid.slice(-8)}`)
          }
          break
        }
        case 'session.idle':
          // Busy tracking feeds the plan-HUD subagent rows (running vs done).
          try {
            const idleSid = (ev as { properties?: { sessionID?: string } }).properties?.sessionID
            if (typeof idleSid === 'string' && idleSid) state.setSessionBusy(idleSid, false)
          } catch { /* best effort */ }
          {
            const ae = normalizeOpencodeEvent(ev)
            if (ae) await relay.handleEvent(ae)
          }
          break
        case 'session.error':
        case 'session.created':
        case 'session.updated':
        case 'session.status':
          try {
            const st = (ev as { properties?: { sessionID?: string; status?: { type?: string } } }).properties
            if (typeof st?.sessionID === 'string' && st.sessionID) {
              state.setSessionBusy(st.sessionID, st.status?.type === 'busy')
            }
          } catch { /* best effort */ }
          {
            const ae = normalizeOpencodeEvent(ev)
            if (ae) await relay.handleEvent(ae)
          }
          break
        case 'message.part.updated':
        case 'message.part.delta':
        case 'message.updated':
        case 'message.part.removed':
        case 'message.removed':
        case 'command.executed':
          try {
            const ae = normalizeOpencodeEvent(ev)
            if (ae) await relay.handleEvent(ae)
          } catch (err) {
            log.error('relay.handleEvent failed', err as Error)
          }
          break
      }
    }

    // Wire the host's event sources through the control plane. V1: global SSE
    // for other workspaces (own-workspace events arrive via the returned hook).
    // V2: the mapped ctx.event.subscribe iterator for ALL workspaces.
    const stopEvents = plane.wireEvents(dispatchEvent)

    // Per-remote event sources feed the same dispatchEvent (streaming, sdelta,
    // push, permissions) — remote turns mirror exactly like locally-adopted ones.
    const remoteEventHandles: RemoteEventsHandle[] = []
    for (const r of remotesStore.list()) {
      const port = remotePorts.get(r.id)
      if (!r.enabled || !port) continue
      remoteEventHandles.push(startRemoteEvents({
        name: r.id,
        url: `http://127.0.0.1:${port}/global/event`,
        headers: buildBasicHeaders('opencode', r.serverPassword),
        dispatch: (payload) => dispatchEvent(payload as OcEvent),
      }))
    }
    remoteManager.ensureAll()

    const v1EventHook = plane.eventHook?.(dispatchEvent)

    return {
      ...(v1EventHook ? { event: v1EventHook } : {}),
      tool: {
        'rc-status': tool({
          description: 'Show ocrc plugin status',
          args: {},
          async execute() {
            const s = push.stats()
            const lines = [
              `ocrc v${VERSION}`,
              `Telegram:   ${tgTransport ? 'active' : 'inactive'}`,
              `Web:        ${config.webEnabled ? `listening :${config.webPort}` : 'disabled'}`,
              `Generating: ${state.hasActiveGeneration() ? 'yes' : 'no'}`,
              `Pushes/hr:  ${s.pushesLastHour}  (tracked sessions: ${s.trackedSessions})`,
            ]
            return lines.join('\n')
          },
        }),
        notify: tool({
          description: 'Send the user a push notification (e.g. when a long task or tests finish).',
          args: { message: tool.schema.string().describe('The notification text to push to the user') },
          async execute(args: { message: string }, context: any) {
            const sid = context?.sessionID || state.getLastSessionId()
            cardBus.publish({
              kind: 'info',
              title: 'Notification',
              sections: [{ body: `🔔 ${args.message}` }],
              ...(sid ? { sessionId: sid } : {}),
            })
            return 'notification sent'
          },
        }),
      },
      dispose: async () => {
        log.info('plugin disposing, stopping transports...')
        shuttingDown = true
        scheduler.stop()
        stopEvents()
        for (const h of remoteEventHandles) h.stop()
        remoteManager.dispose()
        if (pollTimer) clearInterval(pollTimer)
        push.stop()
        await Promise.allSettled(transports.map((t) => t.stop()))
        // Flush debounced state writes (100ms debounce would otherwise be lost on exit).
        try { await state.flush() } catch { /* best effort */ }
        primary.release()
        log.info('plugin disposed')
      },
    }
  } catch (err) {
    primary.release()
    throw err
  }
}

/** Registry wrapper kept out of startCore's flow for readability. */

export { v2Setup as ocrcV2Setup }

/**
 * Dual export:
 *  - The default export is an OBJECT `{id, server, setup}` — that is the shape
 *    opencode's V1 loader accepts (verified against 1.18.34 source,
 *    readV1Plugin: a bare function default throws "must default export an
 *    object with server()", which is exactly how the npm-plugin path failed).
 *  - V2 hosts read `.setup`; V1 hosts call `.server(ctx, options)`.
 *  - The install bridge keeps its own callable wrapper for pre-1.18.29 hosts
 *    and handles the object shape too (it prefers `.server`).
 * See docs/v2-api-notes.md §1 for the official dual-host statement.
 */
export default {
  id: PLUGIN_ID,
  server: remoteControlPlugin,
  setup: v2Setup,
}
