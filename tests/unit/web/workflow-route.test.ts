// P2 — the HTTP surface and the saved-workflow store. Both are thin: the journal
// is the single source of truth for runs, and saved workflows are one small JSON
// file. The `/z/` projection (workflowRuns, deltas, v4 queries) is P4 and layers on
// the same manager.
import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkflowJournal } from '../../../src/core/workflow/journal'
import { createWorkflowManager } from '../../../src/core/workflow/manager'
import { createArtifactStore } from '../../../src/core/workflow/artifacts'
import { createWorldReader } from '../../../src/core/workflow/world'
import { createSavedWorkflowsStore } from '../../../src/core/workflow/saved'
import { registerWorkflow } from '../../../src/transport/web/routes/workflow'
import { createEscalationRegistry } from '../../../src/core/workflow/escalations'
import { singleBackendRegistry } from '../../../src/core/agent/registry'
import type { AgentBackend } from '../../../src/core/agent/backend'
import type { RunSettlement } from '../../../vendor/zcode-dwf/dist/dynamic-workflow/src/index.js'

const SCRIPT = 'const a = await agent("first").ask("hi");\nreturn { a };\n'
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ocrc-wf-route-')) })

function fakeBackend(): AgentBackend {
  return {
    id: 'opencode', capabilities: {} as AgentBackend['capabilities'],
    prompt: async () => {}, abort: async () => {}, hasSession: async () => true,
    listSessions: async () => [], listSessionSummaries: async () => [],
    createSession: async () => ({ id: 'ses_actor' }), deleteSession: async () => {}, renameSession: async () => {},
    getSessionMeta: async () => ({}), getContext: async () => ({}), getHistory: async () => [],
    getMessageBlocks: async () => [], getDiff: async () => [], getTodos: async () => [],
    getSessionsStatus: async () => ({}), ping: async () => true, getAgents: async () => [],
    getModels: async () => [], getMcp: async () => [], listWorkspaces: async () => [],
    listCommands: async () => [], runCommand: async () => {}, resolvePermission: async () => {},
  } as AgentBackend
}

function makeApp(opts: { hold?: boolean } = {}) {
  const journal = createWorkflowJournal({ dir })
  const artifacts = createArtifactStore({ dir, cwd: dir })
  const saved = createSavedWorkflowsStore(join(dir, 'saved.json'))
  const sink = {
    askSubmitAttempted: () => {}, askTurnEnded: () => {}, askProgress: () => {},
    askStats: () => {}, askFailed: () => {}, stopRun: () => {}, runStalled: () => {},
    askWaiting: () => {}, askExecuting: () => {}, askMutating: () => {}, concurrencyChanged: () => {},
  }
  const runScript = async (o: any) => {
    const driver = o.makeDriver(sink)
    // Stand in for the sandbox's actor minting, so the run has a real actor row.
    await driver.createActorSession({ siteId: 'site-a', ordinal: 1 }, { name: 'first' })
    if (opts.hold) return await new Promise<RunSettlement>(() => { /* never settles */ })
    journal.updateRunStatus(o.runId, 'completed', { result: { ok: true } })
    return { status: 'completed', artifact: { ok: true } } as RunSettlement
  }
  const manager = createWorkflowManager({
    registry: singleBackendRegistry(fakeBackend()),
    journal, world: createWorldReader({ cwd: dir }), artifacts,
    runScript: runScript as never,
  })
  const escalations = createEscalationRegistry()
  const app = new Hono()
  registerWorkflow(app, { manager, artifacts, saved, registry: singleBackendRegistry(fakeBackend()), escalations })
  return { app, journal, artifacts, saved, manager, escalations }
}

const json = async (res: Response) => await res.json() as any

