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

function fakeBackend(history: unknown[] = [], throwOnHistory = false): AgentBackend {
  return {
    id: 'opencode', capabilities: {} as AgentBackend['capabilities'],
    prompt: async () => {}, abort: async () => {}, hasSession: async () => true,
    listSessions: async () => [], listSessionSummaries: async () => [],
    createSession: async () => ({ id: 'ses_actor' }), deleteSession: async () => {}, renameSession: async () => {},
    getSessionMeta: async () => ({}), getContext: async () => ({}),
    getHistory: async () => { if (throwOnHistory) throw new Error('engine busy'); return history },
    getMessageBlocks: async () => [], getDiff: async () => [], getTodos: async () => [],
    getSessionsStatus: async () => ({}), ping: async () => true, getAgents: async () => [],
    getModels: async () => [], getMcp: async () => [], listWorkspaces: async () => [],
    listCommands: async () => [], runCommand: async () => {}, resolvePermission: async () => {},
  } as AgentBackend
}

function makeApp(opts: { hold?: boolean; history?: unknown[]; historyThrows?: boolean; ceiling?: number } = {}) {
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
    registry: singleBackendRegistry(fakeBackend(opts.history, opts.historyThrows)),
    journal, world: createWorldReader({ cwd: dir }), artifacts,
    runScript: runScript as never,
    // The default ceiling is `availableParallelism() - 2` (clamped 1..16), so a
    // 4-vCPU CI runner caps at 2 and the concurrency-change assertion below
    // would silently clamp. Pin it where the test needs headroom.
    ...(opts.ceiling ? { ceiling: opts.ceiling } : {}),
  })
  const escalations = createEscalationRegistry()
  const app = new Hono()
  registerWorkflow(app, {
    manager, artifacts, saved,
    registry: singleBackendRegistry(fakeBackend(opts.history, opts.historyThrows)),
    escalations,
  })
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
    const { app } = makeApp({ hold: true, ceiling: 8 })
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

