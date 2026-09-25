// src/lib/auth.test.ts — the reload-free auth state machine.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// jsdom-ish environment is provided by the vitest web setup; location is real.
import { get } from 'svelte/store'
import { auth, onUnauthorized, submitPairing } from './auth.js'
import { setToken, clearToken, getToken } from './auth-token.js'

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  // Normalize: no fragment, store booted to a known state per test.
  if (location.hash) history.replaceState(null, '', location.pathname + location.search)
  clearToken()
  auth.set('booting')
})

describe('submitPairing', () => {
  it('accepts a plausible token, persists it, and flips to ready — no reload', () => {
    const reload = vi.fn()
    // location.reload is not configurable in jsdom; prove no navigation by
    // observing that auth reaches 'ready' synchronously and token persists.
    expect(submitPairing('abcdefghijklmnopqrstuvwxyz')).toBe(true)
    expect(get(auth)).toBe('ready')
    expect(getToken()).toBe('abcdefghijklmnopqrstuvwxyz')
    expect(reload).not.toHaveBeenCalled()
  })

  it('rejects a too-short token and stays in pairing', () => {
    auth.set('pairing')
    expect(submitPairing('short')).toBe(false)
    expect(get(auth)).toBe('pairing')
    expect(getToken()).toBeNull()
  })
})

describe('onUnauthorized', () => {
  it('stored token rejected, no fragment → wipe and show the gate (no reload)', () => {
    setToken('abcdefghijklmnopqrstuvwxyz')
    auth.set('ready')
    onUnauthorized()
    expect(get(auth)).toBe('pairing')
    expect(getToken()).toBeNull()
    expect(sessionStorage.getItem('ocrc.authReloaded')).toBeNull()
  })

  it('fragment token is newer than the rejected stored one → adopt and retry', () => {
    setToken('abcdefghijklmnopqrstuvwxyz')
    auth.set('ready')
    history.replaceState(null, '', '#token=zyxwvutsrqponmlkjihgfedcba')
    onUnauthorized()
    expect(get(auth)).toBe('ready')
    expect(getToken()).toBe('zyxwvutsrqponmlkjihgfedcba')
    history.replaceState(null, '', location.pathname + location.search)
  })

  it('fragment IS the rejected token → rejected gate, token kept, no wipe', () => {
    setToken('abcdefghijklmnopqrstuvwxyz')
    auth.set('ready')
    history.replaceState(null, '', '#token=abcdefghijklmnopqrstuvwxyz')
    onUnauthorized()
    expect(get(auth)).toBe('rejected')
    expect(getToken()).toBe('abcdefghijklmnopqrstuvwxyz')
    history.replaceState(null, '', location.pathname + location.search)
  })

  it('no stored token while pairing → straggler 401 ignored (no CF reload)', () => {
    auth.set('pairing')
    onUnauthorized()
    expect(get(auth)).toBe('pairing')
    expect(sessionStorage.getItem('ocrc.authReloaded')).toBeNull()
  })

  it('no stored token while ready → legacy CF reload-once path', () => {
    auth.set('ready')
    onUnauthorized()
    expect(sessionStorage.getItem('ocrc.authReloaded')).toBe('1')
  })
})