describe('workflow routes', () => {
  it('starts a run and reads it back', async () => {
    const { app } = makeApp()
    const created = await json(await app.request('/api/workflow/runs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scriptText: SCRIPT, cwd: dir, name: 'route-test' }),
    }))
    expect(created.runId).toMatch(/^dwfrun-/)
    await new Promise((r) => setTimeout(r, 20))

    const list = await json(await app.request('/api/workflow/runs'))
    expect(list.runs.map((r: any) => r.runId)).toContain(created.runId)

    const one = await json(await app.request(`/api/workflow/runs/${created.runId}`))
    expect(one.record).toMatchObject({ name: 'route-test', status: 'completed' })
    expect(one.actors).toHaveLength(1)

    expect((await app.request('/api/workflow/runs/dwfrun-missing')).status).toBe(404)
  })

  it('rejects a run whose script does not compile, with diagnostics', async () => {
    const { app } = makeApp()
    const res = await app.request('/api/workflow/runs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scriptText: 'const x: number = "no";\nreturn x;', cwd: dir }),
    })
    expect(res.status).toBe(400)
    const body = await json(res)
    expect(body.error).toBe('compile_failed')
    expect(body.diagnostics.length).toBeGreaterThan(0)
  })

  it('requires scriptText', async () => {
    const { app } = makeApp()
    const res = await app.request('/api/workflow/runs', { method: 'POST', body: '{}' })
    expect(res.status).toBe(400)
  })

  it('serves events with a cursor and reports liveness', async () => {
    const { app } = makeApp({ hold: true })
    const created = await json(await app.request('/api/workflow/runs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scriptText: SCRIPT, cwd: dir }),
    }))
    const res = await json(await app.request(`/api/workflow/runs/${created.runId}/events?afterSequence=0`))
    expect(res.live).toBe(true)
    expect(Array.isArray(res.events)).toBe(true)
  })

  it('cancels a live run and 404s an unknown one', async () => {
    const { app } = makeApp({ hold: true })
    const created = await json(await app.request('/api/workflow/runs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scriptText: SCRIPT, cwd: dir }),
    }))
    expect((await app.request(`/api/workflow/runs/${created.runId}/cancel`, { method: 'POST' })).status).toBe(200)
    // The panel words its rejection from this distinction ("no such run" vs "it is not
    // running"), so the two cases must not collapse into one status.
    expect((await app.request('/api/workflow/runs/dwfrun-none/cancel', { method: 'POST' })).status).toBe(404)
  })

  it('resume 409s on a run that is not stopped', async () => {
    const { app } = makeApp()
    const created = await json(await app.request('/api/workflow/runs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scriptText: SCRIPT, cwd: dir }),
    }))
    await new Promise((r) => setTimeout(r, 20))
    const res = await app.request(`/api/workflow/runs/${created.runId}/resume`, { method: 'POST' })
    expect(res.status).toBe(409)
    expect((await json(res)).error).toBe('not_resumable:completed')
  })

  it('serves artifact bytes as an immutable response', async () => {
    const { app, artifacts } = makeApp()
    await artifacts.publish({ runId: 'dwfrun-1', siteId: 's', ordinal: 1, op: 'markdown', id: 'notes', version: 1, content: '# hi' })
    const res = await app.request('/api/workflow/runs/dwfrun-1/artifacts/notes/v/1')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/markdown')
    expect(res.headers.get('cache-control')).toContain('immutable')
    expect(await res.text()).toBe('# hi')
    expect((await app.request('/api/workflow/runs/dwfrun-1/artifacts/notes/v/9')).status).toBe(404)
    expect((await app.request('/api/workflow/runs/dwfrun-1/artifacts/notes/v/0')).status).toBe(400)
  })
})

