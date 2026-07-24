import { describe, it, expect, vi } from 'vitest'

vi.mock('@opencode-ai/sdk', () => ({
  createOpencodeServer: vi.fn(),
  createOpencodeClient: vi.fn().mockReturnValue({}),
}))

import { createOpencodeServer } from '@opencode-ai/sdk'
import { parseBackendsSpec, buildHostBackends } from '../../src/cli/host-backends'

describe('parseBackendsSpec', () => {
  it('falls back to a single ACP backend from OCRC_ACP_CMD when empty', () => {
    expect(parseBackendsSpec('', 'kimi acp')).toEqual([{ id: 'acp:kimi', kind: 'acp', command: 'kimi acp' }])
  })

  it('parses opencode + a named acp backend', () => {
    expect(parseBackendsSpec('opencode, kimi=kimi acp', 'x')).toEqual([
      { id: 'opencode', kind: 'opencode' },
      { id: 'acp:kimi', kind: 'acp', command: 'kimi acp' },
    ])
  })

  it('keeps an id that already has a namespace prefix', () => {
    expect(parseBackendsSpec('acp:gemini=gemini --acp', 'x')).toEqual([
      { id: 'acp:gemini', kind: 'acp', command: 'gemini --acp' },
    ])
  })

  it('treats a bare command (no =) as an acp backend keyed by its binary', () => {
    expect(parseBackendsSpec('gemini --acp', 'x')).toEqual([
      { id: 'acp:gemini', kind: 'acp', command: 'gemini --acp' },
    ])
  })

  it('ignores blank entries and whitespace', () => {
    expect(parseBackendsSpec(' opencode ,  , kimi=kimi acp ', 'x').map((b) => b.id)).toEqual(['opencode', 'acp:kimi'])
  })
})

describe('buildHostBackends opencode port fallback', () => {
  const deps = { cwd: process.cwd(), onAcpPermission: async () => null }

  it('probes the next port when the base port is taken', async () => {
    const mock = vi.mocked(createOpencodeServer)
    mock.mockReset()
    mock.mockRejectedValueOnce(new Error('listen EADDRINUSE 127.0.0.1:4096'))
    mock.mockResolvedValueOnce({ url: 'http://127.0.0.1:4097', close: vi.fn() } as any)

    const built = await buildHostBackends([{ id: 'opencode', kind: 'opencode' }], deps)

    expect(mock).toHaveBeenCalledTimes(2)
    expect((mock.mock.calls[0][0] as any).port).toBe(4096)
    expect((mock.mock.calls[1][0] as any).port).toBe(4097)
    expect(built.backends.map((b) => b.id)).toEqual(['opencode'])
  })

  it('gives up on the backend after exhausting the probe range', async () => {
    const mock = vi.mocked(createOpencodeServer)
    mock.mockReset()
    mock.mockRejectedValue(new Error('EADDRINUSE'))

    await expect(
      buildHostBackends([{ id: 'opencode', kind: 'opencode' }], deps),
    ).rejects.toThrow('no backends could be started')
    expect(mock).toHaveBeenCalledTimes(10)
  })
})
