import QRCode from 'qrcode'
import { randomBytes } from 'node:crypto'
import { loadOrCreateToken } from './auth/token.js'
import { resolvePublicUrl } from './exposure/providers.js'

/** Build the pairing URL with the token in the fragment (never the query, so it
 * isn't logged by proxies; the PWA reads it client-side then stores it). */
export function buildPairUrl(base: string, token: string): string {
  return `${base.replace(/\/+$/, '')}/#token=${encodeURIComponent(token)}`
}

/** Pairing URL carrying a PENDING token (`#pair=…`) — the device exchanges it
 * for a session credential client-side. Distinct scheme from the legacy
 * `#token=…` so the anchor and session flows never collide. */
export function buildPairUrlPending(base: string, pending: string): string {
  return `${base.replace(/\/+$/, '')}/#pair=${encodeURIComponent(pending)}`
}

export interface PairCard {
  url: string
  /** Terminal-renderable QR string. */
  qr: string
  /** Human-readable lines for terminals/chat. */
  lines: string[]
}

/** Anchor-device card: the PERMANENT access token in the fragment. Only for
 * surfaces that already hold the owner's trust (their console, `ocrc pair
 * --reset` output) — an anchor device keeps access until 撤销配对 rotates. */
export async function buildPairCard(base: string, token: string): Promise<PairCard> {
  const url = buildPairUrl(base, token)
  const qr = await QRCode.toString(url, { type: 'terminal', small: true })
  const lines = [
    'Scan to pair this ANCHOR device (permanent token — full access until the token is rotated):',
    '',
    url,
    '',
    'The token is stored on the device after the first open. Anchor devices are NOT affected',
    'by remote-control sessions (refresh/stop only kick session-paired phones).',
  ]
  return { url, qr, lines }
}

export async function qrTerminal(url: string): Promise<string> {
  return QRCode.toString(url, { type: 'terminal', small: true })
}

/** Session card: a `#pair=` pending link. The device exchanges it for a
 * session credential that dies with the remote-control session — the anchor
 * token is never exposed to whoever sees the QR. */
export async function buildPendingCard(base: string, pending: string, ttlMs: number): Promise<PairCard> {
  const url = buildPairUrlPending(base, pending)
  const qr = await qrTerminal(url)
  const seconds = Math.max(1, Math.round(ttlMs / 1000))
  const lines = [
    `Scan to join the remote-control session (link expires in ${seconds}s):`,
    '',
    url,
    '',
    '手机进入的是会话凭证：会话刷新或停止即失效；锚设备（#token= 桌面链接）不受影响。',
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

// ── Remote-control session (ZCode v3.15.1 pairing semantics, no relay) ──────
//
// Two credential tiers, fully decoupled lifecycles:
//
//  - ANCHOR devices hold the permanent token (the `#token=` links `ocrc start`
//    prints, or WEB_TOKEN). The session machinery never governs them: refresh
//    and stop kick only session-paired phones. Revoking an anchor = rotating
//    the token (`ocrc pair --reset` / 撤销配对), exactly as before.
//  - PHONES pair through a live SESSION: while one is on, the pending QR can
//    be exchanged repeatedly (each device mints its own session credential —
//    in-memory, never the anchor token); `refresh()` opens a new epoch and
//    kills every issued credential (the official 刷新二维码, hence its confirm
//    dialog); `stop()` closes the gate. Everything here is in-memory, so a
//    host restart is a stop.

export interface PendingPairing {
  token: string
  expiresAt: number
}

export interface PairSessionStatus {
  active: boolean
  /** Bumps on every start-from-off and refresh — the kill-switch generation. */
  epoch: number
  startedAt?: number
  pendingExpiresAt?: number
  /** Devices holding a live session credential of the current epoch. */
  paired: number
}

export interface PairingStore {
  /** Begin a session. Idempotent while one is live (a second `ocrc pair` in
   * another terminal must not kick the phones already in). */
  start(): PairSessionStatus
  /** New epoch: the pending and every issued session credential die — the
   * official 刷新二维码 semantics (its confirm copy exists for exactly this). */
  refresh(): PairSessionStatus
  /** Close the session: nothing issued survives. */
  stop(): PairSessionStatus
  status(): PairSessionStatus
  /** The live pending QR (issues one when none/expired); null while off. */
  issue(): PendingPairing | null
  /** Exchange the pending for a fresh SESSION credential. Multi-use while the
   * session lives — one credential per device, never the anchor token. */
  exchange(pending: string): string | null
  /** Is `credential` a live session credential? (the auth middleware's hook) */
  verifySession(credential: string): boolean
}

export const DEFAULT_PENDING_TTL_MS = 60_000

/** Per-epoch ceiling on issued credentials: the pending is multi-use, so this
 * is the only bound on a LAN device churning exchanges. */
const MAX_SESSION_DEVICES = 64

export function createPairingStore(ttlMs: number = DEFAULT_PENDING_TTL_MS): PairingStore {
  const random = (): string => randomBytes(32).toString('base64url')
  let epoch = 0
  let startedAt: number | undefined
  let pending: PendingPairing | null = null
  // Live session credentials of the current epoch, keyed by the credential
  // itself. Cleared whole on epoch change, so it never outgrows one session.
  let credentials = new Map<string, true>()

  const status = (): PairSessionStatus => ({
    active: startedAt !== undefined,
    epoch,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(pending ? { pendingExpiresAt: pending.expiresAt } : {}),
    paired: credentials.size,
  })

  const beginEpoch = (): PairSessionStatus => {
    epoch += 1
    startedAt = Date.now()
    pending = null
    credentials = new Map()
    return status()
  }

  return {
    start() {
      if (startedAt !== undefined) return status()
      return beginEpoch()
    },
    refresh() {
      return beginEpoch()
    },
    stop() {
      epoch += 1
      startedAt = undefined
      pending = null
      credentials = new Map()
      return status()
    },
    status,
    issue() {
      if (startedAt === undefined) return null
      if (!pending || Date.now() > pending.expiresAt) {
        pending = { token: random(), expiresAt: Date.now() + ttlMs }
      }
      return pending
    },
    exchange(p) {
      if (startedAt === undefined) return null
      if (!pending || pending.token !== p) return null
      if (Date.now() > pending.expiresAt) { pending = null; return null }
      if (credentials.size >= MAX_SESSION_DEVICES) return null
      const credential = random()
      credentials.set(credential, true)
      return credential
    },
    verifySession(credential) {
      if (startedAt === undefined) return false
      return credentials.has(credential)
    },
  }
}
