import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadOrCreateToken, createTokenAuth } from '../../../src/connectivity/auth/token'

const tmp = mkdtempSync(join(tmpdir(), 'ocrc-token-'))

describe('loadOrCreateToken', () => {
  it('returns an explicit token verbatim', () => {
    expect(loadOrCreateToken({ token: 'abc123' })).toBe('abc123')
  })
  it('generates and persists a token when none exists, then reuses it', () => {
    const path = join(tmp, 'tok')
    const a = loadOrCreateToken({ tokenPath: path })
    expect(a.length).toBeGreaterThan(20)
    expect(readFileSync(path, 'utf-8').trim()).toBe(a)
    const b = loadOrCreateToken({ tokenPath: path })
    expect(b).toBe(a) // reused, not regenerated
  })
  it('reads an existing token file', () => {
    const path = join(tmp, 'tok2')
    writeFileSync(path, 'preset-token\n')
    expect(loadOrCreateToken({ tokenPath: path })).toBe('preset-token')
  })
})

describe('createTokenAuth.verifyUpgrade', () => {
  const auth = createTokenAuth({ token: 'secret', devEmail: 'me@local' })

  it('accepts the token via ?token= query', async () => {
    const u = await auth.verifyUpgrade({ headers: {}, url: '/ws?token=secret' })
    expect(u).toEqual({ email: 'me@local', sub: 'token' })
  })
  it('accepts the token via Authorization Bearer header', async () => {
    const u = await auth.verifyUpgrade({ headers: { authorization: 'Bearer secret' } })
    expect(u).toEqual({ email: 'me@local', sub: 'token' })
  })
  it('accepts the token via ocrc_token cookie', async () => {
    const u = await auth.verifyUpgrade({ headers: { cookie: 'x=1; ocrc_token=secret' } })
    expect(u?.email).toBe('me@local')
  })
  it('rejects a wrong token', async () => {
    expect(await auth.verifyUpgrade({ headers: {}, url: '/ws?token=nope' })).toBeNull()
  })
  it('rejects when no token present', async () => {
    expect(await auth.verifyUpgrade({ headers: {} })).toBeNull()
  })
  it('allows a loopback peer when devBypass is on', async () => {
    const a2 = createTokenAuth({ token: 'secret', devBypass: true, devEmail: 'd@local' })
    const u = await a2.verifyUpgrade({ headers: {}, socket: { remoteAddress: '127.0.0.1' } })
    expect(u?.email).toBe('d@local')
  })
})