// P4-2 — the seven read faces over HTTP. The authorization rule is the vendored one
// (sessionId must be the run's parent session) and the answer for a mismatch is the same
// 404 as "no such run": anything else is an existence oracle for other sessions' runs.
describe('workflow routes — P4-2 queries', () => {
  async function liveRun() {
    const { app, artifacts, journal } = makeApp()
    const created = await json(await app.request('/api/workflow/runs', {
      method: 'POST',
      body: JSON.stringify({ scriptText: SCRIPT, cwd: dir, sessionId: 'ses_parent' }),
    }))
    const runId = created.runId as string
    return { app, artifacts, journal, runId }
  }

  it('pages the journal and says whether there is more', async () => {
    const { app, journal, runId } = await liveRun()
    // The stub sandbox emits nothing of its own, so seed the events the page reads.
    for (const ev of [
      { type: 'node-executing', instance: { siteId: 'ask#1', ordinal: 1 } },
      { type: 'usage-updated', spentTokens: 7 },
    ] as const) journal.appendEvent(runId, ev as never)

    const page = await json(await app.request(`/api/workflow/runs/${runId}/events/v4?sessionId=ses_parent&limit=1`))
    expect(page.events).toHaveLength(1)
    expect(page.events[0]).toMatchObject({ sequence: 1, type: 'node-executing' })
    expect(page.events[0].payload).toMatchObject({ instance: { siteId: 'ask#1', ordinal: 1 } })
    expect(page.hasMore).toBe(true)

    const cursor = page.events[0].sequence
    const next = await json(await app.request(`/api/workflow/runs/${runId}/events/v4?sessionId=ses_parent&afterSequence=${cursor}`))
    expect(next.events.map((e: any) => e.sequence)).toEqual([2])
    expect(next.events[0]).toMatchObject({ type: 'usage-updated', payload: { spentTokens: 7 } })
    expect(next.hasMore).toBe(false)
  })

  it('enumerates runs for a session (the restart-safe discovery face)', async () => {
    const { app, runId } = await liveRun()
    const body = await json(await app.request('/api/workflow/runs/summaries?sessionId=ses_parent'))
    expect(body.runs).toHaveLength(1)
    expect(body.runs[0]).toMatchObject({ runId, status: 'completed', resumable: false })
    expect(body.runs[0].label).toBeTypeOf('string')
    expect((await app.request('/api/workflow/runs/summaries')).status).toBe(400)
  })

  // The vendored run-directory model drops any summary without a `toolCallId`
  // (`buildWorkflowRunDirectory` → `hasDetailAnchor`), and the directory page reads this
  // face alone: no anchor, no row — and with no rows the status panel's Workflows section
  // never renders at all. The plugin cannot know the id (the engine mints it after the
  // tool call returns), so the face resolves the pair against the parent's own cards.
  it('anchors a run to its tool card by resolving the join against the session rows', async () => {
    const history = [{
      kind: 'assistant', messageId: 'msg_1',
      blocks: [{ type: 'tool', tool: 'CreateWorkflow', args: '{}', status: 'done', partId: 'prt_1', messageId: 'msg_1' }],
    }]
    const { app } = makeApp({ history })
    const created = await json(await app.request('/api/workflow/runs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scriptText: SCRIPT, cwd: dir, name: 'anchored', sessionId: 'ses_parent',
        messageId: 'msg_1', toolName: 'CreateWorkflow',
      }),
    }))
    await new Promise((r) => setTimeout(r, 20))
    const body = await json(await app.request('/api/workflow/runs/summaries?sessionId=ses_parent'))
    expect(body.runs[0]).toMatchObject({ runId: created.runId, toolCallId: 'tool-prt_1' })
  })

  it('leaves the anchor absent when the join does not match any row', async () => {
    // A run started over HTTP has no join at all; a card with the same message id but a
    // different tool name is not a match either. Neither may borrow another row's id.
    const history = [{
      kind: 'assistant', messageId: 'msg_1',
      blocks: [{ type: 'tool', tool: 'AmendWorkflow', args: '{}', status: 'done', partId: 'prt_9', messageId: 'msg_1' }],
    }]
    const { app } = makeApp({ history })
    await json(await app.request('/api/workflow/runs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scriptText: SCRIPT, cwd: dir, name: 'no-anchor', sessionId: 'ses_parent', messageId: 'msg_1', toolName: 'CreateWorkflow' }),
    }))
    await new Promise((r) => setTimeout(r, 20))
    const rows = (await json(await app.request('/api/workflow/runs/summaries?sessionId=ses_parent'))).runs
    expect(rows[0].toolCallId).toBeUndefined()
  })

  it('still answers the summaries when the transcript read fails', async () => {
    // A busy engine must not turn the directory into a 500: the rows come back without
    // anchors (the same shape a cold session produces) and the caller decides.
    const { app } = makeApp({ historyThrows: true })
    await json(await app.request('/api/workflow/runs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scriptText: SCRIPT, cwd: dir, name: 'busy', sessionId: 'ses_parent', messageId: 'msg_1', toolName: 'CreateWorkflow' }),
    }))
    await new Promise((r) => setTimeout(r, 20))
    const res = await app.request('/api/workflow/runs/summaries?sessionId=ses_parent')
    expect(res.status).toBe(200)
    const rows = (await json(res)).runs
    expect(rows).toHaveLength(1)
    expect(rows[0].toolCallId).toBeUndefined()
    expect(rows[0].label).toBe('busy')
  })

  it('answers a query for another session with the same 404 as an unknown run', async () => {
    const { app, runId } = await liveRun()
    for (const path of [
      `/api/workflow/runs/${runId}/events/v4?sessionId=ses_other`,
      `/api/workflow/runs/${runId}/workspace?sessionId=ses_other`,
      `/api/workflow/runs/${runId}/artifacts/v4?sessionId=ses_other`,
      `/api/workflow/runs/dwfrun-nope/events/v4?sessionId=ses_parent`,
    ]) {
      expect((await app.request(path)).status, path).toBe(404)
    }
  })

  it('serves the workspace transcript, the node result and the display', async () => {
    const { app, journal, runId } = await liveRun()
    journal.putNode({
      runId, siteId: 'world-read#1', ordinal: 1, kind: 'world-read', inputHash: 'h',
      status: 'completed', input: { op: 'glob', args: ['src/**'] }, result: ['a.ts'],
    })
    const workspace = await json(await app.request(`/api/workflow/runs/${runId}/workspace?sessionId=ses_parent`))
    expect(workspace.nodes).toHaveLength(1)
    expect(workspace.nodes[0]).toMatchObject({ op: 'glob', status: 'completed' })

    const nodeResult = await json(await app.request(`/api/workflow/runs/${runId}/nodes/world-read%231/1/result?sessionId=ses_parent`))
    expect(nodeResult).toMatchObject({ status: 'completed', truncated: false })
    expect(nodeResult.result).toEqual(['a.ts'])
    expect((await app.request(`/api/workflow/runs/${runId}/nodes/world-read%231/9/result?sessionId=ses_parent`)).status).toBe(404)

    const display = await json(await app.request(`/api/workflow/runs/${runId}/display?sessionId=ses_parent`))
    expect(display.display).toMatchObject({ kind: 'create_workflow', ok: true })
    expect(display.display.causalityGraph.steps.length).toBeGreaterThan(0)
  })

  it('serves artifact metadata and byte blocks', async () => {
    const { app, artifacts, runId } = await liveRun()
    await artifacts.publish({ runId, siteId: 'artifact#1', ordinal: 1, op: 'markdown', id: 'out.md', version: 1, content: 'hello world' } as never)
    const list = await json(await app.request(`/api/workflow/runs/${runId}/artifacts/v4?sessionId=ses_parent`))
    // The byte store's own index is not a journal event, so the metadata list is empty —
    // the artifacts query reads the journal, which is the durable authority.
    expect(list.artifacts).toEqual([])

    const chunk = await json(await app.request(`/api/workflow/runs/${runId}/artifacts/out.md/versions/1/read?sessionId=ses_parent&offset=0&limit=5`))
    expect(Buffer.from(chunk.dataBase64, 'base64').toString()).toBe('hello')
    expect(chunk).toMatchObject({ totalBytes: 11, nextOffset: 5 })
    expect((await app.request(`/api/workflow/runs/${runId}/artifacts/out.md/versions/1/read?sessionId=ses_parent&limit=0`)).status).toBe(400)
    expect((await app.request(`/api/workflow/runs/${runId}/artifacts/nope/versions/1/read?sessionId=ses_parent&offset=0&limit=5`)).status).toBe(404)
  })
})

