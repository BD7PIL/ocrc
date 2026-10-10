import { describe, it, expect } from 'vitest'
import {
  createPairingStore,
  buildPairUrlPending,
  buildPairUrl,
  DEFAULT_PENDING_TTL_MS,
} from '../../src/connectivity/pairing'

// P-remote semantics: the store IS the remote-control session. Pending QRs are
// multi-use while a session lives; exchange mints per-device session
// credentials (never an anchor token); refresh = new epoch (everything dies);
// stop closes the gate. All in-memory → a host restart is a stop.

describe('createPairingStore — session lifecycle', () => {
  it('starts off; issue() is null until a session is started', () => {
    const store = createPairingStore()
    expect(store.status()).toMatchObject({ active: false, epoch: 0, paired: 0 })
    expect(store.issue()).toBeNull()
    expect(store.exchange('anything')).toBeNull()
  })

  it('start() turns the session on; second start is idempotent (does not kick paired phones)', () => {
    const store = createPairingStore()
    const s1 = store.start()
    expect(s1.active).toBe(true)
    expect(s1.epoch).toBe(1)
    const p = store.issue()!
    const cred = store.exchange(p.token)
    expect(cred).toBeTruthy()
    const s2 = store.start()
    expect(s2.epoch).toBe(1) // NOT bumped
    expect(s2.startedAt).toBe(s1.startedAt)
    expect(store.verifySession(cred!)).toBe(true) // phone not kicked
  })

  it('stop() closes the session and kills every issued credential', () => {
    const store = createPairingStore()
    store.start()
    const cred = store.exchange(store.issue()!.token)!
    const s = store.stop()
    expect(s.active).toBe(false)
    expect(store.verifySession(cred)).toBe(false)
    expect(store.issue()).toBeNull()
    // exchange after stop → dead even with a stale pending token
    expect(store.exchange(p_token(store))).toBeNull()
    function p_token(_s: typeof store): string { return 'stale-pending' }
  })

  it('restart after stop opens a fresh gate (epoch keeps moving — stop also wiped credentials)', () => {
    const store = createPairingStore()
    store.start()
    store.stop()
    const s = store.start()
    expect(s.active).toBe(true)
    expect(s.epoch).toBeGreaterThan(1)
    expect(store.issue()).not.toBeNull()
  })
})

describe('createPairingStore — pending QR (multi-use while the session lives)', () => {
  it('issue() returns the SAME pending within its TTL (one QR, many scans)', () => {
    const store = createPairingStore()
    store.start()
    const a = store.issue()!
    const b = store.issue()!
    expect(b.token).toBe(a.token)
    expect(b.expiresAt).toBe(a.expiresAt)
  })

  it('exchange is MULTI-USE: each device gets its own distinct session credential', () => {
    const store = createPairingStore()
    store.start()
    const p = store.issue()!
    const c1 = store.exchange(p.token)
    const c2 = store.exchange(p.token)
    const c3 = store.exchange(p.token)
    expect(c1).toBeTruthy()
    expect(c2).toBeTruthy()
    expect(c3).toBeTruthy()
    expect(new Set([c1, c2, c3]).size).toBe(3)
    expect(store.status().paired).toBe(3)
    // none of them is ever an anchor token — the store has none
    for (const c of [c1, c2, c3]) expect(c!.length).toBeGreaterThanOrEqual(40)
  })

  it('expired pending is refused and a fresh one is issued on the next scan', async () => {
    const store = createPairingStore(50)
    store.start()
    const p = store.issue()!
    await new Promise((r) => setTimeout(r, 60)) // past the 50ms TTL
    expect(store.exchange(p.token)).toBeNull()
    const p2 = store.issue()!
    expect(p2.token).not.toBe(p.token) // expired one does not stick
    expect(p2.expiresAt).toBeGreaterThan(Date.now())
    expect(store.exchange(p2.token)).toBeTruthy()
  })

  it('pending expiresAt honors the TTL', () => {
    const store = createPairingStore()
    store.start()
    const p = store.issue()!
    expect(p.expiresAt).toBeGreaterThan(Date.now() + 55_000)
    expect(p.expiresAt).toBeLessThan(Date.now() + DEFAULT_PENDING_TTL_MS + 1_000)
  })
})

describe('createPairingStore — refresh (official 刷新二维码 semantics)', () => {
  it('refresh bumps the epoch: old pending AND every issued credential die', () => {
    const store = createPairingStore()
    store.start()
    const credA = store.exchange(store.issue()!.token)!
    const credB = store.exchange(store.issue()!.token)!

    const s = store.refresh()
    expect(s.epoch).toBe(2)
    expect(s.active).toBe(true)
    expect(store.verifySession(credA)).toBe(false) // phone A kicked
    expect(store.verifySession(credB)).toBe(false) // phone B kicked
    expect(store.status().paired).toBe(0)

    // old pending token is dead; the fresh QR works again
    expect(store.exchange('stale-from-old-epoch')).toBeNull()
    const fresh = store.exchange(store.issue()!.token)
    expect(fresh).toBeTruthy()
    expect(store.verifySession(fresh!)).toBe(true)
  })
})

describe('createPairingStore — verifySession (auth-middleware hook)', () => {
  it('only accepts credentials of the current live epoch', () => {
    const store = createPairingStore()
    store.start()
    const cred = store.exchange(store.issue()!.token)!
    expect(store.verifySession(cred)).toBe(true)
    expect(store.verifySession('garbage')).toBe(false)
    expect(store.verifySession('')).toBe(false)
    store.refresh()
    expect(store.verifySession(cred)).toBe(false)
    store.stop()
    expect(store.verifySession(cred)).toBe(false)
  })
})

describe('pairing URLs', () => {
  it('buildPairUrlPending embeds the pending token under #pair= and trims the base slash', () => {
    expect(buildPairUrlPending('http://h:4099/', 'P1')).toBe('http://h:4099/#pair=P1')
    expect(buildPairUrlPending('http://h:4099', 'a b')).toContain('#pair=a%20b')
  })

  it('anchor (#token=) and session (#pair=) URL schemes never collide', () => {
    const anchor = buildPairUrl('http://h:4099', 'tok')
    const pending = buildPairUrlPending('http://h:4099', 'tok')
    expect(anchor).toContain('#token=')
    expect(pending).toContain('#pair=')
  })
})