describe('saved workflows', () => {
  it('saves by name (overwriting), lists newest-first and deletes', () => {
    const saved = createSavedWorkflowsStore(join(dir, 'saved.json'))
    const a = saved.save({ name: '巡检', scriptText: SCRIPT })
    expect(a.id).toMatch(/^wf-/)
    const b = saved.save({ name: '巡检', scriptText: SCRIPT + '// v2\n' })
    expect(b.id).toBe(a.id) // same name = same workflow, updated in place
    expect(saved.list()).toHaveLength(1)
    expect(saved.get(a.id)?.scriptText).toContain('// v2')

    saved.save({ name: 'other', scriptText: SCRIPT })
    expect(saved.list()).toHaveLength(2)
    expect(saved.remove(a.id)).toBe(true)
    expect(saved.remove(a.id)).toBe(false)
    expect(saved.list()).toHaveLength(1)
  })

  it('survives a reload from disk', () => {
    const path = join(dir, 'saved.json')
    const first = createSavedWorkflowsStore(path)
    const wf = first.save({ name: 'persist', scriptText: SCRIPT, description: 'd' })
    const second = createSavedWorkflowsStore(path)
    expect(second.get(wf.id)?.description).toBe('d')
  })

  it('validates and back-fills arguments, refusing unknown ones', () => {
    const saved = createSavedWorkflowsStore(join(dir, 'saved.json'))
    const wf = saved.save({
      name: 'args', scriptText: SCRIPT,
      args: [
        { name: 'target', type: 'string', required: true },
        { name: 'depth', type: 'number', default: 3 },
        { name: 'deep', type: 'boolean', default: false },
      ],
    })
    expect(saved.resolveArgs(wf.id, { target: 'src' })).toEqual({ ok: true, args: { target: 'src', depth: 3, deep: false } })
    expect(saved.resolveArgs(wf.id, { target: 'src', depth: '7' })).toEqual({ ok: true, args: { target: 'src', depth: 7, deep: false } })
    expect(saved.resolveArgs(wf.id, {})).toMatchObject({ ok: false, error: 'missing required argument: target' })
    expect(saved.resolveArgs(wf.id, { target: 'src', typo: 1 })).toMatchObject({ ok: false, error: 'unknown argument: typo' })
    expect(saved.resolveArgs(wf.id, { target: 'src', depth: 'deep' })).toMatchObject({ ok: false })
    expect(saved.resolveArgs('nope', {})).toMatchObject({ ok: false, error: 'not_found' })
  })

  it('runs a saved workflow through the route and counts the run', async () => {
    const { app, saved } = makeApp()
    const wf = saved.save({ name: 'saved-run', scriptText: SCRIPT, cwd: dir })
    const res = await app.request(`/api/workflow/saved/${wf.id}/run`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(200)
    expect((await json(res)).runId).toMatch(/^dwfrun-/)
    expect(saved.get(wf.id)?.runCount).toBe(1)

    const bad = await app.request('/api/workflow/saved/nope/run', { method: 'POST', body: '{}' })
    expect(bad.status).toBe(404)
  })

  it('refuses a saved workflow with no name or script', async () => {
    const { app } = makeApp()
    expect((await app.request('/api/workflow/saved', { method: 'POST', body: JSON.stringify({ scriptText: SCRIPT }) })).status).toBe(400)
    expect((await app.request('/api/workflow/saved', { method: 'POST', body: JSON.stringify({ name: 'x' }) })).status).toBe(400)
  })
})

// P4-1a/P4-1c — the read face the panel uses. The projection endpoint is what makes a
// running run survive a refresh, so its shape (runs + the card join map) is pinned here
// rather than only in the UI.
describe('workflow routes — P4 projection + live settings', () => {
  it('filters runs by parent session and returns the card join', async () => {
    const { app } = makeApp()
    const created = await json(await app.request('/api/workflow/runs', {
      method: 'POST',
      body: JSON.stringify({
        scriptText: SCRIPT, cwd: dir, sessionId: 'ses_parent',
        messageId: 'msg_9', toolName: 'CreateWorkflow',
      }),
    }))
    await app.request('/api/workflow/runs', { method: 'POST', body: JSON.stringify({ scriptText: SCRIPT, cwd: dir, sessionId: 'ses_other' }) })

    const mine = await json(await app.request('/api/workflow/runs?sessionId=ses_parent'))
    expect(mine.runs).toHaveLength(1)
    expect(mine.runs[0].runId).toBe(created.runId)
    expect(mine.runs[0].parentSessionId).toBe('ses_parent')
    expect((await json(await app.request('/api/workflow/runs'))).runs).toHaveLength(2)
  })

  it('projects a run into the vendored shape and hands over the join key', async () => {
    const { app } = makeApp()
    const created = await json(await app.request('/api/workflow/runs', {
      method: 'POST',
      body: JSON.stringify({ scriptText: SCRIPT, cwd: dir, sessionId: 'ses_parent', messageId: 'msg_9', toolName: 'CreateWorkflow' }),
    }))
    const body = await json(await app.request('/api/workflow/projection?sessionId=ses_parent'))
    expect(body.joins[created.runId]).toEqual({ messageId: 'msg_9', toolName: 'CreateWorkflow' })
    const run = body.runs[0]
    expect(run.runId).toBe(created.runId)
    expect(run.status).toBe('completed')
    // The stub sandbox mints an actor session but never runs an ask, so there is no node
    // row — and `nodesUsed: 0` is the honest count of that, not a placeholder.
    expect(run.usage.nodesUsed).toBe(0)
    expect(run.nodes).toEqual([])
    expect(run.actors[0]).toMatchObject({ siteId: 'site-a', name: 'first', status: 'completed' })
    // The stub settles with `{ ok: true }`, so the preview is the vendored
    // pretty-printed form of the script's top-level return value.
    expect(run.resultPreview).toBe('{\n  "ok": true\n}')

    const single = await json(await app.request(`/api/workflow/projection/${created.runId}`))
    expect(single.run.runId).toBe(created.runId)
    expect((await app.request('/api/workflow/projection/dwfrun-nope')).status).toBe(404)
  })

  it('changes a live run\'s concurrency and refuses a live model change', async () => {
    const { app } = makeApp({ hold: true })
    const created = await json(await app.request('/api/workflow/runs', {
      method: 'POST', body: JSON.stringify({ scriptText: SCRIPT, cwd: dir, maxConcurrency: 2 }),
    }))
    const ok = await json(await app.request(`/api/workflow/runs/${created.runId}/settings`, {
      method: 'POST', body: JSON.stringify({ maxConcurrency: 3 }),
    }))
    expect(ok).toEqual({ ok: true, maxConcurrency: 3 })

    const model = await app.request(`/api/workflow/runs/${created.runId}/settings`, {
      method: 'POST', body: JSON.stringify({ subagentModel: 'zai/glm-4.6' }),
    })
    expect(model.status).toBe(409)
    expect((await json(model)).error).toBe('subagent_model_immutable')
  })

  it('records an escalation against the actor\'s run and answers it', async () => {
    const { app, manager } = makeApp()
    const created = await json(await app.request('/api/workflow/runs', {
      method: 'POST', body: JSON.stringify({ scriptText: SCRIPT, cwd: dir, sessionId: 'ses_parent' }),
    }))
    // The run's actor session is how the route finds the run (the actor rows hold it).
    expect(manager.runForActorSession('ses_actor')).toBe(created.runId)

    const raised = await json(await app.request('/api/workflow/escalate', {
      method: 'POST', body: JSON.stringify({ sessionId: 'ses_actor', question: 'which config?' }),
    }))
    expect(raised.ok).toBe(true)
    expect(raised.answer).toBeNull()

    const pending = await json(await app.request(`/api/workflow/runs/${created.runId}/escalations`))
    expect(pending.pending.map((e: any) => e.question)).toEqual(['which config?'])

    const answered = await json(await app.request('/api/workflow/escalations/answer', {
      method: 'POST', body: JSON.stringify({ runId: created.runId, question: 'which config?', answer: 'prod' }),
    }))
    expect(answered).toMatchObject({ ok: true, pending: [] })

    const after = await json(await app.request(`/api/workflow/runs/${created.runId}/escalations`))
    expect(after.pending).toHaveLength(0)
    expect(after.answered[0].answer).toBe('prod')
  })

  it('refuses an escalation from a session that belongs to no run', async () => {
    const { app } = makeApp()
    const res = await app.request('/api/workflow/escalate', {
      method: 'POST', body: JSON.stringify({ sessionId: 'ses_stray', question: 'hello?' }),
    })
    expect(res.status).toBe(409)
    expect((await json(res)).error).toBe('no_run')
  })
})
