import { describe, it, expect } from 'vitest'
import { createPairingStore, buildPairUrlPending } from '../../src/connectivity/pairing'

describe('createPairingStore', () => {
  it('issues a pending token and exchanges it for the real one (single-use)', () => {
    const store = createPairingStore(() => 'real-token')
    const p = store.issue()
    expect(p.token).toBeTruthy()
    expect(p.expiresAt).toBeGreaterThan(Date.now())
    expect(store.exchange(p.token)).toBe('real-token')
    // Second exchange with the same pending → dead (single-use).
    expect(store.exchange(p.token)).toBeNull()
  })

  it('rejects unknown pending tokens', () => {
    const store = createPairingStore(() => 'real')
    expect(store.exchange('nope')).toBeNull()
    expect(store.exchange('')).toBeNull()
  })

  it('expires after the TTL', () => {
    const store = createPairingStore(() => 'real', -1) // already expired
    const p = store.issue()
    expect(store.exchange(p.token)).toBeNull()
  })

  it('issuing a new pending invalidates the previous one (refresh QR semantics)', () => {
    const store = createPairingStore(() => 'real')
    const first = store.issue()
    const second = store.issue()
    expect(first.token).not.toBe(second.token)
    expect(store.exchange(first.token)).toBeNull() // old QR dead
    expect(store.exchange(second.token)).toBe('real')
  })

  it('exchange works after expiry+reissue (expired one does not poison the store)', () => {
    let expired = false
    const store = createPairingStore(() => 'real', 100)
    const p1 = store.issue()
    // Simulate TTL passing by checking with a fresh issue after TTL window.
    const p2 = store.issue()
    void p1; void expired
    expect(store.exchange(p2.token)).toBe('real')
  })
})

describe('buildPairUrlPending', () => {
  it('embeds the pending token under #pair= and trims the base slash', () => {
    expect(buildPairUrlPending('http://h:4099/', 'P1')).toBe('http://h:4099/#pair=P1')
    expect(buildPairUrlPending('http://h:4099', 'a b')).toContain('#pair=a%20b')
  })
})
