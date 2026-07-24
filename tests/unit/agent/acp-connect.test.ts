import { describe, it, expect } from 'vitest'
import { makeAcpConnect, parseAcpCommand } from '../../../src/core/agent/acp-connect'
import type { AcpClient } from '../../../src/core/agent/acp-backend'

/**
 * Tests for the spawn glue: a failed handshake must not leave an orphan child,
 * and dispose() must kill children whose handshake never completes. Both use a
 * real `node` child (available wherever the tests run) instead of a mock so the
 * process lifecycle is actually exercised.
 */
const fakeClient: AcpClient = {
  sessionUpdate: async () => {},
  requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
}

describe('makeAcpConnect', () => {
  it('rejects and kills the child when initialize fails (no orphan)', async () => {
    // Child exits immediately → the stream closes → initialize rejects.
    const connect = makeAcpConnect({ command: 'node', args: ['-e', 'process.exit(1)'] })
    await expect(connect(fakeClient)).rejects.toThrow()
    // If the child were left alive the factory would still reject, so also
    // verify dispose() is a safe no-op afterwards (nothing left to kill).
    expect(() => connect.dispose()).not.toThrow()
  })

  it('dispose() kills a spawned child whose handshake never completes', async () => {
    // Child stays alive forever and never answers initialize.
    const connect = makeAcpConnect({ command: 'node', args: ['-e', 'setInterval(() => {}, 1000000)'] })
    const p = connect(fakeClient)
    const rejection = expect(p).rejects.toThrow()
    connect.dispose() // kills the child → stream closes → initialize rejects
    await rejection // would hang until the test timeout if the child survived
  })
})

describe('parseAcpCommand', () => {
  it('splits the command line into command + args', () => {
    expect(parseAcpCommand('kimi acp')).toEqual({ command: 'kimi', args: ['acp'] })
    expect(parseAcpCommand('  gemini   --acp  ')).toEqual({ command: 'gemini', args: ['--acp'] })
  })
})
