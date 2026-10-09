import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { serve, type ServerType } from '@hono/node-server'
import { WebSocketServer } from 'ws'
import { serveStatic } from '@hono/node-server/serve-static'
import type { BackendRegistry } from '../../core/agent/registry.js'
import type { IncomingMessage, ChannelCapabilities } from '../../core/types.js'
import type { Transport, TransportStartDeps } from '../interface.js'
import type { StreamDeltaFrame, StructuredCard } from '../../core/structured-card.js'
import { buildServer } from './server.js'
import { createWsHub } from './ws-hub.js'
import { createLogger } from '../../utils/logger.js'
import type { AuthStrategy } from '../../connectivity/auth/index.js'
import type { Scheduler } from '../../core/scheduler.js'

const log = createLogger('web')

export interface WebTransportConfig {
  host: string
  port: number
  registry: BackendRegistry
  auth: AuthStrategy
  staticRoot: string
  /** 0.27 migration dual root: web-next (React) build served under /next/
   *  while staticRoot (frozen Svelte shell) stays at '/'. Missing dir = the
   *  mount is skipped entirely — the old shell keeps working unchanged. */
  nextStaticRoot?: string
  /** P2b-M7 cross-channel scheduled prompts (optional). */
  scheduler?: Scheduler
  /** M9 bot-channel settings store + live TG status (optional). */
  channels?: import('../../core/channels.js').ChannelsStore
  telegramStatus?: () => { connected: boolean; username?: string } | null
  /** 0.27: boot facts for the channels 绑定信息 line. */
  telegramMeta?: { hasEnvToken: boolean; allowUsers: number; envTokenHint?: string }
  /** M11 pending-token pairing store (optional). */
  pairing?: import('../../connectivity/pairing.js').PairingStore
  /** sdelta wiring (0.25.0): the host passes a sink object; start() binds it to
   *  the WS hub so relay deltas reach subscribed clients. Mutable slot because
   *  the transport (and its hub) boots after the relay is constructed. */
  streamDeltaSink?: { broadcast?: (frame: StreamDeltaFrame) => void }
  statusSink?: { broadcast?: (frame: { sessionId: string; busy: boolean }) => void }
  /** N12 goal push channel: the host's goal manager publishes here; start()
   *  binds it to the WS hub (`goal` frames). Same mutable-slot reason. */
  goalSink?: { broadcast?: (frame: { sessionId: string; goal: import('../../core/state.js').GoalRecord | undefined; verifying: boolean }) => void }
  /** 0.26.0 remote host management routes. */
  remotes?: import('../../core/remotes.js').RemotesStore
  remoteManager?: import('../../core/remote-host.js').RemoteHostManager
  /** 0.27: runtime remote registration (backend + tunnel + events, no restart). */
  onRemoteEnabled?: (r: import('../../core/remotes.js').RemoteHost) => void
  /** M5 设置域: opencode global config dir (the settings routes read/write it). */
  settingsConfigDir?: string
  /** M5-2: presets/state dir. */
  statePath?: string
  /** M6 分享: snapshot store (public GET + authed create). */
  shares?: import('../../core/shares.js').SharesStore
  /** N5: off-peak 一次性工单管理器（ZCode off-peak 语义，非 cron）。 */
  offpeak?: import('../../core/offpeak.js').OffPeakManager
  offpeakWindow?: import('../../core/offpeak.js').OffPeakWindow
  /** N12 session goals (optional). */
  goalManager?: import('../../core/goal.js').GoalManager
}

const CAPS: ChannelCapabilities = {
  edit: true, maxMessageLength: Number.POSITIVE_INFINITY,
  buttons: true, richText: true, streaming: true,
}

/** index.html 的 mtime 缓存（模块级：每进程一个 web transport）。 */
let indexHtmlCache: { mtimeMs: number; html: string } | null = null
let nextIndexCache: { mtimeMs: number; html: string } | null = null

