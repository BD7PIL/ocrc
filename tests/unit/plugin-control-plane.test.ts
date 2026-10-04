import { describe, it, expect, vi, afterEach } from 'vitest'
import { createV1ControlPlane, createV2ControlPlane } from '../../src/plugin/control-plane'
import type { V2Context, V2Event } from '../../src/plugin/v2/types'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createV2ControlPlane', () => {
  it('maps the V2 event iterator into V1 shapes and feeds the backend registry', async () => {
    const events: V2Event[] = [
      { type: 'session.created', data: { sessionID: 'ses_v1', title: 'from stream' }, location: { directory: '/w' } },
      { type: 'session.text.delta', data: { sessionID: 'ses_v1', assistantMessageID: 'msg1', ordinal: 0, delta: 'he' } },
      { type: 'permission.asked', data: { sessionID: 'ses_v1', id: 'p1', action: 'bash', resources: ['*'] } },
      { type: 'session.execution.failed', data: { sessionID: 'ses_v1', error: { message: 'boom' } } },
      { type: 'usage.reported', data: { sessionID: 'ses_v1' } as any },
    ]
    const ctx = {
      location: { directory: '/w' },
      session: {},
      permission: {},
      event: { subscribe: async function* () { for (const e of events) yield e } },
    } as any as V2Context

    const plane = createV2ControlPlane(ctx)
    const dispatched: any[] = []
    const stop = plane.wireEvents(async (ev) => { dispatched.push(ev) })
    await new Promise((r) => setTimeout(r, 10))

    const types = dispatched.map((e) => e.type)
    // session.created + execution.failed's status + failed's error + delta + permission
    expect(types).toContain('session.created')
    expect(types).toContain('message.part.delta')
    expect(types).toContain('permission.asked')
    expect(types).toContain('session.status')
    expect(types).toContain('session.error')
    // unmapped V2 types never dispatch
    expect(types).not.toContain('usage.reported')

    const perm = dispatched.find((e) => e.type === 'permission.asked')
    expect(perm.properties).toMatchObject({ id: 'p1', sessionID: 'ses_v1', permission: 'bash' })

    // the backend registry saw the created session
    expect(await plane.backend.hasSession('ses_v1')).toBe(true)
    stop()
  })
})

describe('createV1ControlPlane', () => {
  it('getSession reads through the SDK client', async () => {
    const ctx = {
      serverUrl: 'http://127.0.0.1:4096',
      client: { session: { get: vi.fn(async () => ({ data: { id: 's1', agent: 'build' } })) } },
    }
    const plane = createV1ControlPlane(ctx as any)
    expect(plane.serverUrl).toBe('http://127.0.0.1:4096')
    expect(await plane.getSession!('s1')).toMatchObject({ agent: 'build' })
  })

  it('wireEvents dispatches ONLY question.* from the global SSE (single-source rule)', async () => {
    const frames = [
      { payload: { type: 'question.asked', properties: { id: 'q1', sessionID: 's1', questions: [] } } },
      { payload: { type: 'session.idle', properties: { sessionID: 's1' } } },
      { payload: { type: 'question.rejected', properties: { requestID: 'q2', sessionID: 's1' } } },
    ]
    const sse = frames.map((f) => `data: ${JSON.stringify(f)}`).join('\n\n') + '\n\n'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sse, { status: 200 })))

    const ctx = {
      serverUrl: 'http://127.0.0.1:4096',
      client: { session: { get: vi.fn() } },
    }
    const plane = createV1ControlPlane(ctx as any)
    const dispatched: any[] = []
    const stop = plane.wireEvents(async (ev) => { dispatched.push(ev) })
    await new Promise((r) => setTimeout(r, 30))

    expect(dispatched.map((e) => e.type)).toEqual(['question.asked', 'question.rejected'])
    stop()
  })
})
