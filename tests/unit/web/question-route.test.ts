import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildServer } from '../../../src/transport/web/server'
import { createTokenAuth } from '../../../src/connectivity/auth/token'
import { singleBackendRegistry } from '../../../src/core/agent/registry'

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

function appWith(backend: any) {
  return buildServer({
    auth: createTokenAuth({ token: 'test-token', devBypass: true, devEmail: 'd@l', host: '127.0.0.1' }),
    registry: singleBackendRegistry(backend),
    state: fakeState(),
    cardBus: { publish: vi.fn(), subscribeAll: () => () => {}, currentSeq: () => 0 } as any,
  } as any)
}

const LOOPBACK = { incoming: { socket: { remoteAddress: '127.0.0.1' } } }
const post = (app: any, path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...LOOPBACK,
  } as any)

describe('POST /api/question/reply|reject', () => {
  let backend: any
  beforeEach(() => {
    backend = {
      id: 'opencode',
      capabilities: { liveMirror: false },
      listSessionSummaries: vi.fn().mockResolvedValue([]),
      listSessions: vi.fn().mockResolvedValue([]),
      hasSession: vi.fn().mockResolvedValue(true),
      ping: vi.fn().mockResolvedValue(true),
      answerQuestion: vi.fn().mockResolvedValue({ ok: true }),
      rejectQuestion: vi.fn().mockResolvedValue({ ok: false, stale: true }),
    }
  })

  it('forwards answers to backend.answerQuestion', async () => {
    const app = appWith(backend)
    const res = await post(app, '/api/question/reply', { sessionId: 'ses_a', requestId: 'que_1', answers: [['Yes']] })
    expect(await res.json()).toEqual({ ok: true })
    expect(backend.answerQuestion).toHaveBeenCalledWith('ses_a', 'que_1', [['Yes']])
  })

  it('forwards reject', async () => {
    const app = appWith(backend)
    const res = await post(app, '/api/question/reject', { sessionId: 'ses_a', requestId: 'que_1' })
    expect(await res.json()).toEqual({ ok: false, stale: true })
    expect(backend.rejectQuestion).toHaveBeenCalledWith('ses_a', 'que_1')
  })

  it('400s on missing fields or malformed answers', async () => {
    const app = appWith(backend)
    expect((await post(app, '/api/question/reply', { requestId: 'q', answers: [] })).status).toBe(400)
    expect((await post(app, '/api/question/reply', { sessionId: 's', answers: 'no' })).status).toBe(400)
    expect((await post(app, '/api/question/reply', { sessionId: 's', requestId: 'q', answers: [['ok', 5]] })).status).toBe(400)
    expect((await post(app, '/api/question/reject', { sessionId: 's' })).status).toBe(400)
    expect(backend.answerQuestion).not.toHaveBeenCalled()
  })

  it('400s unsupported when the backend lacks the methods', async () => {
    delete backend.answerQuestion
    delete backend.rejectQuestion
    const app = appWith(backend)
    const r1 = await post(app, '/api/question/reply', { sessionId: 's', requestId: 'q', answers: [['x']] })
    expect(await r1.json()).toEqual({ error: 'unsupported' })
    const r2 = await post(app, '/api/question/reject', { sessionId: 's', requestId: 'q' })
    expect(await r2.json()).toEqual({ error: 'unsupported' })
  })
})