export function createWebTransport(cfg: WebTransportConfig): Transport {
  let messageHandler: ((msg: IncomingMessage) => Promise<void>) | undefined
  let server: ServerType | undefined
  let wss: WebSocketServer | undefined

  return {
    name: 'web',
    capabilities: CAPS,
    async start(deps: TransportStartDeps) {
      if (!existsSync(cfg.staticRoot)) {
        throw new Error(`Web static root not found: ${cfg.staticRoot}. Run 'cd web && npm run build' first.`)
      }
      const wsHub = createWsHub({ cardBus: deps.cardBus, registry: cfg.registry, state: deps.state })
      if (cfg.streamDeltaSink) cfg.streamDeltaSink.broadcast = (frame) => wsHub.broadcastDelta(frame)
      if (cfg.statusSink) cfg.statusSink.broadcast = (frame) => wsHub.broadcastStatus(frame)
      if (cfg.goalSink) cfg.goalSink.broadcast = (frame) => wsHub.broadcastGoal(frame)
      const app = buildServer({
        auth: cfg.auth,
        registry: cfg.registry,
        state: deps.state,
        cardBus: deps.cardBus,
        onMessage: (msg) => messageHandler ? messageHandler(msg) : Promise.resolve(),
        scheduler: cfg.scheduler,
        channels: cfg.channels,
        telegramStatus: cfg.telegramStatus,
        telegramMeta: cfg.telegramMeta,
        pairing: cfg.pairing,
        remotes: cfg.remotes,
        remoteManager: cfg.remoteManager,
        // 此前这一行缺失：host 传了 onRemoteEnabled，server 也消费它，中间这层却把它
        // 丢了 —— 结果是「面板里启用远端主机 → 隧道起来 → 但后端直到重启才注册」。
        onRemoteEnabled: cfg.onRemoteEnabled,
        settingsConfigDir: cfg.settingsConfigDir,
        statePath: cfg.statePath,
        shares: cfg.shares,
        offpeak: cfg.offpeak,
        offpeakWindow: cfg.offpeakWindow,
        goalManager: cfg.goalManager,
      })

      // Immutable hashed assets cache forever; everything else (above all
      // index.html, which references those hashes) must revalidate on every
      // load — a cached stale index points at deleted hashes and the app
      // half-loads after any redeploy ("every refresh looks different").
      app.use('/_app/immutable/*', async (c, next) => {
        await next()
        c.header('Cache-Control', 'public, max-age=31536000, immutable')
      })
      // index.html — served BOTH as the static file ('/') and by the SPA
      // fallback below — must always revalidate.
      app.use(async (c, next) => {
        await next()
        if (c.req.path === '/' || c.req.path === '/index.html') {
          c.header('Cache-Control', 'no-cache')
        }
      })

      // ── 0.27 dual root: web-next (React) at /next/ ─────────────────────
      // Present-and-optional: when the build dir doesn't exist (fresh clone,
      // npm consumers), none of this mounts and '/' serves exactly as before.
      const nextRoot = cfg.nextStaticRoot
      const hasNext = !!nextRoot && existsSync(nextRoot) && existsSync(join(nextRoot, 'index.html'))
      if (hasNext) {
        // Vite hashed assets (base '/next/' → /next/assets/*) — immutable.
        app.use('/next/assets/*', async (c, next) => {
          await next()
          c.header('Cache-Control', 'public, max-age=31536000, immutable')
        })
        // index.html of the next shell must always revalidate.
        app.use(async (c, next) => {
          await next()
          if (c.req.path === '/next/' || c.req.path === '/next' || c.req.path === '/next/index.html') {
            c.header('Cache-Control', 'no-cache')
          }
        })
        app.get('/next', (c) => c.redirect('/next/'))
        // serveStatic resolves against `root`; strip the mount prefix so
        // /next/assets/x → <nextRoot>/assets/x.
        app.use('/next/*', serveStatic({
          root: nextRoot!,
          rewriteRequestPath: (p) => p.replace(/^\/next/, '') || '/',
        }))
        // SPA fallback inside the next shell — navigation-style paths only,
        // never a missed asset (same rationale as the legacy fallback below).
        // 同一个重建失效问题：/next/* 的 SPA 回落也必须读当前 index。
        const nextIndexPath = join(nextRoot!, 'index.html')
        const readNextIndex = (): string => {
          try {
            const st = statSync(nextIndexPath)
            if (!nextIndexCache || nextIndexCache.mtimeMs !== st.mtimeMs) {
              nextIndexCache = { mtimeMs: st.mtimeMs, html: readFileSync(nextIndexPath, 'utf-8') }
            }
            return nextIndexCache.html
          } catch {
            return nextIndexCache?.html ?? ''
          }
        }
        app.get('/next/*', (c) => c.html(readNextIndex()))
      }

      app.use('/*', serveStatic({ root: cfg.staticRoot }))

      // SPA fallback — SvelteKit static adapter only prerenders index.html;
      // dynamic routes like /[sessionId]/ resolve client-side, so any non-API
      // path that doesn't match a real file must serve index.html.
      // Critical: ONLY fall back navigation-style paths. If a missing asset
      // (e.g. stale /_app/old-hash.js a cached browser still asks for) gets
      // index.html, the browser sees text/html where it expects JS and the
      // whole module graph silently stalls.
      const indexHtmlPath = join(cfg.staticRoot, 'index.html')
      // index.html 必须跟着重建走：此前只在启动时读一次，于是「重建 web 但没重启
      // host」会一直发旧 index——它引用的 chunk 已被新构建的哈希替换，浏览器拿到
      // text/html 当模块脚本（MIME 强校验拒绝执行）→ 整个页面白屏。2026-10-08 实际
      // 踩了两次。按 mtime 失效即可：命中时不碰磁盘，重建后立即生效。
      const readIndexHtml = (): string => {
        try {
          const st = statSync(indexHtmlPath)
          if (!indexHtmlCache || indexHtmlCache.mtimeMs !== st.mtimeMs) {
            indexHtmlCache = { mtimeMs: st.mtimeMs, html: readFileSync(indexHtmlPath, 'utf-8') }
          }
          return indexHtmlCache.html
        } catch {
          return indexHtmlCache?.html ?? ''
        }
      }
      app.get('*', (c) => {
        const path = c.req.path
        if (path.startsWith('/api/') || path === '/ws') return c.notFound()
        return c.html(readIndexHtml())
      })

      // serve() returns immediately and bind errors (EADDRINUSE, EACCES) only
      // surface as an async 'error' event. Await the listening callback so a
      // failed bind REJECTS start() — the entrypoint's transport retry loop
      // (1s→30s backoff) then actually recovers, e.g. when the port is held by
      // a still-shutting-down predecessor. Without this, the error used to end
      // up an uncaughtException that installProcessGuards() swallows, leaving
      // the transport "started" but silently unbound.
      server = await new Promise((resolveBind, rejectBind) => {
        const s = serve({ fetch: app.fetch, hostname: cfg.host, port: cfg.port }, (info) => {
          log.info(`web transport listening on http://${info.address}:${info.port}`)
          resolveBind(s)
        })
        s.once('error', rejectBind)
      })
      // Post-bind late errors: log loudly and keep the transport up. The old
      // `setImmediate(() => { throw err })` was absorbed by the process
      // guards — the web silently died and NOTHING restarted it (production
      // incident 2026-10-05: web served for minutes then 000 with the serve
      // process alive).
      ;(server as any).on('error', (err: Error) => {
        log.error(`web transport error after bind (kept alive): ${err.message}`)
      })

      // Clients only ever send ping/subscribe — cap frames well below the 100MiB
      // default so a rogue client can't exhaust memory.
      wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
      ;(server as any).on('upgrade', async (req: any, socket: any, head: any) => {
        const hasCookie = !!req.headers?.cookie
        const hasAccessHdr = !!req.headers?.['cf-access-jwt-assertion']
        const reqUrl = new URL(req.url, 'http://localhost')
        log.info(`ws upgrade attempt path=${reqUrl.pathname} cookie=${hasCookie} cf-access-hdr=${hasAccessHdr}`)
        if (reqUrl.pathname !== '/ws') {
          log.info(`ws upgrade rejected: wrong path=${reqUrl.pathname}`)
          socket.destroy()
          return
        }
        // Auth: delegate to the configured strategy (token or CF Access). A throw
        // here would otherwise hang the TCP socket and raise unhandledRejection.
        let user
        try {
          user = await cfg.auth.verifyUpgrade(
            { headers: req.headers, url: req.url, socket: req.socket },
          )
        } catch (e) {
          log.warn(`ws upgrade rejected: verifyUpgrade threw: ${(e as Error).message}`)
          socket.destroy()
          return
        }
        if (!user) {
          log.warn(`ws upgrade rejected: JWT verify failed (cookie=${hasCookie} cf-access-hdr=${hasAccessHdr})`)
          socket.destroy()
          return
        }
        const wsUser = { email: user.email ?? user.sub ?? 'user' }
        log.info(`ws upgrade accepted: ${wsUser.email}`)
        wss!.handleUpgrade(req, socket, head, (ws) => {
          log.info(`ws handleUpgrade callback fired, attaching`)
          wsHub.attach(ws as any, wsUser)
          ws.on('message', (data) => {
            try { wsHub.handleClientMessage(ws as any, JSON.parse(data.toString())) } catch {}
          })
          ws.on('close', (code, reason) => {
            log.info(`ws closed code=${code} reason="${reason.toString()}"`)
            wsHub.detach(ws as any)
          })
          ws.on('error', (err) => log.warn(`ws error: ${err.message}`))
        })
      })
    },
    async stop() {
      wss?.close()
      server?.close()
    },
    async send(_chatId, _card: StructuredCard) {
      throw new Error('Transport.send not implemented for Web in v0.5.0 (use cardBus.publish)')
    },
    onMessage(h) { messageHandler = h },
    onCommand() { },
    onButtonClick() { },
  }
}
