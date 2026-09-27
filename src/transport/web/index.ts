import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { serve, type ServerType } from '@hono/node-server'
import { WebSocketServer } from 'ws'
import { serveStatic } from '@hono/node-server/serve-static'
import type { BackendRegistry } from '../../core/agent/registry.js'
import type { IncomingMessage, ChannelCapabilities } from '../../core/types.js'
import type { Transport, TransportStartDeps } from '../interface.js'
import type { StructuredCard } from '../../core/structured-card.js'
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
  /** P2b-M7 cross-channel scheduled prompts (optional). */
  scheduler?: Scheduler
}

const CAPS: ChannelCapabilities = {
  edit: true, maxMessageLength: Number.POSITIVE_INFINITY,
  buttons: true, richText: true, streaming: true,
}

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
      const app = buildServer({
        auth: cfg.auth,
        registry: cfg.registry,
        state: deps.state,
        cardBus: deps.cardBus,
        onMessage: (msg) => messageHandler ? messageHandler(msg) : Promise.resolve(),
        scheduler: cfg.scheduler,
      })

      // Immutable hashed assets cache forever; everything else (above all
      // index.html, which references those hashes) must revalidate on every
      // load — a cached stale index points at deleted hashes and the app
      // half-loads after any redeploy ("every refresh looks different").
      app.use('/_app/immutable/*', async (c, next) => {
        await next()
        c.header('Cache-Control', 'public, max-age=31536000, immutable')
      })
      app.use('/*', serveStatic({ root: cfg.staticRoot }))

      // SPA fallback — SvelteKit static adapter only prerenders index.html;
      // dynamic routes like /[sessionId]/ resolve client-side, so any non-API
      // path that doesn't match a real file must serve index.html.
      // Critical: ONLY fall back navigation-style paths. If a missing asset
      // (e.g. stale /_app/old-hash.js a cached browser still asks for) gets
      // index.html, the browser sees text/html where it expects JS and the
      // whole module graph silently stalls.
      const indexHtmlPath = join(cfg.staticRoot, 'index.html')
      // Read once at startup — the previous per-request readFileSync put a
      // synchronous disk hit on every unmatched GET.
      const indexHtml = readFileSync(indexHtmlPath, 'utf-8')
      app.get('*', (c) => {
        const path = c.req.path
        if (path.startsWith('/api/') || path === '/ws') return c.notFound()
        c.header('Cache-Control', 'no-cache')
        return c.html(indexHtml)
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
      // Post-bind late errors are re-thrown async: fatal to this transport but
      // absorbed by the process guards so the worker stays alive.
      ;(server as any).on('error', (err: Error) => {
        log.error(`web transport error after bind: ${err.message}`)
        setImmediate(() => { throw err })
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
