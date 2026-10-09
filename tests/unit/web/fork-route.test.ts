import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { singleBackendRegistry } from '../../../src/core/agent/registry'
import { registerFork } from '../../../src/transport/web/routes/vcs'

describe('POST /api/session/:id/fork (N9-4)', () => {
  it('passes messageID through and returns the new session id', async () => {
    const forkSession = vi.fn(async () => ({ id: 'ses_new' }))
    const app = new Hono(); registerFork(app, singleBackendRegistry({ forkSession } as any))
    const res = await app.request('/api/session/ses_1/fork', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messageID: 'msg_9' }),
    })
    expect(res.status).toBe(200)
    expect(forkSession).toHaveBeenCalledWith('ses_1', 'msg_9')
    expect(await res.json()).toEqual({ id: 'ses_new' })
  })
  it('omits messageID when body has none (tail fork)', async () => {
    const forkSession = vi.fn(async () => ({ id: 'ses_new' }))
    const app = new Hono(); registerFork(app, singleBackendRegistry({ forkSession } as any))
    const res = await app.request('/api/session/ses_1/fork', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    expect(res.status).toBe(200)
    expect(forkSession).toHaveBeenCalledWith('ses_1', undefined)
  })
  it('501 when backend cannot fork; 502 when fork fails', async () => {
    const app = new Hono(); registerFork(app, singleBackendRegistry({} as any))
    expect((await app.request('/api/session/ses_1/fork', { method: 'POST', body: '{}' })).status).toBe(501)
    const app2 = new Hono(); registerFork(app2, singleBackendRegistry({ forkSession: vi.fn(async () => undefined) } as any))
    expect((await app2.request('/api/session/ses_1/fork', { method: 'POST', body: '{}' })).status).toBe(502)
  })
})
