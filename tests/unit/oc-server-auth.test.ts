import { describe, it, expect, vi, afterEach } from 'vitest'
import { ocServerHeaders, ocFetch } from '../../src/utils/oc-server-auth'
import { createOpencodeBackend } from '../../src/core/agent/opencode-backend'

function fakeClient() {
  return {
    session: {
      promptAsync: vi.fn().mockResolvedValue({ data: {} }),
      list: vi.fn().mockResolvedValue({ data: [] }),
      get: vi.fn().mockResolvedValue({ data: {} }),
      message: vi.fn().mockResolvedValue({ data: { parts: [] } }),
      messages: vi.fn().mockResolvedValue({ data: [] }),
      create: vi.fn().mockResolvedValue({ data: { id: 'ses_new' } }),
      delete: vi.fn().mockResolvedValue({ data: {} }),
      update: vi.fn().mockResolvedValue({ data: {} }),
      abort: vi.fn().mockResolvedValue({ data: {} }),
      status: vi.fn().mockResolvedValue({ data: { healthy: true } }),
      diff: vi.fn().mockResolvedValue({ data: [] }),
      todo: vi.fn().mockResolvedValue({ data: [] }),
      command: vi.fn().mockResolvedValue({ data: {} }),
    },
    config: { get: vi.fn().mockResolvedValue({ data: {} }), providers: vi.fn().mockResolvedValue({ data: { providers: [] } }) },
    command: { list: vi.fn().mockResolvedValue({ data: [] }) },
    project: { list: vi.fn().mockResolvedValue({ data: [] }) },
    postSessionIdPermissionsPermissionId: vi.fn().mockResolvedValue({ data: {} }),
  } as any
}

afterEach(() => {
  delete process.env.OPENCODE_SERVER_PASSWORD
  delete process.env.OPENCODE_SERVER_USERNAME
  vi.unstubAllGlobals()
})

describe('ocServerHeaders (HTTP Basic for password-protected opencode)', () => {
  it('returns {} without OPENCODE_SERVER_PASSWORD', () => {
    expect(ocServerHeaders()).toEqual({})
  })

  it('builds grinev-compatible Basic header with default username "opencode"', () => {
    process.env.OPENCODE_SERVER_PASSWORD = 's3cret'
    const h = ocServerHeaders()
    expect(h.Authorization).toBe(`Basic ${Buffer.from('opencode:s3cret').toString('base64')}`)
  })

  it('honors OPENCODE_SERVER_USERNAME', () => {
    process.env.OPENCODE_SERVER_PASSWORD = 'pw'
    process.env.OPENCODE_SERVER_USERNAME = 'alice'
    expect(ocServerHeaders().Authorization).toBe(`Basic ${Buffer.from('alice:pw').toString('base64')}`)
  })
})

describe('raw fetches carry Basic auth when the server has a password', () => {
  it('getSkills attaches the Authorization header', async () => {
    process.env.OPENCODE_SERVER_PASSWORD = 's3cret'
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] })
    vi.stubGlobal('fetch', fetchMock)
    const b = createOpencodeBackend({ client: fakeClient(), baseUrl: 'http://127.0.0.1:4096' })
    await b.getSkills!('/proj')
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('opencode:s3cret').toString('base64')}`)
  })

  it('no password env → no Authorization header (spike/无密码行为不变)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] })
    vi.stubGlobal('fetch', fetchMock)
    const b = createOpencodeBackend({ client: fakeClient(), baseUrl: 'http://127.0.0.1:4096' })
    await b.getSkills!('/proj')
    const init = (fetchMock.mock.calls[0][1] ?? {}) as RequestInit
    expect((init.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined()
  })

  it('preserves request-specific headers (POST body content-type) alongside auth', async () => {
    process.env.OPENCODE_SERVER_PASSWORD = 'pw'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ directory: '/proj' }) })  // session directory resolve
      .mockResolvedValueOnce({ ok: true, json: async () => true })                       // reply POST
    vi.stubGlobal('fetch', fetchMock)
    const b = createOpencodeBackend({ client: fakeClient(), baseUrl: 'http://x' })
    await b.answerQuestion!('ses_1', 'que_1', [['Yes']])
    const init = fetchMock.mock.calls[1][1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('opencode:pw').toString('base64')}`)
    expect(headers['Content-Type']).toBe('application/json')
  })
})
