import { describe, expect, it } from 'vitest'
import { buildEgressProbeCommand, parseEgressProbe, resolveEgressPolicy } from '../../src/core/remote-instance.js'

/**
 * A peer with its own internet must not be routed through the control side: the
 * detour costs latency and makes the control machine a single point of failure
 * for a peer that was never offline. `auto` is the default policy — probe the
 * peer, relay only when it cannot get out itself.
 */

describe('resolveEgressPolicy', () => {
  it('defaults to auto and relays when the peer has no egress', () => {
    expect(resolveEgressPolicy({ relayAllowed: true, probe: 'none' })).toEqual({ relay: true, reason: '探测：对端无出网' })
  })

  it('keeps a peer with its own egress direct', () => {
    expect(resolveEgressPolicy({ relayAllowed: true, probe: 'direct' })).toEqual({ relay: false, reason: '探测：对端自己可出网' })
  })

  it('still relays when the peer has a route but no resolver', () => {
    expect(resolveEgressPolicy({ relayAllowed: true, probe: 'dns-only' }).relay).toBe(true)
  })

  it('is conservative when the probe could not run', () => {
    // Silently losing egress is worse than an unnecessary detour.
    expect(resolveEgressPolicy({ relayAllowed: true, probe: 'unknown' }).relay).toBe(true)
    expect(resolveEgressPolicy({ relayAllowed: true }).relay).toBe(true)
  })

  it('honours explicit choices over the probe', () => {
    expect(resolveEgressPolicy({ mode: 'direct', relayAllowed: true, probe: 'none' }).relay).toBe(false)
    expect(resolveEgressPolicy({ mode: 'relay', relayAllowed: true, probe: 'direct' }).relay).toBe(true)
  })

  it('relay-off beats everything', () => {
    expect(resolveEgressPolicy({ mode: 'relay', relayAllowed: false, probe: 'none' }).relay).toBe(false)
  })
})

describe('parseEgressProbe', () => {
  it('reads the probe verdict, tolerating trailing noise', () => {
    expect(parseEgressProbe('direct\n')).toBe('direct')
    expect(parseEgressProbe('warning: something\nnone')).toBe('none')
    expect(parseEgressProbe('dns-only')).toBe('dns-only')
  })

  it('treats anything else as unknown', () => {
    expect(parseEgressProbe('')).toBe('unknown')
    expect(parseEgressProbe('Error: spawn failed')).toBe('unknown')
  })
})

describe('buildEgressProbeCommand', () => {
  it('runs on the pushed runtime and is bounded by one deadline', () => {
    const cmd = buildEgressProbeCommand({ appVersion: '2.3.3' })
    expect(cmd).toContain('$HOME/.ocrc/remote/runtime/node-v')
    expect(cmd).toContain('registry.npmjs.org')
    expect(cmd).toContain('setTimeout')
    expect(cmd).toContain('6000') // deadline, so a no-egress host answers instead of hanging
  })

  it('accepts a different host and budget', () => {
    const cmd = buildEgressProbeCommand({ appVersion: '2.3.3', host: 'api.deepseek.com', timeoutMs: 1500, deadlineMs: 2500 })
    expect(cmd).toContain('api.deepseek.com')
    expect(cmd).toContain('1500')
    expect(cmd).toContain('2500')
  })
})
