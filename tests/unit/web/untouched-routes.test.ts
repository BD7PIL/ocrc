import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer } from '../../../src/transport/web/server'
import { createTokenAuth } from '../../../src/connectivity/auth/token'
import { singleBackendRegistry } from '../../../src/core/agent/registry'
import { createLogger } from '../../../src/utils/logger'

function fakeState(overrides: Record<string, any> = {}) {
  return {
    getSessionCost: () => 0.1,
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
    setSessionBackend: vi.fn(),
    getActiveBackend: () => undefined,
    setActiveBackend: vi.fn(),
    getSessionSuggestions: (id: string) => (id === 'ses_a' ? ['try x', 'try y'] : undefined),
    isSessionBusy: (id: string) => id === 'ses_sub',
    getActiveWorkspace: () => undefined,
    flush: async () => {},
    normalizeSessionId: (id: string) => id,
    ...overrides,
  } as any
}

function fakeBackend(overrides: Record<string, any> = {}) {
  return {
    id: 'opencode',
    capabilities: { workspaces: true },
    listSessionSummaries: vi.fn().mockResolvedValue([]),
    listSessions: vi.fn().mockResolvedValue([{ id: 'ses_a' }]),
    ping: vi.fn().mockResolvedValue(true),
    getHistory: vi.fn().mockResolvedValue([]),
    hasSession: vi.fn().mockResolvedValue(true),
    getSessionMeta: vi.fn().mockResolvedValue({}),
    getMessageBlocks: vi.fn().mockResolvedValue([]),
    getTodos: vi.fn().mockResolvedValue([]),
    getDiff: vi.fn().mockResolvedValue([]),
    getContext: vi.fn().mockResolvedValue({ directory: undefined }),
    getSessionsStatus: vi.fn().mockResolvedValue({}),
    resolvePermission: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn().mockResolvedValue({ id: 'ses_new' }),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    renameSession: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any
}

function app(state: any, backend: any, extra: Record<string, any> = {}) {
  return buildServer({
    auth: createTokenAuth({ token: 't', devBypass: true, devEmail: 'd@l', host: '127.0.0.1' }),
    registry: singleBackendRegistry(backend),
    state,
    cardBus: { publish: vi.fn(), subscribeAll: () => () => {}, currentSeq: () => 0 } as any,
    ...extra,
  } as any)
}

const LOOPBACK = { incoming: { socket: { remoteAddress: '127.0.0.1' } } }
const get = (a: any, url: string) => a.request(url, undefined, LOOPBACK)
const getJson = async (a: any, url: string) => (await get(a, url)).json()

describe('web routes — previously uncovered happy paths', () => {
  it('GET /api/vcs + /api/vcs/diff proxy the backend; 501 when unsupported; 400 without file', async () => {
    const backend = fakeBackend({
      getVcs: vi.fn().mockResolvedValue({ branch: 'main', status: [{ file: 'a.ts', status: 'modified' }] }),
      getVcsDiff: vi.fn().mockResolvedValue({ file: 'a.ts', patch: '@@ -1 +1 @@' }),
    })
    const a = app(fakeState(), backend)
    expect(await getJson(a, '/api/vcs?sessionId=ses_a')).toMatchObject({ branch: 'main' })
    expect(backend.getVcs).toHaveBeenCalledWith('ses_a')
    expect(await getJson(a, '/api/vcs/diff?sessionId=ses_a&file=a.ts')).toMatchObject({ file: 'a.ts' })

    const bare = app(fakeState(), fakeBackend())
    expect((await get(bare, '/api/vcs')).status).toBe(501)
    // with a vcs-capable backend but no file param → 400 (after the 501 gate)
    const diffing = app(fakeState(), fakeBackend({ getVcsDiff: vi.fn().mockResolvedValue(undefined) }))
    expect((await get(diffing, '/api/vcs/diff?sessionId=ses_a')).status).toBe(400)
  })

  it('revert routes: 400 without messageID, pass-through on success', async () => {
    const backend = fakeBackend({
      revertSession: vi.fn().mockResolvedValue({ id: 'ses_a', revert: { messageID: 'msg1' } }),
      unrevertSession: vi.fn().mockResolvedValue({ id: 'ses_a' }),
      getSessionRevert: vi.fn().mockResolvedValue({ reverted: false }),
    })
    const a = app(fakeState(), backend)
    expect((await a.request('/api/session/ses_a/revert', { method: 'POST' }, LOOPBACK)).status).toBe(400)
    const rev = await a.request('/api/session/ses_a/revert?messageID=msg1', { method: 'POST' }, LOOPBACK)
    expect(await rev.json()).toMatchObject({ revert: { messageID: 'msg1' } })
    expect((await get(a, '/api/session/ses_a/revert-state')).status).toBe(200)
  })

  it('M8 routes: skills/browse/file-content/worktrees proxy the active backend', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ocrc-m8-'))
    writeFileSync(join(dir, 'a.ts'), 'x')
    writeFileSync(join(dir, 'b.ts'), 'y')
    const backend = fakeBackend({
      getSkills: vi.fn().mockResolvedValue([{ name: 'skill-one', description: 'd' }]),
      listFiles: vi.fn().mockResolvedValue([{ name: 'a.ts', path: 'a.ts', type: 'file' }]),
      readFile: vi.fn().mockResolvedValue({ type: 'text', content: 'x' }),
      listWorktreeSandboxes: vi.fn().mockResolvedValue([{ name: 'wt1' }]),
      createWorktreeSandboxes: vi.fn().mockResolvedValue({ name: 'wt2' }),
      removeWorktreeSandboxes: vi.fn().mockResolvedValue(true),
    })
    const a = app(fakeState(), backend)
    expect(await getJson(a, '/api/skills')).toMatchObject({ skills: [{ name: 'skill-one' }] })
    expect(await getJson(a, '/api/browse?path=.')).toMatchObject({ files: [{ path: 'a.ts' }] })
    expect(await getJson(a, '/api/file-content?path=a.ts')).toMatchObject({ content: 'x' })
    expect(await getJson(a, '/api/worktrees')).toMatchObject({ worktrees: [{ name: 'wt1' }] })

    const created = await a.request('/api/worktrees', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'wt2' }), ...LOOPBACK } as any)
    expect(await created.json()).toMatchObject({ worktree: { name: 'wt2' } })
    const removed = await a.request('/api/worktrees?name=wt2', { method: 'DELETE' }, LOOPBACK)
    expect(await removed.json()).toMatchObject({ ok: true })
  })

  it('files route (@-mention picker) walks the session directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ocrc-files-'))
    writeFileSync(join(dir, 'component.tsx'), 'x')
    const backend = fakeBackend({ getContext: vi.fn().mockResolvedValue({ directory: dir }) })
    const a = app(fakeState(), backend)
    const out = await getJson(a, '/api/session/ses_a/files?q=comp') as any
    expect(out).toEqual(['component.tsx'])
  })

  it('schedules routes: add validates, patch toggles, delete removes', async () => {
    const scheduler = {
      list: vi.fn().mockReturnValue([{ id: 's1', prompt: 'p', spec: { kind: 'every', minutes: 5 }, enabled: true }]),
      add: vi.fn((input: any) => (input.prompt ? { id: 's2', ...input } : null)),
      setEnabled: vi.fn(() => ({ id: 's1', enabled: false })),
      remove: vi.fn(() => true),
    }
    const a = app(fakeState(), fakeBackend(), { scheduler })
    expect(await getJson(a, '/api/schedules')).toMatchObject({ schedules: [{ id: 's1' }] })

    const bad = await a.request('/api/schedules', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '', spec: { kind: 'every', minutes: 1 } }), ...LOOPBACK } as any)
    expect(bad.status).toBe(400)

    const patched = await a.request('/api/schedules/s1', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }), ...LOOPBACK } as any)
    expect(await patched.json()).toMatchObject({ schedule: { enabled: false } })
    const del = await a.request('/api/schedules/s1', { method: 'DELETE' }, LOOPBACK)
    expect(await del.json()).toMatchObject({ ok: true })
  })

  it('suggestions route returns state-backed follow-ups', async () => {
    const a = app(fakeState(), fakeBackend())
    const hit = await getJson(a, '/api/session/ses_a/suggestions')
    expect(hit).toMatchObject({ suggestions: ['try x', 'try y'] })
    const miss = await getJson(a, '/api/session/ses_b/suggestions')
    expect(miss).toMatchObject({ suggestions: [] })
  })

  it('subagents route annotates rows with the live busy flag', async () => {
    const backend = fakeBackend({
      getSubagents: vi.fn().mockResolvedValue([{ id: 'ses_sub', title: 'sub', done: 1, total: 2 }]),
    })
    const a = app(fakeState(), backend)
    const out = await getJson(a, '/api/session/ses_a/subagents') as any
    expect(out.subagents).toEqual([{ id: 'ses_sub', title: 'sub', done: 1, total: 2, busy: true }])
  })

  it('logs route serves the in-memory ring (bounded by limit)', async () => {
    createLogger('routes-test').warn('marker-line-for-logs-test')
    const a = app(fakeState(), fakeBackend())
    const out = await getJson(a, '/api/logs?limit=5') as any
    expect(Array.isArray(out.lines)).toBe(true)
    expect(out.lines.length).toBeLessThanOrEqual(5)
    expect(out.lines.join('\n')).toContain('marker-line-for-logs-test')
  })
})
