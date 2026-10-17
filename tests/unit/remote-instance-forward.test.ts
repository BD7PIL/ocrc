import { describe, expect, it } from 'vitest'
import { buildForwardArgs, buildRelayForwardArgs } from '../../src/core/remote-instance.js'

/**
 * The self-tunnel and the external (desktop-shell) tunnel are two ssh processes
 * over the same host. The reverse leg exists in exactly one of them, and only
 * one process may bind `127.0.0.1:<localPort>` on the control side — otherwise
 * `ExitOnForwardFailure` turns the second attempt into a reconnect loop.
 */

describe('forward argument builders', () => {
  it('self-tunnel carries both directions in one ssh process', () => {
    const args = buildForwardArgs({
      host: 'h', port: 22, user: 'demo', localPort: 4610, remotePort: 2610,
      reverse: { remotePort: 2711, localPort: 4711 },
    })
    expect(args).toContain('-L')
    expect(args[args.indexOf('-L') + 1]).toBe('127.0.0.1:4610:127.0.0.1:2610')
    expect(args[args.indexOf('-R') + 1]).toBe('127.0.0.1:2711:127.0.0.1:4711')
    expect(args[args.length - 1]).toBe('demo@h')
  })

  it('self-tunnel without a relay has no -R', () => {
    const args = buildForwardArgs({ host: 'h', port: 22, localPort: 4610, remotePort: 2610 })
    expect(args).not.toContain('-R')
    expect(args[args.length - 1]).toBe('h')
  })

  it('relay forward drops -L so the desktop shell keeps the local port', () => {
    const args = buildRelayForwardArgs({
      host: 'h', port: 22, user: 'demo', localPort: 4610, remotePort: 2610,
      reverse: { remotePort: 2711, localPort: 4711 },
    })
    expect(args).not.toContain('-L')
    expect(args).toContain('-R')
    expect(args[args.indexOf('-R') + 1]).toBe('127.0.0.1:2711:127.0.0.1:4711')
    // Keepalives and the busy-port assertion still apply.
    expect(args).toContain('ServerAliveInterval=15')
    expect(args).toContain('ExitOnForwardFailure=yes')
  })

  it('relay forward without a reverse spec is a programming error, not a silent no-op', () => {
    expect(() => buildRelayForwardArgs({ host: 'h', port: 22, localPort: 4610, remotePort: 2610 })).toThrow(/reverse/)
  })
})