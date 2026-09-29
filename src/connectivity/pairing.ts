import QRCode from 'qrcode'
import { randomBytes } from 'node:crypto'
import { loadOrCreateToken } from './auth/token.js'
import { resolvePublicUrl } from './exposure/providers.js'

/** Build the pairing URL with the token in the fragment (never the query, so it
 * isn't logged by proxies; the PWA reads it client-side then stores it). */
export function buildPairUrl(base: string, token: string): string {
  return `${base.replace(/\/+$/, '')}/#token=${encodeURIComponent(token)}`
}

export interface PairCard {
  url: string
  /** Terminal-renderable QR string. */
  qr: string
  /** Human-readable lines for terminals/chat. */
  lines: string[]
}

export async function buildPairCard(base: string, token: string): Promise<PairCard> {
  const url = buildPairUrl(base, token)
  const qr = await QRCode.toString(url, { type: 'terminal', small: true })
  const lines = [
    'Scan to pair this device with opencode-remote-control:',
    '',
    url,
    '',
    'The token is stored on the device after the first open.',
  ]
  return { url, qr, lines }
}

export interface PairContext {
  token: string
  url: string
}

/** Resolve the current pairing token + best public URL from env (shared by the
 * CLI `ocrc pair` and the Telegram `/pair` command). */
export async function buildPairContext(): Promise<PairContext> {
  const port = Number(process.env.OCRC_WEB_PORT ?? process.env.WEB_PORT ?? 4099)
  const token = loadOrCreateToken({ token: process.env.WEB_TOKEN })
  const url = await resolvePublicUrl({ publicUrl: process.env.WEB_PUBLIC_URL, port })
  return { token, url }
}

// ── M11: pending pairing tokens ─────────────────────────────────────────────
// The legacy pair URL embeds the PERMANENT access token — anyone who sees the
// QR (screenshot, chat log, shoulder) owns the host forever. Pending tokens
// flip that: /pair surfaces issue a short-lived single-use token, the device
// exchanges it for the real token at POST /api/pair/exchange, and the pending
// dies on use, on expiry (1 minute), or when a newer one is issued (the
// "refresh QR" semantics the ZCode reference dialog has).

export interface PendingPairing {
  token: string
  expiresAt: number
}

export interface PairingStore {
  /** Issue a fresh pending token; the previous one becomes invalid. */
  issue(): PendingPairing
  /** Consume a pending token (single-use) → the real access token, or null. */
  exchange(pending: string): string | null
}

const DEFAULT_PENDING_TTL_MS = 60_000

export function createPairingStore(realToken: () => string, ttlMs: number = DEFAULT_PENDING_TTL_MS): PairingStore {
  const random = (): string => randomBytes(24).toString('base64url')
  let current: PendingPairing | null = null

  return {
    issue() {
      current = { token: random(), expiresAt: Date.now() + ttlMs }
      return current
    },
    exchange(pending) {
      if (!current || current.token !== pending) return null
      if (Date.now() > current.expiresAt) { current = null; return null }
      current = null // single-use
      return realToken()
    },
  }
}

/** Pairing URL carrying a PENDING token (`#pair=…`) — the PWA exchanges it for
 * the real token client-side. Distinct scheme from the legacy `#token=…` so
 * the two flows never collide. */
export function buildPairUrlPending(base: string, pending: string): string {
  return `${base.replace(/\/+$/, '')}/#pair=${encodeURIComponent(pending)}`
}
