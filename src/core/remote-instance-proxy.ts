import http from 'node:http'
import net from 'node:net'
import { createLogger } from '../utils/logger.js'

const log = createLogger('remote-instance-proxy')

/**
 * P3 / R9 — the control side's egress relay.
 *
 * The controlled host may have **no public egress** (R6), while compute and the
 * engine must stay there. So the instance's engine gets `HTTPS_PROXY` pointing at
 * its own loopback, and an `ssh -R 127.0.0.1:<p>` brings that loopback port back
 * here (`remote-instance-bridge` puts both in the same ssh process as the `-L`).
 * This file is the other end: a small CONNECT proxy that talks to the internet on
 * the engine's behalf.
 *
 * Design notes that are load-bearing:
 *   · **Loopback-bound.** `127.0.0.1` only — the reverse tunnel is the only way
 *     in, so no LAN listener and no auth surface to get wrong.
 *   · **The control side's own loopback is refused** (`127.0.0.0/8`, `::1`,
 *     `localhost`). Without that, a process on the controlled host could reach
 *     services on this machine (the panel, other instances' tunnels) — a
 *     privilege jump that no model endpoint ever needs.
 *   · **Every target is recorded.** `connects` is the evidence R9 is actually
 *     wired: the acceptance run asserts the model host appears here, which is
 *     something a "the request succeeded" assertion cannot tell you (the host may
 *     still have had its own egress).
 */

export interface ProxyTarget {
  host: string
  port: number
}

/** `CONNECT host:port HTTP/1.1` → target. Also accepts the absolute-form
 *  request line (`GET http://host/path`) for the plain-HTTP path. */
export function parseConnectTarget(line: string): ProxyTarget | undefined {
  // The host is either a bracketed IPv6 literal or a plain name/IPv4 — `[^\s:]+`
  // keeps the port separator unambiguous, and the bracket branch keeps colons
  // inside an address from being read as the separator.
  const m = /^CONNECT\s+(\[[0-9a-fA-F:.]+\]|[^\s:]+):(\d{1,5})\s+HTTP\/1\.[01]$/i.exec((line ?? '').trim())
  if (!m) return undefined
  const port = Number(m[2])
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  return { host: m[1].replace(/^\[|\]$/g, ''), port }
}

export function parseAbsoluteUrlTarget(url: string): ProxyTarget | undefined {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:') return undefined
    return { host: u.hostname, port: Number(u.port || 80) }
  } catch {
    return undefined
  }
}

/** Is this target the machine the proxy itself runs on? Then refuse: the
 *  reverse tunnel must not become a door into the control side. */
export function isLocalTarget(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return true
  if (/^127\./.test(h)) return true
  return false
}

/**
 * 目标白名单（企业工况的收紧开关）。空列表 = 不额外限制（回环仍然一律拒）。
 *
 * 匹配规则刻意只有一条：**按点边界的后缀**，大小写不敏感。
 *   · `example.com`      → `example.com`、`api.example.com`（不含 `notexample.com`）
 *   · `api.example.com`  → 只匹配它自己
 * 不做通配符/正则/CIDR——白名单越"聪明"，越容易在出事后没人说得清哪条生效。
 */
export function isTargetAllowed(host: string, allow: readonly string[] | undefined): boolean {
  // 只留有效条目：全是空白/空串等于「没写白名单」，不是「什么都不许」。
  const entries = (allow ?? []).map((raw) => raw.trim().toLowerCase().replace(/\.$/, '')).filter(Boolean)
  if (entries.length === 0) return true
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  return entries.some((entry) => h === entry || h.endsWith(`.${entry}`))
}

export interface InstanceProxy {
  port: number
  /** Targets dialled so far, in order — the R9 evidence trail. */
  connects: ProxyTarget[]
  close(): Promise<void>
}

export interface InstanceProxyOptions {
  /** 0 = let the OS pick (tests); the CLI passes the instance's local port. */
  port?: number
  host?: string
  onConnect?: (target: ProxyTarget) => void
  onLog?: (line: string) => void
  /** Allow targets on this machine's loopback. Off by default (the relay is for
   *  the internet); on is the escape hatch for a self-hosted model that lives on
   *  the control side itself. Tests use it to exercise the success path offline. */
  allowLocal?: boolean
  /** 目标白名单（空/缺省 = 不额外限制）。见 isTargetAllowed 的匹配规则。 */
  allow?: readonly string[]
}

/** Start the relay. Resolves once the port is bound. */
export function createInstanceProxy(opts: InstanceProxyOptions = {}): Promise<InstanceProxy> {
  const host = opts.host ?? '127.0.0.1'
  const connects: ProxyTarget[] = []
  const say = (line: string) => {
    log.info(line)
    opts.onLog?.(line)
  }

  const server = http.createServer((req, res) => {
    const target = parseAbsoluteUrlTarget(req.url ?? '')
    if (!target) {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('absolute-form http:// URL required\n')
      return
    }
    if (!isTargetAllowed(target.host, opts.allow)) {
      say(`refused target ${target.host}（不在白名单：${(opts.allow ?? []).join(', ') || '（空）'}）`)
      res.writeHead(403, { 'content-type': 'text/plain' }).end('target not in relay allowlist\n')
      return
    }
    if (!opts.allowLocal && isLocalTarget(target.host)) {
      say(`refused local target ${target.host}:${target.port}（代理是给对端出网用的，不是通往控制端的门）`)
      res.writeHead(403, { 'content-type': 'text/plain' }).end('local targets refused\n')
      return
    }
    connects.push(target)
    opts.onConnect?.(target)
    say(`GET ${target.host}:${target.port}${new URL(req.url!).pathname}`)
    const upstream = http.request(
      { host: target.host, port: target.port, method: req.method, path: new URL(req.url!).pathname + new URL(req.url!).search, headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers)
        up.pipe(res)
      },
    )
    upstream.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(`upstream error: ${err.message}\n`)
    })
    req.pipe(upstream)
  })

  // CONNECT: the path every LLM SDK uses over HTTPS.
  server.on('connect', (req, clientSocket, head) => {
    const target = parseConnectTarget(req.url ? `CONNECT ${req.url} HTTP/1.1` : '')
    if (!target) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }
    if (!isTargetAllowed(target.host, opts.allow)) {
      say(`refused target ${target.host}（不在白名单：${(opts.allow ?? []).join(', ') || '（空）'}）`)
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    if (!opts.allowLocal && isLocalTarget(target.host)) {
      say(`refused local target ${target.host}:${target.port}`)
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    connects.push(target)
    opts.onConnect?.(target)
    say(`CONNECT ${target.host}:${target.port}`)
    const upstream = net.connect(target.port, target.host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head?.length) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    const drop = (err: Error) => {
      say(`upstream ${target.host}:${target.port} failed: ${err.message}`)
      clientSocket.destroy()
      upstream.destroy()
    }
    upstream.on('error', drop)
    clientSocket.on('error', () => upstream.destroy())
    clientSocket.on('end', () => upstream.end())
  })

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(opts.port ?? 0, host, () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        server.close()
        reject(new Error('proxy: no port'))
        return
      }
      say(`proxy listening on ${host}:${addr.port}`)
      resolve({
        port: addr.port,
        connects,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done())
            // Live CONNECT sockets would keep the listener open forever.
            server.closeAllConnections?.()
          }),
      })
    })
  })
}