describe('createTokenAuth.httpMiddleware', () => {
  function appWith(authOpts: any) {
    const auth = createTokenAuth(authOpts)
    const app = new Hono()
    app.use('*', auth.httpMiddleware())
    app.get('/x', (c) => c.json({ email: (c.get('user') as any)?.email }))
    return app
  }

  it('401s without a token', async () => {
    const res = await appWith({ token: 'secret' }).request('/x')
    expect(res.status).toBe(401)
  })
  it('accepts a Bearer token', async () => {
    const res = await appWith({ token: 'secret', devEmail: 'me@local' })
      .request('/x', { headers: { authorization: 'Bearer secret' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ email: 'me@local' })
  })
  it('accepts an ocrc_token cookie', async () => {
    const res = await appWith({ token: 'secret' })
      .request('/x', { headers: { cookie: 'a=1; ocrc_token=secret' } })
    expect(res.status).toBe(200)
  })
  it('rejects a wrong token', async () => {
    const res = await appWith({ token: 'secret' })
      .request('/x', { headers: { authorization: 'Bearer wrong' } })
    expect(res.status).toBe(401)
  })
  it('rejects a ?token= query on plain HTTP requests (WS-upgrade only)', async () => {
    const res = await appWith({ token: 'secret' }).request('/x?token=secret')
    expect(res.status).toBe(401)
  })
})

describe('createTokenAuth.rotate (revoke all paired devices)', () => {
  it('rotates the file token; old token 401s, new token passes — across processes', async () => {
    const path = join(tmp, 'tok-rotate')
    const auth = createTokenAuth({ tokenPath: path })
    const old = readFileSync(path, 'utf-8').trim()

    const app = new Hono()
    app.use('*', auth.httpMiddleware!())
    app.get('/x', (c) => c.json({ ok: true }))

    // sanity: old token accepted
    expect((await app.request('/x', { headers: { authorization: `Bearer ${old}` } })).status).toBe(200)

    // Another process (ocrc pair --reset) rewrites the file underneath us.
    writeFileSync(path, 'brand-new-token')
    const res = await app.request('/x', { headers: { authorization: `Bearer ${old}` } })
    expect(res.status).toBe(401) // mtime-stale → re-read → old revoked
    expect((await app.request('/x', { headers: { authorization: 'Bearer brand-new-token' } })).status).toBe(200)
  })

  it('in-process auth.rotate() persists and immediately invalidates the old token', async () => {
    const path = join(tmp, 'tok-rotate2')
    const auth = createTokenAuth({ tokenPath: path })
    const old = readFileSync(path, 'utf-8').trim()
    auth.rotate!()

    expect(readFileSync(path, 'utf-8').trim()).not.toBe(old)
    const app = new Hono()
    app.use('*', auth.httpMiddleware())
    app.get('/x', (c) => c.json({ ok: true }))
    expect((await app.request('/x', { headers: { authorization: `Bearer ${old}` } })).status).toBe(401)
  })

  it('refuses to rotate when the token comes from explicit config', () => {
    const auth = createTokenAuth({ token: 'from-config' })
    expect(() => auth.rotate!()).toThrow(/WEB_TOKEN/)
  })
})

// P-remote: the anchor/session split. The token middleware additionally
// accepts live SESSION credentials (never touching the anchor token) when a
// session store is wired — refresh/stop in the store kicks phones without
// any file/config change.
describe('createTokenAuth — remote-control session credentials', () => {
  function fakeStore() {
    const live = new Set<string>()
    return {
      live,
      verifySession: (c: string) => live.has(c),
    }
  }

  it('accepts a live session credential as Bearer + WS upgrade; garbage still rejected', async () => {
    const store = fakeStore()
    const auth = createTokenAuth({ token: 'anchor-secret', sessions: store })
    const app = new Hono()
    app.use('*', auth.httpMiddleware())
    app.get('/x', (c) => c.json({ ok: true }))

    store.live.add('sess-cred-1')
    expect((await app.request('/x', { headers: { authorization: 'Bearer sess-cred-1' } })).status).toBe(200)
    expect(await auth.verifyUpgrade({ headers: {}, url: '/ws?token=sess-cred-1' })).not.toBeNull()
    expect((await app.request('/x', { headers: { authorization: 'Bearer garbage' } })).status).toBe(401)
    expect(await auth.verifyUpgrade({ headers: {}, url: '/ws?token=garbage' })).toBeNull()
  })

  it('refresh/stop semantics: removing the credential from the store revokes the device', async () => {
    const store = fakeStore()
    const auth = createTokenAuth({ token: 'anchor-secret', sessions: store })
    const app = new Hono()
    app.use('*', auth.httpMiddleware())
    app.get('/x', (c) => c.json({ ok: true }))

    store.live.add('ephemeral')
    expect((await app.request('/x', { headers: { authorization: 'Bearer ephemeral' } })).status).toBe(200)
    store.live.clear() // session.refresh()/stop()
    expect((await app.request('/x', { headers: { authorization: 'Bearer ephemeral' } })).status).toBe(401)
    // anchor token unaffected throughout
    expect((await app.request('/x', { headers: { authorization: 'Bearer anchor-secret' } })).status).toBe(200)
  })

  it('no sessions store wired → session-looking credentials are plain 401s', async () => {
    const auth = createTokenAuth({ token: 'anchor-secret' })
    const app = new Hono()
    app.use('*', auth.httpMiddleware())
    app.get('/x', (c) => c.json({ ok: true }))
    expect((await app.request('/x', { headers: { authorization: 'Bearer whatever-cred' } })).status).toBe(401)
  })

  it('session acceptance does not weaken ?token= on plain HTTP (still WS-only)', async () => {
    const store = fakeStore()
    store.live.add('sess-cred-1')
    const auth = createTokenAuth({ token: 'anchor-secret', sessions: store })
    const app = new Hono()
    app.use('*', auth.httpMiddleware())
    app.get('/x', (c) => c.json({ ok: true }))
    const res = await app.request('/x?token=sess-cred-1')
    expect(res.status).toBe(401)
  })
})
