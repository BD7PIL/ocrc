import { describe, it, expect, afterEach } from 'vitest'
import net from 'node:net'
import { portOwner } from '../../src/cli/service'

afterEach(() => {
  // no globals mutated
})

describe('portOwner (C1 cross-platform probe)', () => {
  /** Bind port 0 to learn a free port, then release it. */
  const freePort = async (): Promise<number> => {
    const srv = net.createServer()
    const port = await new Promise<number>((resolve) => {
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address()
        if (!addr || typeof addr === 'string') throw new Error('no addr')
        resolve(addr.port)
      })
    })
    await new Promise((r) => srv.close(r))
    return port
  }

  it('returns null for a FREE port (we can bind it)', async () => {
    // A released ephemeral port can be claimed by anything else in the
    // meantime — vitest's own workers included — so retry with fresh
    // candidates instead of betting the assertion on a single one. Asserting on
    // one flaked on the coverage pass, where everything runs slower.
    let owner: Awaited<ReturnType<typeof portOwner>> = null
    for (let attempt = 0; attempt < 5; attempt++) {
      owner = await portOwner(String(await freePort()))
      if (owner === null) break
    }
    expect(owner).toBeNull()
  })

  it('returns {pid} (pid may be null off-Linux) for an OWNED port', async () => {
    const srv = net.createServer(() => {})
    const port = await new Promise<number>((resolve) => {
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address()
        if (!addr || typeof addr === 'string') throw new Error('no addr')
        resolve(addr.port)
      })
    })
    try {
      const owner = await portOwner(String(port))
      expect(owner).not.toBeNull()
      expect(owner?.pid).toBeDefined()
      if (process.platform === 'linux') {
        // ss bonus read: the pid should be OUR test process's? No — the
        // listener is a child socket of this process; ss reports this pid.
        expect(owner?.pid).toBeTypeOf('number')
      }
    } finally {
      await new Promise((r) => srv.close(r))
    }
  })
})
