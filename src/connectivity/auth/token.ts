import type { MiddlewareHandler } from 'hono'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import type { AuthStrategy, AuthUser } from './index.js'
import { createLogger } from '../../utils/logger.js'
import { ocrcHome, legacyOpencodeHome } from '../../utils/paths.js'

const log = createLogger('auth-token')
const COOKIE = 'ocrc_token'

export interface TokenAuthOptions {
  /** Explicit token (from config). If absent, load/generate from tokenPath. */
  token?: string
  /** Token file path. Default ${OCRC_HOME ?? ~/.ocrc}/token. */
  tokenPath?: string
  /** Identity email for the single user (used for token auth too, not just dev-bypass). */
  devEmail?: string
  /** Bypass auth for a real loopback peer (local dev). DANGER behind a same-host
   * tunnel (cloudflared): all remote traffic then looks loopback and skips auth. */
  devBypass?: boolean
  /** Bind host, used as the bypass signal when the socket peer is unknown. */
  host?: string
}

function defaultTokenPath(): string {
  return join(ocrcHome(), 'token')
}

/** One-time migration: a token persisted by the pre-fork build at
 *  ${OPENCODE_CONFIG_DIR ?? ~/.opencode}/oprc-token is adopted so an upstream
 *  install keeps its paired devices after upgrading to ocrc. */
function adoptLegacyToken(): string | null {
  const legacy = join(legacyOpencodeHome(), 'oprc-token')
  try {
    if (!existsSync(legacy)) return null
    const t = readFileSync(legacy, 'utf-8').trim()
    if (!t) return null
    const dest = defaultTokenPath()
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, t, { mode: 0o600 })
    chmodSync(dest, 0o600)
    log.info(`adopted legacy token from ${legacy} → ${dest}`)
    return t
  } catch {
    return null
  }
}

/** Resolve the web token: explicit > existing file > legacy migration > freshly generated (persisted 0600). */
export function loadOrCreateToken(opts: TokenAuthOptions = {}): string {
  if (opts.token && opts.token.trim()) return opts.token.trim()
  const path = opts.tokenPath ?? defaultTokenPath()
  try {
    if (existsSync(path)) {
      const t = readFileSync(path, 'utf-8').trim()
      if (t) return t
    }
  } catch {
    /* fall through to generate */
  }
  const adopted = adoptLegacyToken()
  if (adopted) return adopted
  const token = randomBytes(32).toString('base64url')
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, token, { mode: 0o600 })
    try {
      chmodSync(path, 0o600)
    } catch {
      /* best effort */
    }
    log.info(`generated web token at ${path}`)
  } catch (err) {
    log.warn(`could not persist token: ${(err as Error).message}`)
  }
  return token
}

function isLoopbackAddr(addr?: string): boolean {
  if (!addr) return false
  const clean = addr.replace(/^::ffff:/, '').split('%')[0]
  return clean === '127.0.0.1' || clean === '::1'
}

function tokenMatches(candidate: string | undefined, expected: string): boolean {
  if (!candidate) return false
  const a = Buffer.from(candidate)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function extractToken(
  headers: Record<string, string | string[] | undefined>,
  url?: string,
): string | undefined {
  const auth = headers['authorization']
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim()
  // Query-string tokens are accepted ONLY for the WS upgrade path (/ws) — the
  // caller decides by passing `url`. Browsers can't set headers on a WebSocket,
  // but a ?token= on a normal URL would leak into history/referer logs.
  if (url && url.startsWith('/ws') && url.includes('?')) {
    const q = new URLSearchParams(url.split('?')[1])
    const t = q.get('token')
    if (t) return t
  }
  const cookie = headers['cookie']
  if (typeof cookie === 'string') {
    const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`))
    if (m) return decodeURIComponent(m[1])
  }
  return undefined
}

function persistToken(path: string, token: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, token, { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    /* best effort */
  }
}

/** Change-detector stamp for the token file: mtime alone misses two writes
 *  landing inside the same millisecond — size disambiguates those. */
function stampOf(path: string): string | undefined {
  try {
    const st = statSync(path)
    return `${st.mtimeMs}:${st.size}`
  } catch { return undefined }
}

export function createTokenAuth(opts: TokenAuthOptions): AuthStrategy {
  const tokenPath = opts.tokenPath ?? defaultTokenPath()
  let expected = loadOrCreateToken(opts)
  // The token file is shared state: `ocrc pair --reset` (another process) may
  // rotate it underneath us. Cache by (mtimeMs, size) — one cheap stat per
  // request buys cross-process revocation without a read per request. Size
  // guards against two writes landing in the same millisecond (mtime alone
  // missed that; test-observed).
  let cachedStamp = stampOf(tokenPath)
  const user: AuthUser = { email: opts.devEmail ?? 'you@local', sub: 'token' }

  /** Pick up an out-of-band rotation (token file changed under us). */
  const refreshExpected = (): void => {
    if (opts.token?.trim()) return // explicit config token — file is not the source
    const stamp = stampOf(tokenPath)
    if (stamp === undefined || stamp === cachedStamp) return
    cachedStamp = stamp
    try {
      const t = readFileSync(tokenPath, 'utf-8').trim()
      if (t) expected = t
    } catch { /* keep the old token */ }
  }
  if (opts.devBypass) {
    log.warn(
      '⚠ token-auth devBypass is ON — requests from a loopback peer skip the token check entirely. ' +
      'If cloudflared (or any same-host tunnel/proxy) fronts this server, ALL remote traffic arrives ' +
      'from 127.0.0.1 and is let through UNAUTHENTICATED. Never combine devBypass with a tunnel.',
    )
  }
  const bypass = (peer: string | undefined): boolean => {
    if (!opts.devBypass) return false
    const peerKnown = peer !== undefined && peer !== ''
    return peerKnown ? isLoopbackAddr(peer) : isLoopbackAddr(opts.host)
  }

  return {
    httpMiddleware(): MiddlewareHandler {
      return async (c, next) => {
        // c.env.incoming is the Node IncomingMessage (set by @hono/node-server); c.req.raw is the web-standard Request. Peer may be undefined under some adapters → bypass() then falls back to host.
        const peer = ((): string | undefined => {
          try {
            return ((c.env as any)?.incoming ?? (c.req as any)?.raw)?.socket?.remoteAddress
          } catch {
            return undefined
          }
        })()
        if (bypass(peer)) { c.set('user', user); return next() }
        refreshExpected()
        const raw = (c.req as any).raw as Request | undefined
        const rawHeaders: Record<string, string | undefined> = {}
        try {
          for (const [k, v] of (raw?.headers ?? new Headers()).entries()) rawHeaders[k] = v
        } catch { /* ignore */ }
        const candidate = extractToken(rawHeaders)
        if (tokenMatches(candidate, expected)) { c.set('user', user); return next() }
        return c.json({ error: 'Unauthorized' }, 401)
      }
    },
    async verifyUpgrade(req) {
      refreshExpected()
      if (bypass(req.socket?.remoteAddress)) return user
      const candidate = extractToken(req.headers, req.url)
      return tokenMatches(candidate, expected) ? user : null
    },
    rotate() {
      if (opts.token?.trim()) {
        throw new Error('令牌来自配置（WEB_TOKEN）——请在配置中轮换，文件轮换不生效')
      }
      const t = randomBytes(32).toString('base64url')
      persistToken(tokenPath, t)
      expected = t
      cachedStamp = stampOf(tokenPath)
      log.info('web token rotated — all previously paired devices are logged out')
    },
  }
}
