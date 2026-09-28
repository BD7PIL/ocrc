import type { Hono } from 'hono'
import type { PairingStore, PairContext } from '../../../connectivity/pairing.js'
import { buildPairContext, buildPairUrlPending } from '../../../connectivity/pairing.js'

async function qrSvg(pairUrl: string): Promise<string> {
  const QRCode = (await import('qrcode')).default
  return QRCode.toString(pairUrl, { type: 'svg', margin: 1 })
}

async function pairBase(): Promise<PairContext> {
  return buildPairContext()
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
