import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

// Supervisor core: spawn/retry/stop lifecycle with a fake ssh child.
// jsdom env (panel-side config) but this suite is pure logic — no DOM.

type FakeChild = EventEmitter & { stdout: EventEmitter | null; stderr: EventEmitter | null; kill: ReturnType<typeof vi.fn>; exitCode: number | null }

function fakeChild(): FakeChild {
  const c = new EventEmitter() as FakeChild
  c.stdout = new EventEmitter()
  c.stderr = new EventEmitter()
  c.kill = vi.fn()
  c.exitCode = null
  return c
}

const { createTunnelSupervisor, defaultProbeEngine } = await import('../service/tunnel.js')
const { buildSshArgs, normalizeProfile } = await import('../shared/protocol.js')

const profile = normalizeProfile({ host: 'el7.lab', user: 'demo' })

describe('buildSshArgs', () => {
  it('builds a keepalive forward argv with defaults (4096→4096)', () => {
    const args = buildSshArgs(profile)
    expect(args).toContain('-N')
    expect(args).toContain('ExitOnForwardFailure=yes')
    expect(args).toContain('ServerAliveInterval=15')
    expect(args).toContain('-L')
    expect(args.find((a) => a.startsWith('127.0.0.1:4096'))).toContain('127.0.0.1:4096')
    expect(args.at(-1)).toBe('demo@el7.lab')
  })
  it('uses -i when a key path is set and custom ports when given', () => {
    const p = normalizeProfile({ host: 'h', port: 2222, keyPath: '~/.ssh/id_ed25519', localPort: 4097, remotePort: 4597 })
    const args = buildSshArgs(p)
    expect(args).toContain('~/.ssh/id_ed25519')
    expect(args).toContain('-p')
    expect(args[args.indexOf('-p') + 1]).toBe('2222')
    expect(args.find((a) => a.startsWith('127.0.0.1:4097'))).toContain('127.0.0.1:4597')
  })
})

describe('tunnel supervisor', () => {
  let child: FakeChild
  beforeEach(() => {
    child = fakeChild()
    vi.useFakeTimers()
  })
  afterEach(() => { vi.useRealTimers() })

  function supervisorWith(probe = async () => true) {
    return createTunnelSupervisor({
      spawnSsh: () => child as never,
      probeEngine: probe,
      now: () => Date.now(),
    })
  }

  it('reports starting→up after spawn and probes engine on statusProbed', async () => {
    const s = supervisorWith()
    s.start(profile)
    // ssh child alive (exitCode null) → tunnel is up immediately after spawn;
    // 'starting' only shows between an exit and the retry launch.
    expect(s.status().tunnel).toBe('up')
    const probed = await s.statusProbed()
    expect(probed.engine).toBe('reachable')
    s.stop()
  })

  it('reconnects with backoff when ssh exits, stop() cancels retries', async () => {
    const spawns: FakeChild[] = []
    const s = createTunnelSupervisor({
      spawnSsh: () => { const c = fakeChild(); spawns.push(c); return c as never },
      probeEngine: async () => true,
    })
    s.start(profile)
    expect(spawns).toHaveLength(1)
    spawns[0].emit('exit', 255, null)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(spawns).toHaveLength(2) // first retry after 2s
    spawns[1].emit('exit', 255, null)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(spawns).toHaveLength(3) // second retry after 4s (backoff doubled)
    s.stop()
    spawns[2].emit('exit', 255, null)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(spawns).toHaveLength(3) // stop() cancelled the retry chain
  })

  it('stop() kills the live child', async () => {
    const s = supervisorWith()
    s.start(profile)
    s.stop()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('status without a profile says so', () => {
    const s = supervisorWith()
    expect(s.status()).toMatchObject({ profileId: null, tunnel: 'down' })
  })
})

describe('defaultProbeEngine', () => {
  it('returns false when nothing listens', async () => {
    // port 1 on loopback is never our engine
    expect(await defaultProbeEngine(1, 500)).toBe(false)
  })
})
