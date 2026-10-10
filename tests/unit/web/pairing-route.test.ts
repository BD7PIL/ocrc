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
  const auth = createTokenAuth({ token, devBypass: false, devEmail: 'd@l', host: '127.0.0.1', sessions: pairing })
  return buildServer({
    auth,
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
const LAN = { incoming: { socket: { remoteAddress: '192.168.26.5' } } }
// Loopback peer + devBypass OFF: requests still need the Bearer token.
const authed = (t: string) => ({ headers: { authorization: `Bearer ${t}` }, ...LOOPBACK })

describe('P-remote session lifecycle routes (auth-gated)', () => {
  // buildServer-mounted session routes sit behind the auth guard (401 test
  // below). The peer-dependent happy path runs on a direct-mounted app with an
  // injected loopback peer — `app.request()` cannot fake the socket.
  async function mountSessionApp(store: ReturnType<typeof createPairingStore>) {
    const { Hono } = await import('hono')
    const { registerPairSession } = await import('../../../src/transport/web/routes/pairing')
    const app = new Hono()
    registerPairSession(app, { pairing: store, auth: { sessionsAccepted: true } as any, getPeer: () => '127.0.0.1' })
    return app
  }

  it('start → exchange (session credential, multi-use) → refresh kicks phones → stop', async () => {
    const store = createPairingStore()
    const app = appWith(store, 'test-token-0123456789abcdef')
    const sess = await mountSessionApp(store)

    // off → exchange dead
    const off = await app.request('/api/pair/exchange', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pending: 'x' }), ...LOOPBACK,
    } as any)
    expect(off.status).toBe(404)

    const start = await sess.request('/api/pair/session/start', { method: 'POST' })
    expect(start.status).toBe(200)
    const startBody = await start.json() as any
    expect(startBody.active).toBe(true)
    expect(startBody.epoch).toBe(1)

    // onboarding now renders a QR; the pending is multi-use
    const ob = await app.request('/api/pair/onboarding', { ...LOOPBACK })
    const obBody = await ob.json() as any
    expect(obBody.status).toBe('on')
    expect(obBody.url).toContain('#pair=')
    expect(obBody.svg).toContain('<svg')
    const pending = obBody.url.split('#pair=')[1]

    const ex1 = await app.request('/api/pair/exchange', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pending }), ...LOOPBACK,
    } as any)
    const ex2 = await app.request('/api/pair/exchange', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pending }), ...LOOPBACK,
    } as any)
    expect(ex1.status).toBe(200)
    expect(ex2.status).toBe(200)
    const cred1 = (await ex1.json() as any).token
    const cred2 = (await ex2.json() as any).token
    expect(cred1).toBeTruthy()
    expect(cred2).toBeTruthy()
    expect(cred1).not.toBe(cred2) // per-device credentials
    // a session credential authorizes like a token (middleware hook)
    const probe = await app.request('/api/me', { headers: { authorization: `Bearer ${cred1}` }, ...LAN })
    expect(probe.status).toBe(200)

    // refresh → credentials die, pending rotates
    const ref = await sess.request('/api/pair/session/refresh', { method: 'POST' })
    const refBody = await ref.json() as any
    expect(refBody.epoch).toBe(2)
    expect(refBody.paired).toBe(0)
    const stale = await app.request('/api/pair/exchange', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pending }), ...LOOPBACK,
    } as any)
    expect(stale.status).toBe(404) // old-epoch pending dead
    const kicked = await app.request('/api/me', { headers: { authorization: `Bearer ${cred1}` }, ...LAN })
    expect(kicked.status).toBe(401) // refresh kicked the phone

    // stop → gate closed; onboarding reports off
    const stop = await sess.request('/api/pair/session/stop', { method: 'POST' })
    expect((await stop.json() as any).active).toBe(false)
    const obOff = await app.request('/api/pair/onboarding', { ...LOOPBACK })
    expect((await obOff.json() as any).status).toBe('off')
  })

  it('session endpoints require auth at all (no token → 401, before any loopback logic)', async () => {
    const store = createPairingStore()
    const app = appWith(store, 'test-token-0123456789abcdef')
    const res = await app.request('/api/pair/session/start', { method: 'POST', ...LOOPBACK })
    expect(res.status).toBe(401)
  })

  it('GET /api/pair/qr while the session is off → 409 (closed gate renders no QR)', async () => {
    const store = createPairingStore()
    const app = appWith(store, 'test-token-0123456789abcdef')
    const res = await app.request('/api/pair/qr', authed('test-token-0123456789abcdef'))
    expect(res.status).toBe(409)
    store.start()
    const ok = await app.request('/api/pair/qr', authed('test-token-0123456789abcdef'))
    expect(ok.status).toBe(200)
    expect(((await ok.json() as any).url as string)).toContain('#pair=')
  })

  it('onboarding reports status off with channels payload BEFORE any session', async () => {
    vi.stubEnv('WEB_TOKEN', 'test-token-0123456789abcdef')
    try {
      const store = createPairingStore()
      const app = appWith(store, 'test-token-0123456789abcdef')
      const res = await app.request('/api/pair/onboarding', { ...LOOPBACK })
      const body = await res.json() as any
      expect(body.status).toBe('off')
      expect(body.url).toBeUndefined()
      expect(body.svg).toBeUndefined()
      expect(Array.isArray(body.channels)).toBe(true)
      expect(body.host.hostname).toBeTruthy()
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

// `app.request()` cannot fake the socket peer, so the loopback gate is unit-
// tested by mounting registerPairSession directly with an injected getPeer —
// in production the peer comes from the node adapter (c.env.incoming).
describe('P-remote loopback gate + strategy support (registerPairSession direct)', () => {
  async function sessionApp(peer: string, opts: { sessionsAccepted?: boolean } = {}) {
    const { Hono } = await import('hono')
    const { registerPairSession } = await import('../../../src/transport/web/routes/pairing')
    const store = createPairingStore()
    const auth = {
      sessionsAccepted: opts.sessionsAccepted ?? true,
      rotate: () => {},
    } as any
    const app = new Hono()
    app.use('/api/*', (c, next) => { c.set('user', { email: 'd@l', sub: 'token' }); return next() }) // auth pre-passed
    registerPairSession(app, { pairing: store, auth, getPeer: () => peer })
    return { app, store }
  }

  it('loopback peer may start/refresh/stop', async () => {
    const { app, store } = await sessionApp('127.0.0.1')
    expect((await app.request('/api/pair/session/start', { method: 'POST' })).status).toBe(200)
    expect(store.status().active).toBe(true)
    expect((await app.request('/api/pair/session/stop', { method: 'POST' })).status).toBe(200)
    expect(store.status().active).toBe(false)
  })

  it('IPv4-mapped and ::1 loopback spellings pass', async () => {
    const { app } = await sessionApp('::ffff:127.0.0.1')
    expect((await app.request('/api/pair/session/start', { method: 'POST' })).status).toBe(200)
    const { app: v6 } = await sessionApp('::1')
    expect((await v6.request('/api/pair/session/refresh', { method: 'POST' })).status).toBe(200)
  })

  it('LAN peer gets 403 on mutations; status stays readable', async () => {
    const { app, store } = await sessionApp('192.168.26.5')
    const mut = await app.request('/api/pair/session/start', { method: 'POST' })
    expect(mut.status).toBe(403)
    expect((await mut.json() as any).error).toContain('loopback')
    expect(store.status().active).toBe(false)
    const read = await app.request('/api/pair/session/status', { method: 'POST' })
    expect(read.status).toBe(200)
  })

  it('session credential as Bearer still cannot mutate from LAN', async () => {
    const { app, store } = await sessionApp('192.168.26.5')
    store.start()
    const cred = store.exchange(store.issue()!.token)!
    const mut = await app.request('/api/pair/session/stop', { method: 'POST', headers: { authorization: `Bearer ${cred}` } })
    expect(mut.status).toBe(403)
    expect(store.status().active).toBe(true)
  })

  it('CF Access strategy (sessionsAccepted missing) → 409 on every session route', async () => {
    const { app } = await sessionApp('127.0.0.1', { sessionsAccepted: false })
    for (const op of ['start', 'refresh', 'stop']) {
      const res = await app.request(`/api/pair/session/${op}`, { method: 'POST' })
      expect(res.status).toBe(409)
    }
  })

  it('status carries the paired count of the live epoch', async () => {
    const { app, store } = await sessionApp('127.0.0.1')
    store.start()
    store.exchange(store.issue()!.token)
    store.exchange(store.issue()!.token)
    const body = (await (await app.request('/api/pair/session/status', { method: 'POST' })).json()) as any
    expect(body.paired).toBe(2)
    expect(body.active).toBe(true)
  })
})

describe('M11 routes retained under session semantics', () => {  it('POST /api/pair/exchange stays reachable WITHOUT a token; bad shape → 400', async () => {
    const store = createPairingStore()
    const app = appWith(store)
    store.start()
    const noBody = await app.request('/api/pair/exchange', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}), ...LOOPBACK,
    } as any)
    expect(noBody.status).toBe(400)
  })

  it('without a pairing store the QR falls back to the legacy #token= URL', async () => {
    vi.stubEnv('WEB_TOKEN', 'test-token-0123456789abcdef')
    try {
      const app = appWith(undefined, 'test-token-0123456789abcdef')
      const qr = await app.request('/api/pair/qr', authed('test-token-0123456789abcdef'))
      const body = await qr.json() as any
      expect(body.url).toContain('#token=test-token-0123456789abcdef')
      expect(body.expiresAt).toBeUndefined()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('POST /api/pair/reset rotates and closes the session', async () => {
    const tmpToken = `/tmp/ocrc-test-${Date.now()}-reset/token`
    const auth = createTokenAuth({ tokenPath: tmpToken, devEmail: 'd@l', host: '127.0.0.1', sessions: undefined })
    const store = createPairingStore()
    store.start()
    const app = buildServer({
      auth,
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
      pairing: store,
    } as any)
    const token = (await import('node:fs')).readFileSync(tmpToken, 'utf-8').trim()
    const res = await app.request('/api/pair/reset', { method: 'POST', ...authed(token) })
    expect(res.status).toBe(200)
    expect(store.status().active).toBe(false) // session closed with the rotation
  })
})
