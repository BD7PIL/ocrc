import { describe, it, expect, vi } from 'vitest'
import { buildServer } from '../../../src/transport/web/server'
import { createTokenAuth } from '../../../src/connectivity/auth/token'
import { singleBackendRegistry } from '../../../src/core/agent/registry'
import { createPairingStore } from '../../../src/connectivity/pairing'

function fakeState() {
  return {
    getSessionCost: () => undefined,
    getLastSessionId: () => 'ses_a',
    getActiveAbort: () => undefined,
    setActiveAbort: vi.fn(),
    getNextAgent: () => undefined,
    getNextModel: () => undefined,
    setNextAgent: vi.fn(),
    setNextModel: vi.fn(),
    getCurrentAgent: () => undefined,
    setCurrentAgent: vi.fn(),
    getTuiSelectedSession: () => undefined,
    setTuiSelectedSession: vi.fn(),
    setLastSessionId: vi.fn(),
    getSessionBackend: () => undefined,
    getActiveBackend: () => undefined,
    flush: async () => {},
    normalizeSessionId: (id: string) => id,
  } as any
}

function appWith(pairing?: ReturnType<typeof createPairingStore>, token = 'test-token-0123456789abcdef') {
  return buildServer({
    auth: createTokenAuth({ token, devBypass: false, devEmail: 'd@l', host: '127.0.0.1' }),
    registry: singleBackendRegistry({
      id: 'opencode',
      capabilities: { liveMirror: false },
      listSessionSummaries: vi.fn().mockResolvedValue([]),
      listSessions: vi.fn().mockResolvedValue([]),
      hasSession: vi.fn().mockResolvedValue(true),
      ping: vi.fn().mockResolvedValue(true),
    }),
    state: fakeState(),
    cardBus: { publish: vi.fn(), subscribeAll: () => () => {}, currentSeq: () => 0 } as any,
    pairing,
  } as any)
}

const LOOPBACK = { incoming: { socket: { remoteAddress: '127.0.0.1' } } }
// Loopback peer + devBypass OFF: requests still need the Bearer token.
const authed = (t: string) => ({ headers: { authorization: `Bearer ${t}` }, ...LOOPBACK })

describe('M11 pairing routes', () => {
  it('POST /api/pair/exchange is reachable WITHOUT a token and honors pending semantics', async () => {
    const store = createPairingStore(() => 'real-token-0123456789abcdef')
    const app = appWith(store)
    const p = store.issue()
    // No Authorization header at all — the pending token is the credential.
    const res = await app.request('/api/pair/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pending: p.token }),
      ...LOOPBACK,
    } as any)
    expect(res.status).toBe(200)
    expect((await res.json() as any).token).toBe('real-token-0123456789abcdef')
    // Single-use: replay is 404.
    const again = await app.request('/api/pair/exchange', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pending: p.token }), ...LOOPBACK,
    } as any)
    expect(again.status).toBe(404)
  })

  it('GET /api/pair/qr issues a #pair= URL with expiry; exchange round-trips', async () => {
    const store = createPairingStore(() => 'real-token-0123456789abcdef')
    const app = appWith(store, 'real-token-0123456789abcdef')
    const qr = await app.request('/api/pair/qr', authed('real-token-0123456789abcdef'))
    const body = await qr.json() as any
    expect(body.url).toContain('#pair=')
    expect(body.expiresAt).toBeGreaterThan(Date.now())
    expect(body.svg).toContain('<svg')
    const pending = body.url.split('#pair=')[1]
    const ex = await app.request('/api/pair/exchange', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pending }), ...LOOPBACK,
    } as any)
    expect((await ex.json() as any).token).toBe('real-token-0123456789abcdef')
  })

  it('issuing a second QR invalidates the first pending', async () => {
    const store = createPairingStore(() => 'real-token-0123456789abcdef')
    const app = appWith(store, 'real-token-0123456789abcdef')
    const q1 = (await (await app.request('/api/pair/qr', authed('real-token-0123456789abcdef'))).json() as any).url
    const q2 = (await (await app.request('/api/pair/qr', authed('real-token-0123456789abcdef'))).json() as any).url
    const ex1 = await app.request('/api/pair/exchange', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pending: q1.split('#pair=')[1] }), ...LOOPBACK,
    } as any)
    expect(ex1.status).toBe(404)
    const ex2 = await app.request('/api/pair/exchange', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pending: q2.split('#pair=')[1] }), ...LOOPBACK,
    } as any)
    expect(ex2.status).toBe(200)
  })

  it('without a pairing store the QR falls back to the legacy #token= URL', async () => {
    // buildPairContext reads WEB_TOKEN — pin it so the test never touches ~/.ocrc.
    vi.stubEnv('WEB_TOKEN', 'real-token-0123456789abcdef')
    try {
      const app = appWith(undefined, 'real-token-0123456789abcdef')
      const qr = await app.request('/api/pair/qr', authed('real-token-0123456789abcdef'))
      const body = await qr.json() as any
      expect(body.url).toContain('#token=real-token-0123456789abcdef')
      expect(body.expiresAt).toBeUndefined()
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
