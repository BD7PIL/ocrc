import { describe, it, expect, vi, afterEach } from 'vitest'
import { Hono } from 'hono'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerChannels } from '../../../src/transport/web/routes/channels'
import { createChannelsStore } from '../../../src/core/channels'

afterEach(() => {
  vi.unstubAllGlobals()
})

function app(meta?: { hasEnvToken: boolean; allowUsers: number; envTokenHint?: string }) {
  const store = createChannelsStore(join(mkdtempSync(join(tmpdir(), 'ocrc-chtest-')), 'channels.json'))
  const a = new Hono()
  registerChannels(a, store, () => ({ connected: true, username: 'my_ocrc_bot' }), meta)
  return { a, store }
}

describe('channels route — credential redaction + validation (0.27)', () => {
  it('GET redacts credentials (write-only) and exposes binding info', async () => {
    const { a, store } = app({ hasEnvToken: true, allowUsers: 2 })
    store.update('tg-default', { credentials: { token: '123456:ABCDEF-secret' } })

    const res = await a.request('/api/channels')
    const body = await res.json() as any

    const tg = body.channels.find((c: any) => c.id === 'tg-default')
    // redacted echo: values become last-4 hints, never the raw token
    expect(tg.credentials).toEqual({ token: '••••cret' })
    expect(JSON.stringify(body)).not.toContain('ABCDEF-secret')
    expect(tg.hasToken).toBe(true)
    expect(tg.tokenHint).toBe('••••cret')
    expect(JSON.stringify(body)).not.toContain('ABCDEF-secret')
    expect(tg.live).toEqual({ connected: true, username: 'my_ocrc_bot' })
    expect(body.telegram).toEqual({ tokenSource: 'panel', allowSource: 'env', allowUsers: 2, proxySource: 'none' })
  })

  it('tokenSource reflects env when no panel credential is set', async () => {
    const { a } = app({ hasEnvToken: true, allowUsers: 1 })
    const body = await (await a.request('/api/channels')).json() as any
    expect(body.telegram.tokenSource).toBe('env')
  })

  it('envTokenHint is exposed only when the env token wins (no panel credential)', async () => {
    const { a } = app({ hasEnvToken: true, allowUsers: 1, envTokenHint: '••••Xw42' })
    const body = await (await a.request('/api/channels')).json() as any
    expect(body.telegram.tokenSource).toBe('env')
    expect(body.telegram.envTokenHint).toBe('••••Xw42')

    // A panel credential takes precedence — the env hint must disappear.
    const { a: a2, store } = app({ hasEnvToken: true, allowUsers: 1, envTokenHint: '••••Xw42' })
    store.update('tg-default', { credentials: { token: '123456:panel-secret' } })
    const body2 = await (await a2.request('/api/channels')).json() as any
    expect(body2.telegram.tokenSource).toBe('panel')
    expect(body2.telegram.envTokenHint).toBeUndefined()
  })

  it('PATCH with a Telegram-VALID token saves it (getMe mocked ok)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { username: 'new_bot' } }), { status: 200 })))
    const { a } = app({ hasEnvToken: true, allowUsers: 1 })

    const res = await a.request('/api/channels/tg-default', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credentials: { token: '111:valid' } }),
    })
    const body = await res.json() as any
    expect(res.status).toBe(200)
    expect(body.warning).toBeUndefined()
    expect(body.channel.hasToken).toBe(true)
    expect(body.channel.credentials).toEqual({ token: '••••alid' })
  })

  it('PATCH with a token Telegram REJECTS returns 400 and does not save', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, description: 'Unauthorized' }), { status: 401 })))
    const { a, store } = app({ hasEnvToken: true, allowUsers: 1 })

    const res = await a.request('/api/channels/tg-default', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credentials: { token: '111:bad' } }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toContain('Unauthorized')
    // nothing was persisted
    expect(store.get('tg-default')?.credentials?.token).toBeUndefined()
  })

  it('network failure during validation saves with a warning (air-gap tolerant)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connect ETIMEDOUT') }))
    const { a, store } = app({ hasEnvToken: true, allowUsers: 1 })

    const res = await a.request('/api/channels/tg-default', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credentials: { token: '111:offline-valid' } }),
    })
    const body = await res.json() as any
    expect(res.status).toBe(200)
    expect(body.warning).toContain('无法连通 Telegram')
    expect(store.get('tg-default')?.credentials?.token).toBe('111:offline-valid')
  })

  it('granularity validation still rejects bad values', async () => {
    const { a } = app()
    const res = await a.request('/api/channels/tg-default', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ replyGranularity: 'verbose' }),
    })
    expect(res.status).toBe(400)
  })

  // ── allowlist editing (0.27) ──────────────────────────────────────────────

  it('PATCH allowUsers validates shape and dedupes; GET exposes it + allowSource panel', async () => {
    const { a, store } = app({ hasEnvToken: true, allowUsers: 1 })

    const bad = await a.request('/api/channels/tg-default', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allowUsers: [123, 'abc'] }),
    })
    expect(bad.status).toBe(400)
    const neg = await a.request('/api/channels/tg-default', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allowUsers: [-5] }),
    })
    expect(neg.status).toBe(400)

    const ok = await a.request('/api/channels/tg-default', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allowUsers: [123, 456, 123] }),
    })
    expect(ok.status).toBe(200)
    // deduped on persist
    expect(store.get('tg-default')?.allowUsers).toEqual([123, 456])

    const body = await (await a.request('/api/channels')).json() as any
    const tg = body.channels.find((c: any) => c.id === 'tg-default')
    expect(tg.allowUsers).toEqual([123, 456])
    // effective list follows the panel-wins precedence
    expect(body.telegram.allowUsers).toBe(2)
    expect(body.telegram.allowSource).toBe('panel')
  })

  it('reset clears the panel allowlist → allowSource falls back to env', async () => {
    const { a, store } = app({ hasEnvToken: true, allowUsers: 3 })
    await a.request('/api/channels/tg-default', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allowUsers: [777] }),
    })
    await a.request('/api/channels/tg-default/reset', { method: 'POST' })

    expect(store.get('tg-default')?.allowUsers).toBeUndefined()
    const body = await (await a.request('/api/channels')).json() as any
    expect(body.telegram.allowSource).toBe('env')
    expect(body.telegram.allowUsers).toBe(3)
  })
})
