import type { Hono } from 'hono'
import { hostname } from 'node:os'
import type { PairingStore, PairContext } from '../../../connectivity/pairing.js'
import { buildPairContext, buildPairUrlPending } from '../../../connectivity/pairing.js'
import type { ChannelsStore } from '../../../core/channels.js'

async function qrSvg(pairUrl: string): Promise<string> {
  const QRCode = (await import('qrcode')).default
  return QRCode.toString(pairUrl, { type: 'svg', margin: 1 })
}

async function pairBase(): Promise<PairContext> {
  return buildPairContext()
}

/**
 * M12: unauthenticated onboarding surface — the first-run landing page.
 * Owner decision: on a 0.0.0.0 bind, first-pairing convenience wins over the
 * LAN-stranger risk, and the page shows what ZCode's 移动端远程控制 dialog
 * shows: a live pending QR + bot-channel STATUS. Hard lines kept:
 *  - the QR carries a PENDING token (5 min, single-use, invalidated by the
 *    next issue) — never the permanent credential;
 *  - channel payload is STATUS ONLY (name/enabled/live) — no credentials,
 *    no granularity/scope; management stays behind auth.
 */
export function registerPairOnboarding(
  app: Hono,
  deps: { pairing?: PairingStore; channels?: ChannelsStore; telegramStatus?: () => { connected: boolean; username?: string } | null },
) {
  if (!deps.pairing) return
  app.get('/api/pair/onboarding', async (c) => {
    try {
      const { url } = await pairBase()
      const p = deps.pairing!.issue()
      const pairUrl = buildPairUrlPending(url, p.token)
      const svg = await qrSvg(pairUrl)
      const status = deps.telegramStatus?.() ?? null
      const channels = (deps.channels?.list() ?? []).map((b) => ({
        channel: b.channel,
        enabled: b.enabled,
        live: b.channel === 'telegram' && status ? { connected: status.connected, username: status.username } : null,
      }))
      return c.json({
        url: pairUrl,
        svg,
        expiresAt: p.expiresAt,
        channels,
        host: { hostname: hostname(), platform: process.platform, arch: process.arch },
      })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })
}

/**
 * M11: pending-token pairing routes.
 *
 *  - POST /api/pair/exchange — registered BEFORE the auth guard (the device
 *    holding a pending token has no real token yet). The pending token IS the
 *    credential: short-lived, single-use, invalidated by the next issue().
 *  - GET /api/pair/qr — still behind the auth guard (only an already-paired
 *    session onboards another device): issues a fresh pending token and
 *    renders the QR for its `#pair=` URL. Without a pairing store (standalone
 *    hosts that didn't wire one) it falls back to the legacy static-token URL.
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
      const { token, url } = await pairBase()
      if (pairing) {
        const p = pairing.issue()
        const pairUrl = buildPairUrlPending(url, p.token)
        const svg = await qrSvg(pairUrl)
        return c.json({ url: pairUrl, svg, expiresAt: p.expiresAt })
      }
      // Legacy fallback (no store wired): static-token URL, no expiry.
      const { buildPairUrl } = await import('../../../connectivity/pairing.js')
      const pairUrl = buildPairUrl(url, token)
      const svg = await qrSvg(pairUrl)
      return c.json({ url: pairUrl, svg })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })
}
