import { tool } from '@opencode-ai/plugin'
import type { Plugin } from '@opencode-ai/plugin'
import { loadPluginConfig } from './config.js'
import { createTelegramTransport, type TelegramTransport } from '../transport/telegram/index.js'
import { createWebTransport } from '../transport/web/index.js'
import { selectAuthStrategy } from '../connectivity/auth/select.js'
import { createFileBackedState } from '../core/state.js'
import { createRelay } from '../core/relay.js'
import { createBackendRegistry } from '../core/agent/registry.js'
import { normalizeOpencodeEvent } from '../core/agent/opencode-normalizer.js'
import { createCardBus } from '../core/card-bus.js'
import { startPushNotifications } from '../core/push.js'
import { tryBecomePrimary, type PrimaryLock } from '../core/primary-election.js'
import type { OcEvent } from '../core/opencode-events.js'
import type { Transport } from '../transport/interface.js'
import { createLogger } from '../utils/logger.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createV1ControlPlane, createV2ControlPlane, type ControlPlane } from './control-plane.js'
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
    const registry = createBackendRegistry({ backends: [{ id: backend.id, backend }], state })

    const relay = createRelay({
      cardBus,
      registry,
      state,
      chatTimeoutMs: config.chatTimeoutMs,
      tuiVisible: config.tuiVisible,
    })

    const tgTransport = createTelegramTransport({
      token: config.telegramBotToken,
      allowedUserIds: config.allowedUserIds,
      backend,
      state,
      baseUrl: plane.serverUrl,
      tgChunkSoftLimit: config.tgChunkSoftLimit,
    })

    const transports: Transport[] = [tgTransport]
    tgTransport.onMessage(relay)

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
          tgTransport.handlePluginPermissionEvent({ type: eventType, properties: (ev as any).properties } as any).catch((err) =>
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
        case 'session.error':
        case 'session.created':
        case 'session.updated':
        case 'session.status':
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
        stopEvents()
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
 *  - V1 hosts call the default export as a function (classic plugin contract,
 *    works through the install bridge) — `remoteControlPlugin` IS that function.
 *  - V2 hosts read the default export's `setup` member.
 * A function with attached members satisfies both: callable for V1, member-
 * addressable for V2. (The upstream migration doc also accepts a plain object
 * `{id, server, setup}` on V1 ≥1.18.29; the callable form additionally keeps
 * pre-1.18.29 V1 hosts and the install bridge working.)
 * See docs/v2-api-notes.md §1 for the official dual-host statement.
 */
const dualEntry = remoteControlPlugin as unknown as typeof remoteControlPlugin & {
  id: string
  setup: typeof v2Setup
}
dualEntry.id = PLUGIN_ID
dualEntry.setup = v2Setup
export default dualEntry