// P4-3 — the saved-workflow hub's wire shape. ocrc keeps one machine-wide store, so the
// `dir`/`path` it reports is that store's file and `invalid` is empty by construction;
// the meta is the vendored {description, whenToUse, args} and scope is two-valued.
describe('workflow routes — P4-3 saved workflows', () => {
  it('lists the vendored shape with scope and meta', async () => {
    const { app, saved } = makeApp()
    saved.save({
      name: 'nightly', scriptText: SCRIPT, description: 'nightly audit', whenToUse: 'after a release',
      args: [{ name: 'target', type: 'string', required: true, description: 'what to audit' }],
    })
    const body = await json(await app.request('/api/workflow/saved'))
    expect(body.invalid).toEqual([])
    expect(body.dir).toBeTypeOf('string')
    expect(body.workflows).toHaveLength(1)
    expect(body.workflows[0]).toMatchObject({
      name: 'nightly', description: 'nightly audit', whenToUse: 'after a release', scope: 'project',
    })
    expect(body.workflows[0].args.target).toMatchObject({ type: 'string', required: true, description: 'what to audit' })
    expect(body.workflows[0].path).toBeTypeOf('string')

    // The global scope is a real filter (nothing is saved there yet).
    expect((await json(await app.request('/api/workflow/saved?scope=global'))).workflows).toEqual([])
    saved.save({ name: 'shared', scriptText: SCRIPT, scope: 'global' })
    expect((await json(await app.request('/api/workflow/saved?scope=global'))).workflows.map((w: any) => w.name)).toEqual(['shared'])
  })

  it('gets an entry by name with its script and meta', async () => {
    const { app, saved } = makeApp()
    saved.save({ name: 'nightly', scriptText: SCRIPT, description: 'audit' })
    const body = await json(await app.request('/api/workflow/saved/by-name/nightly'))
    expect(body).toMatchObject({ ok: true, name: 'nightly', scope: 'project', meta: { description: 'audit' } })
    expect(body.script).toBe(SCRIPT)
    expect((await app.request('/api/workflow/saved/by-name/nope')).status).toBe(404)
  })

  it('updates the meta and deletes by name', async () => {
    const { app, saved } = makeApp()
    const wf = saved.save({ name: 'nightly', scriptText: SCRIPT, description: 'old' })
    const updated = await json(await app.request('/api/workflow/saved/by-name/nightly/meta', {
      method: 'POST', body: JSON.stringify({ description: 'new', whenToUse: 'when tests fail' }),
    }))
    expect(updated.ok).toBe(true)
    expect(saved.get(wf.id)).toMatchObject({ description: 'new', whenToUse: 'when tests fail' })

    expect((await json(await app.request('/api/workflow/saved/by-name/nightly', { method: 'DELETE' }))).ok).toBe(true)
    expect(saved.get(wf.id)).toBeUndefined()
  })

  it('lists the run history by the run\'s own name, with artifact chips', async () => {
    const { app, saved, journal } = makeApp()
    const wf = saved.save({ name: 'nightly', scriptText: SCRIPT })
    const created = await json(await app.request(`/api/workflow/saved/${wf.id}/run`, { method: 'POST', body: '{}' }))
    journal.appendEvent(created.runId, {
      type: 'artifact-published', instance: { siteId: 'artifact#1', ordinal: 1 },
      artifact: { id: 'report', kind: 'markdown', version: 1, title: 'Report', publishedAt: 1 },
    } as never)
    const body = await json(await app.request('/api/workflow/saved/by-name/nightly/runs'))
    expect(body.runs).toHaveLength(1)
    expect(body.runs[0]).toMatchObject({ runId: created.runId, name: 'nightly', status: 'completed' })
    expect(body.runs[0].artifacts).toEqual([{ id: 'report', kind: 'markdown', title: 'Report', version: 1 }])
    expect(body.truncated).toBeUndefined()
    expect((await app.request('/api/workflow/saved/by-name/nope/runs')).status).toBe(404)
  })

  it('honestly refuses moveSavedWorkflow (one machine-wide store, nothing to move)', async () => {
    const { app, saved } = makeApp()
    saved.save({ name: 'nightly', scriptText: SCRIPT, scope: 'global' })
    const res = await app.request('/api/workflow/saved/by-name/nightly/move', { method: 'POST' })
    expect(res.status).toBe(501)
    expect((await json(res)).reason).toBe('unsupported')
  })
})
