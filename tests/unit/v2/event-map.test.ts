import { describe, it, expect } from 'vitest'
import { createV2EventMapper } from '../../../src/plugin/v2/event-map'

/** Round-trip helper: build a minimal V2 event envelope. */
function v2(type: string, data: Record<string, unknown>, location?: { directory?: string }) {
  return { type, data, ...(location ? { location } : {}) }
}

describe('createV2EventMapper', () => {
  it('maps permission.asked with the documented field renames', () => {
    const m = createV2EventMapper()
    const out = m.map(v2('permission.asked', {
      id: 'per_1', sessionID: 'ses_1', action: 'bash', resources: ['/tmp/*'], metadata: { cmd: 'ls' },
    }))
    expect(out).toHaveLength(1)
    const p = out[0].properties as any
    expect(out[0].type).toBe('permission.asked')
    expect(p.id).toBe('per_1')
    expect(p.sessionID).toBe('ses_1')
    expect(p.permission).toBe('bash')       // V2 action → V1 permission
    expect(p.patterns).toEqual(['/tmp/*'])  // V2 resources → V1 patterns
    expect(p.title).toBe('bash')
    expect(p.args).toEqual({ cmd: 'ls' })
  })

  it('maps permission.replied reply values unchanged', () => {
    const m = createV2EventMapper()
    const out = m.map(v2('permission.replied', { sessionID: 'ses_1', requestID: 'per_9', reply: 'always' }))
    const p = out[0].properties as any
    expect(out[0].type).toBe('permission.replied')
    expect(p.permissionID).toBe('per_9')
    expect(p.response).toBe('always')
  })

  it('streams text deltas under a stable partId and finalizes with text.ended', () => {
    const m = createV2EventMapper()
    const d1 = m.map(v2('session.text.delta', { sessionID: 's', assistantMessageID: 'msg1', ordinal: 0, delta: 'he' }))
    const d2 = m.map(v2('session.text.delta', { sessionID: 's', assistantMessageID: 'msg1', ordinal: 0, delta: 'llo' }))
    expect(d1[0].type).toBe('message.part.delta')
    const p1 = d1[0].properties as any
    expect(p1.partID).toBe('msg1:0')
    expect(p1.field).toBe('text')
    expect(p1.delta).toBe('he')
    expect((d2[0].properties as any).delta).toBe('llo')

    const end = m.map(v2('session.text.ended', { sessionID: 's', assistantMessageID: 'msg1', ordinal: 0, text: 'hello' }))
    expect(end[0].type).toBe('message.part.updated')
    const part = (end[0].properties as any).part
    expect(part.id).toBe('msg1:0')
    expect(part.type).toBe('text')
    expect(part.text).toBe('hello')
  })

  it('tracks tool names from input.started and applies them to success/failure', () => {
    const m = createV2EventMapper()
    const started = m.map(v2('session.tool.input.started', { sessionID: 's', assistantMessageID: 'm', id: 'call1', name: 'bash' }))
    expect((started[0].properties as any).part.tool).toBe('bash')
    expect((started[0].properties as any).part.state.status).toBe('running')

    const ok = m.map(v2('session.tool.success', { sessionID: 's', assistantMessageID: 'm', id: 'call1', content: [{ type: 'text', text: 'OCRC_S3_OK' }] }))
    const okPart = (ok[0].properties as any).part
    expect(okPart.tool).toBe('bash')
    expect(okPart.state.status).toBe('done')
    expect(okPart.state.output).toBe('OCRC_S3_OK')

    const fail = m.map(v2('session.tool.failed', { sessionID: 's', assistantMessageID: 'm', id: 'call2', error: { type: 'x', message: 'boom' } }))
    const failPart = (fail[0].properties as any).part
    expect(failPart.state.status).toBe('error')
    expect(failPart.state.output).toBe('boom')
  })

  it('maps execution lifecycle: started→busy, succeeded→idle, failed→error+idle', () => {
    const m = createV2EventMapper()
    const started = m.map(v2('session.execution.started', { sessionID: 's' }))
    expect(started[0].type).toBe('session.status')
    expect((started[0].properties as any).status.type).toBe('busy')

    const ok = m.map(v2('session.execution.succeeded', { sessionID: 's' }))
    expect(ok[0].type).toBe('session.idle')

    const interrupted = m.map(v2('session.execution.interrupted', { sessionID: 's' }))
    expect(interrupted[0].type).toBe('session.idle')

    const failed = m.map(v2('session.execution.failed', { sessionID: 's', error: { type: 'x', message: 'kaboom' } }))
    expect(failed.map((e) => e.type)).toEqual(['session.status', 'session.error'])
    expect((failed[1].properties as any).error.message).toBe('kaboom')
  })

  it('passes session.idle through and feeds session.created into the registry shape', () => {
    const m = createV2EventMapper()
    const idle = m.map(v2('session.idle', { sessionID: 's' }))
    expect(idle[0].type).toBe('session.idle')
    expect((idle[0].properties as any).sessionID).toBe('s')

    const created = m.map(v2('session.created', { sessionID: 's', projectID: 'p' }, { directory: '/tmp/x' }))
    expect(created[0].type).toBe('session.created')
    expect((created[0].properties as any).info.directory).toBe('/tmp/x')
  })

  it('ignores unknown/irrelevant events and malformed payloads', () => {
    const m = createV2EventMapper()
    expect(m.map({ type: 'mcp.status.changed' })).toEqual([])
    expect(m.map({ type: 'permission.asked' })).toEqual([])
    expect(m.map({ type: 'session.idle' })).toEqual([])
    expect(m.map({})).toEqual([])
  })
})
