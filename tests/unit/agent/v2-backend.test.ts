import { describe, it, expect, vi } from 'vitest'
import { createV2Backend } from '../../../src/core/agent/v2-backend'
import type { V2Context } from '../../../src/plugin/v2/types'

function fakeCtx(): V2Context & { _sessions: Map<string, any> } {
  const sessions = new Map<string, any>()
  return {
    app: { name: 'cli', version: '2.0.15' },
    location: { directory: '/w' },
    options: {},
    event: { subscribe: vi.fn() },
    session: {
      create: vi.fn(async (input: any) => {
        const id = `ses_${sessions.size + 1}`
        const info = { id, title: input?.id?.title, directory: input?.location?.directory }
        sessions.set(id, info)
        return info
      }),
      get: vi.fn(async (input: { sessionID: string }) => {
        const s = sessions.get(input.sessionID)
        if (!s) throw new Error('session not found')
        return s
      }),
      prompt: vi.fn(async () => ({})),
      interrupt: vi.fn(async () => ({})),
      rename: vi.fn(async (input: any) => {
        const s = sessions.get(input.sessionID)
        if (s) s.title = input.id?.title
        return {}
      }),
      command: vi.fn(async () => ({})),
    },
    permission: { reply: vi.fn(async () => {}) },
    _sessions: sessions,
  } as any
}

describe('createV2Backend', () => {
  it('createSession remembers the session; hasSession resolves via seen and ctx.get', async () => {
    const ctx = fakeCtx()
    const { backend, observeSessionEvent } = createV2Backend(ctx)
    const { id } = await backend.createSession({ directory: '/w', title: 't' })
    expect(id).toMatch(/^ses_/)

    expect(await backend.hasSession(id)).toBe(true)
    // unknown id → ctx.get throws → false (not an error)
    expect(await backend.hasSession('ses_missing')).toBe(false)
    void observeSessionEvent
  })

  it('prompt/abort/rename/permission.reply pass the V2 shapes through', async () => {
    const ctx = fakeCtx()
    const { backend } = createV2Backend(ctx)
    const { id } = await backend.createSession({ directory: '/w' })

    await backend.prompt(id, { text: 'hello' })
    expect(ctx.session.prompt).toHaveBeenCalledWith({ sessionID: id, id: { text: 'hello' } })

    await backend.abort(id)
    expect(ctx.session.interrupt).toHaveBeenCalledWith({ sessionID: id })

    await backend.renameSession(id, 'renamed')
    expect(ctx.session.rename).toHaveBeenCalledWith({ sessionID: id, id: { title: 'renamed' } })

    await backend.resolvePermission(id, 'req1', 'always')
    expect(ctx.permission.reply).toHaveBeenCalledWith({ sessionID: id, requestID: 'req1', reply: 'always' })
  })

  it('deletion and slash-commands are honest errors on V2', async () => {
    const { backend } = createV2Backend(fakeCtx())
    await expect(backend.deleteSession('ses_x')).rejects.toThrow(/not supported/)
    await expect(backend.runCommand('ses_x', 'test')).rejects.toThrow(/not supported/)
  })

  it('capability-gated reads return honest empties', async () => {
    const { backend } = createV2Backend(fakeCtx())
    expect(backend.capabilities.diff).toBe(false)
    expect(await backend.getHistory('ses_x')).toEqual([])
    expect(await backend.getDiff('ses_x')).toEqual([])
    expect(await backend.getAgents()).toEqual([])
  })

  it('observeSessionEvent maintains the session registry (created/updated/deleted)', async () => {
    const ctx = fakeCtx()
    const { backend, observeSessionEvent } = createV2Backend(ctx)

    observeSessionEvent({ type: 'session.created', sessionID: 'ses_e1', title: 'one' })
    observeSessionEvent({ type: 'session.renamed', sessionID: 'ses_e1', title: 'one-renamed' })
    observeSessionEvent({ type: 'session.created', sessionID: 'ses_e2' })
    const list = await backend.listSessionSummaries()
    expect(list.map((s) => s.id).sort()).toEqual(['ses_e1', 'ses_e2'])
    expect(list.find((s) => s.id === 'ses_e1')?.title).toBe('one-renamed')

    observeSessionEvent({ type: 'session.deleted', sessionID: 'ses_e1' })
    expect((await backend.listSessionSummaries()).map((s) => s.id)).toEqual(['ses_e2'])
  })
})
