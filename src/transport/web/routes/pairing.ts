import type { Hono } from 'hono'
import { hostname } from 'node:os'
import type { PairingStore, PairSessionStatus } from '../../../connectivity/pairing.js'
import { buildPairUrlPending } from '../../../connectivity/pairing.js'
import { isLoopbackAddr } from '../../../connectivity/auth/token.js'
import type { AuthStrategy } from '../../../connectivity/auth/index.js'
import type { ChannelsStore } from '../../../core/channels.js'

async function qrSvg(pairUrl: string): Promise<string> {
  const QRCode = (await import('qrcode')).default
  return QRCode.toString(pairUrl, { type: 'svg', margin: 1 })
}

/**
 * POST /api/pair/session/start|refresh|stop — remote-control session lifecycle.
 *
 * Loopback-only BY DESIGN: whoever is already on the host console manages the
 * gate (mirrors the official desktop dialog, where the owner drives 刷新/停止).
 * A phone that holds a session credential must not be able to refresh (kick
 * everyone incl. itself is tolerable) or — worse — re-open a stopped session.
 * 409 when the auth strategy can't accept session credentials at all
 * (CF Access mode) — a session there could never let a phone in.
 */
export function registerPairSession(
  app: Hono,
  deps: { pairing?: PairingStore; auth?: AuthStrategy; getPeer?: (c: { env?: unknown; req?: unknown }) => string | undefined },
) {
  if (!deps.pairing || !deps.auth) return
  const supported = deps.auth.sessionsAccepted === true
  const peerOf =
    deps.getPeer ??
    ((c: { env?: unknown; req?: unknown }): string | undefined => {
      try {
        return ((c.env as any)?.incoming ?? (c.req as any)?.raw)?.socket?.remoteAddress
      } catch {
        return undefined
      }
    })
  const guarded = (c: any, op: () => PairSessionStatus): any => {
    if (!supported) return c.json({ error: '当前认证方式（CF Access）不支持远控会话' }, 409)
    if (!isLoopbackAddr(peerOf(c))) return c.json({ error: '远控会话管理仅限主机本机（loopback）操作' }, 403)
    return c.json(op())
  }
  app.post('/api/pair/session/start', (c) => guarded(c, () => deps.pairing!.start()))
  app.post('/api/pair/session/refresh', (c) => guarded(c, () => deps.pairing!.refresh()))
  app.post('/api/pair/session/stop', (c) => guarded(c, () => deps.pairing!.stop()))
  // Status is readable from any authed device (anchor or session phone): the
  // panel card renders the greyed-out management buttons from the 403 the
  // mutating endpoints return, and phones show "N connected".
  app.post('/api/pair/session/status', (c) => {
    if (!supported) return c.json({ error: '当前认证方式（CF Access）不支持远控会话' }, 409)
    return c.json(deps.pairing!.status())
  })
}

/**
 * M12: unauthenticated onboarding surface — the first-run landing page.
 * P-remote: while the remote-control session is OFF the page reports
 * `{ status: 'off' }` (no QR — a closed gate must not render an open one).
 * With a session live it shows the pending QR + bot-channel STATUS. Hard
 * lines kept:
 *  - the QR carries a PENDING token, never the permanent anchor credential;
 *  - channel payload is STATUS ONLY — management stays behind auth.
 */
export function registerPairOnboarding(
  app: Hono,
  deps: { pairing?: PairingStore; channels?: ChannelsStore; telegramStatus?: () => { connected: boolean; username?: string } | null },
) {
  if (!deps.pairing) return
  app.get('/api/pair/onboarding', async (c) => {
    try {
      const status = deps.telegramStatus?.() ?? null
      const channels = (deps.channels?.list() ?? []).map((b) => ({
        channel: b.channel,
        enabled: b.enabled,
        live: b.channel === 'telegram' && status ? { connected: status.connected, username: status.username } : null,
      }))
      if (!deps.pairing!.status().active) {
        return c.json({ status: 'off', paired: 0, channels, host: { hostname: hostname(), platform: process.platform, arch: process.arch } })
      }
      const p = deps.pairing!.issue()
      if (!p) return c.json({ status: 'off', paired: 0, channels, host: { hostname: hostname(), platform: process.platform, arch: process.arch } })
      const { url } = await pairBase()
      const pairUrl = buildPairUrlPending(url, p.token)
      const svg = await qrSvg(pairUrl)
      return c.json({
        status: 'on',
        url: pairUrl,
        svg,
        expiresAt: p.expiresAt,
        paired: deps.pairing!.status().paired,
        channels,
        host: { hostname: hostname(), platform: process.platform, arch: process.arch },
      })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })
}

async function pairBase(): Promise<{ url: string }> {
  const { buildPairContext } = await import('../../../connectivity/pairing.js')
  const { url } = await buildPairContext()
  return { url }
}

/**
 * M11 → P-remote: pending-token pairing routes.
 *
 *  - POST /api/pair/exchange — registered BEFORE the auth guard (the device
 *    holding a pending token has no credential yet). While the session lives
 *    the pending is MULTI-USE: each device gets its own random session
 *    credential; the anchor token never crosses this endpoint.
 *  - GET /api/pair/qr — behind the auth guard: issues (or reuses) the live
 *    pending and renders the QR for its `#pair=` URL. Without a pairing store
 *    it falls back to the legacy static-token URL (anchor re-pair surface).
 */
export function registerPairExchange(app: Hono, pairing?: PairingStore) {
  if (!pairing) return
  app.post('/api/pair/exchange', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { pending?: string }
    if (typeof body.pending !== 'string' || !body.pending) return c.json({ error: 'pending required' }, 400)
    const token = pairing.exchange(body.pending)
    if (!token) return c.json({ error: 'expired' }, 404)
    return c.json({ token })
  })
}

export function registerPairQr(app: Hono, pairing?: PairingStore) {
  app.get('/api/pair/qr', async (c) => {
    try {
      if (pairing) {
        const p = pairing.issue()
        if (!p) return c.json({ error: '远控会话未开启 — 先在面板或 ocrc pair 打开会话' }, 409)
        const { url } = await pairBase()
        const pairUrl = buildPairUrlPending(url, p.token)
        const svg = await qrSvg(pairUrl)
        return c.json({ url: pairUrl, svg, expiresAt: p.expiresAt })
      }
      // Legacy fallback (no store wired): the anchor `#token=` URL, no expiry.
      const { buildPairContext, buildPairUrl } = await import('../../../connectivity/pairing.js')
      const { token, url } = await buildPairContext()
      const pairUrl = buildPairUrl(url, token)
      const svg = await qrSvg(pairUrl)
      return c.json({ url: pairUrl, svg })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })
}

/**
 * POST /api/pair/reset — revoke ALL devices: rotates the anchor token (every
 * anchor 401s on its next request and lands back on a fresh `ocrc start`
 * link) and closes the remote-control session (phones die with it). Session
 * credentials are per-device already; per-DEVICE anchor revocation remains
 * deliberately not built. Auth-gated like /api/pair/qr. 409 when the active
 * strategy holds no app-side credential (CF Access).
 */
export function registerPairReset(app: Hono, deps: { pairing?: PairingStore; auth?: AuthStrategy } = {}) {
  app.post('/api/pair/reset', (c) => {
    if (!deps.auth?.rotate) return c.json({ error: '当前认证方式没有可轮换的令牌' }, 409)
    try {
      deps.auth.rotate()
    } catch (err) {
      return c.json({ error: (err as Error).message }, 409)
    }
    deps.pairing?.stop()
    return c.json({ ok: true })
  })
}
