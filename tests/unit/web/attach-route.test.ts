// P0-3 — the host channel an ATTACHED plugin talks to. Thin by design: status,
// a card publish on the HOST's bus, and the opt-in echo probe. The probe matters
// because the run id comes back from the host — that is the evidence that the
// call really crossed into the host and that ids are host-assigned.
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { createCardBus } from '../../../src/core/card-bus'
import { registerAttach } from '../../../src/transport/web/routes/attach'

function makeApp(over: { probe?: boolean; telegram?: () => { connected: boolean; username?: string } | null } = {}) {
  const app = new Hono()
  const cardBus = createCardBus()
  const cards: any[] = []
  cardBus.subscribeAll((c) => cards.push(c))
  registerAttach(app, {
    cardBus,
    telegramStatus: over.telegram ?? (() => ({ connected: true, username: 'ocrc_bot' })),
    webPort: 4199,
    probe: over.probe === true,
  })
  return { app, cards }
}

describe('POST /api/attach/notify', () => {
  it('publishes the notification on the host bus', async () => {
    const { app, cards } = makeApp()
    const res = await app.request('/api/attach/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'build finished', sessionId: 'ses_1' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ kind: 'info', sessionId: 'ses_1' })
    expect(cards[0].sections[0].body).toBe('🔔 build finished')
  })

  it('omits sessionId when the caller has none', async () => {
    const { app, cards } = makeApp()
    await app.request('/api/attach/notify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'hi' }),
    })
    expect(cards[0].sessionId).toBeUndefined()
  })

  it('rejects an empty message instead of publishing an empty card', async () => {
    const { app, cards } = makeApp()
    const res = await app.request('/api/attach/notify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '   ' }),
    })
    expect(res.status).toBe(400)
    expect(cards).toHaveLength(0)
  })
})

describe('GET /api/attach/status', () => {
  it('reports the host identity, not the caller', async () => {
    const { app } = makeApp()
    const body = await (await app.request('/api/attach/status')).json() as any
    expect(body.mode).toBe('host')
    expect(body.pid).toBe(process.pid)
    expect(body.webPort).toBe(4199)
    expect(body.telegram).toEqual({ connected: true, username: 'ocrc_bot' })
    expect(typeof body.version).toBe('string')
  })

  it('reports telegram null when the host has no bot', async () => {
    const { app } = makeApp({ telegram: () => null })
    const body = await (await app.request('/api/attach/status')).json() as any
    expect(body.telegram).toBeNull()
  })
})

describe('POST /api/attach/echo (probe)', () => {
  it('is absent unless the probe is enabled', async () => {
    const { app } = makeApp()
    expect((await app.request('/api/attach/echo', { method: 'POST', body: '{}' })).status).toBe(404)
  })

  it('echoes the value and returns a host-assigned run id', async () => {
    const { app } = makeApp({ probe: true })
    const res = await app.request('/api/attach/echo', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: 'ping' }),
    })
    const body = await res.json() as any
    expect(body.ok).toBe(true)
    expect(body.value).toBe('ping')
    expect(body.hostPid).toBe(process.pid)
    expect(body.runId).toMatch(new RegExp(`^host-${process.pid}-\\d+$`))
  })

  it('hands out a distinct run id per call (the plugin sends none)', async () => {
    const { app } = makeApp({ probe: true })
    const post = async () => ((await (await app.request('/api/attach/echo', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: 'x' }),
    })).json()) as any).runId
    const [a, b] = [await post(), await post()]
    expect(a).not.toBe(b)
  })
})
