import { describe, it, expect, vi } from 'vitest'
import { buildServer } from '../../../src/transport/web/server'
import { createTokenAuth } from '../../../src/connectivity/auth/token'
import { singleBackendRegistry } from '../../../src/core/agent/registry'
import { cardsFromMessages } from '../../../src/core/history'

function fakeState() {
  return {
    getSessionCost: () => undefined,
    setSessionCost: vi.fn(),
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
    hasActiveGeneration: () => false,
  } as any
}

function backendWithHistory(cards: any[]) {
  return {
    id: 'opencode',
    capabilities: { liveMirror: false },
    listSessionSummaries: vi.fn().mockResolvedValue([]),
    listSessions: vi.fn().mockResolvedValue([]),
    getHistory: vi.fn().mockResolvedValue(cards),
    hasSession: vi.fn().mockResolvedValue(true),
    ping: vi.fn().mockResolvedValue(true),
  } as any
}

function appWith(backend: any) {
  return buildServer({
    auth: createTokenAuth({ token: 'test-token', devBypass: true, devEmail: 'd@l', host: '127.0.0.1' }),
    registry: singleBackendRegistry(backend),
    state: fakeState(),
    cardBus: { publish: vi.fn(), subscribeAll: () => () => {}, currentSeq: () => 3 } as any,
  } as any)
}

const LOOPBACK = { incoming: { socket: { remoteAddress: '127.0.0.1' } } }
const card = (n: number) => ({ kind: 'user', sessionId: 'ses_a', text: `m${n}`, ts: n })

describe('GET /api/session/:id offset pagination', () => {
  it('passes offset through to the backend and reports hasMore for a full page', async () => {
    const backend = backendWithHistory([card(1), card(2)])
    const app = appWith(backend)
    const res = await app.request('/api/session/ses_a?limit=2&offset=50', undefined, LOOPBACK)
    const json = await res.json() as any
    expect(backend.getHistory).toHaveBeenCalledWith('ses_a', 2, 50)
    expect(json.cards).toHaveLength(2)
    expect(json.lastSeq).toBe(3)
    expect(json.hasMore).toBe(true) // cards.length >= limit
  })

  it('hasMore=false when the page comes back short', async () => {
    const app = appWith(backendWithHistory([card(1)]))
    const res = await app.request('/api/session/ses_a?limit=50', undefined, LOOPBACK)
    expect((await res.json() as any).hasMore).toBe(false)
  })

  it('clamps offset into 0..2000 and tolerates garbage', async () => {
    const backend = backendWithHistory([])
    const app = appWith(backend)
    await app.request('/api/session/ses_a?offset=99999', undefined, LOOPBACK)
    expect(backend.getHistory).toHaveBeenLastCalledWith('ses_a', undefined, 2000)
    await app.request('/api/session/ses_a?offset=abc', undefined, LOOPBACK)
    expect(backend.getHistory).toHaveBeenLastCalledWith('ses_a', undefined, 0)
  })
})

describe('cardsFromMessages offset windowing', () => {
  const messages = Array.from({ length: 10 }, (_, i) => ({
    info: { id: `msg_${i}`, role: 'user', time: { created: i } },
    parts: [{ type: 'text', text: `m${i}` }],
  }))

  it('offset=0 keeps the default tail window', () => {
    expect(cardsFromMessages('s', messages, 4).map((c: any) => c.text)).toEqual(['m6', 'm7', 'm8', 'm9'])
  })

  it('offset pages backwards without overlap', () => {
    expect(cardsFromMessages('s', messages, 4, 2).map((c: any) => c.text)).toEqual(['m4', 'm5', 'm6', 'm7'])
    // Start clamps at 0 — the earliest page keeps its full width.
    expect(cardsFromMessages('s', messages, 4, 6).map((c: any) => c.text)).toEqual(['m0', 'm1', 'm2', 'm3'])
  })

  it('offset beyond the conversation start yields an empty page (client stops)', () => {
    expect(cardsFromMessages('s', messages, 4, 99)).toEqual([])
  })
})
