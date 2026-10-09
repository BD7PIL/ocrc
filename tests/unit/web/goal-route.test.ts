// N12 G5 — goal routes. The record is authoritative in state.json, so the route
// is thin: read it back (with the transient verifying flag) and dispatch the
// four commands. The six-state projection is the bridge's job (G7), not this one.
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileBackedState } from '../../../src/core/state'
import { createCardBus } from '../../../src/core/card-bus'
import { singleBackendRegistry } from '../../../src/core/agent/registry'
import { createGoalManager, type GoalManager } from '../../../src/core/goal'
import { registerGoal } from '../../../src/transport/web/routes/goal'
import type { AgentBackend } from '../../../src/core/agent/backend'

function fakeBackend(): AgentBackend {
  return {
    id: 'opencode', capabilities: {} as AgentBackend['capabilities'],
    prompt: async () => {}, abort: async () => {}, hasSession: async () => true,
    listSessions: async () => [], listSessionSummaries: async () => [],
    createSession: async () => ({ id: 'ses_x' }), deleteSession: async () => {}, renameSession: async () => {},
    getSessionMeta: async () => ({}), getContext: async () => ({}), getHistory: async () => [],
    getMessageBlocks: async () => [], getDiff: async () => [], getTodos: async () => [],
    getSessionsStatus: async () => ({}), ping: async () => true, getAgents: async () => [],
    getModels: async () => [], getMcp: async () => [], listWorkspaces: async () => [],
    listCommands: async () => [], runCommand: async () => {}, resolvePermission: async () => {},
  } as AgentBackend
}

function makeApp(over: { isPlanMode?: () => boolean } = {}) {
  const state = createFileBackedState(join(mkdtempSync(join(tmpdir(), 'goal-route-')), 'state.json'))
  const dispatched: any[] = []
  const manager: GoalManager = createGoalManager({
    state,
    registry: singleBackendRegistry(fakeBackend()),
    dispatch: async (msg) => { dispatched.push(msg) },
    cardBus: createCardBus(),
    now: () => 1_000_000,
    isPlanMode: over.isPlanMode,
  })
  const app = new Hono()
  registerGoal(app, manager)
  return { app, manager, state, dispatched }
}

const post = (app: Hono, body: unknown) =>
  app.request('/api/goal', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

describe('goal routes (N12)', () => {
  it('GET returns null for a session with no goal', async () => {
    const { app } = makeApp()
    const res = await app.request('/api/session/ses_1/goal')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ goal: null, verifying: false })
  })

  it('set → read back the stored record, and the kickoff turn goes out', async () => {
    const { app, dispatched } = makeApp()
    const res = await post(app, { action: 'set', sessionId: 'ses_1', objective: '让测试全绿' })
    expect(res.status).toBe(200)
    const goal = (await res.json()).goal
    expect(goal).toMatchObject({ objective: '让测试全绿', status: 'active', iteration: 1 })

    const read = await (await app.request('/api/session/ses_1/goal')).json()
    expect(read.goal).toMatchObject({ objective: '让测试全绿', status: 'active' })
    expect(read.verifying).toBe(false)
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]).toMatchObject({ sessionId: 'ses_1', origin: 'goalContinuation' })
  })

  it('set carries an optional token budget', async () => {
    const { app } = makeApp()
    const goal = (await (await post(app, { action: 'set', sessionId: 'ses_1', objective: 'x', tokenBudget: 5000 })).json()).goal
    expect(goal.tokenBudget).toBe(5000)
  })

  it('pause → resume → clear round-trips through the route', async () => {
    const { app } = makeApp()
    await post(app, { action: 'set', sessionId: 'ses_1', objective: 'x' })
    expect((await (await post(app, { action: 'pause', sessionId: 'ses_1' })).json()).goal.status).toBe('paused')
    expect((await (await post(app, { action: 'resume', sessionId: 'ses_1' })).json()).goal.status).toBe('active')
    expect((await (await post(app, { action: 'clear', sessionId: 'ses_1' })).json()).ok).toBe(true)
    expect((await (await app.request('/api/session/ses_1/goal')).json()).goal).toBeNull()
  })

  it('400s: missing sessionId, unknown action, empty objective', async () => {
    const { app } = makeApp()
    expect((await post(app, { action: 'set', objective: 'x' })).status).toBe(400)
    expect((await post(app, { action: 'nope', sessionId: 'ses_1' })).status).toBe(400)
    expect((await post(app, { action: 'set', sessionId: 'ses_1', objective: '   ' })).status).toBe(400)
  })

  it('404s: pause/resume with no goal or a wrong-state goal', async () => {
    const { app } = makeApp()
    expect((await post(app, { action: 'pause', sessionId: 'ses_1' })).status).toBe(404)
    await post(app, { action: 'set', sessionId: 'ses_1', objective: 'x' })
    expect((await post(app, { action: 'resume', sessionId: 'ses_1' })).status).toBe(404) // active, not paused
  })

  it('plan mode is surfaced as a 400 with the plan_mode error', async () => {
    const { app } = makeApp({ isPlanMode: () => true })
    const res = await post(app, { action: 'set', sessionId: 'ses_1', objective: 'x' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('plan_mode')
  })

  it('verifying rides the GET while the verifier runs', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const state = createFileBackedState(join(mkdtempSync(join(tmpdir(), 'goal-route-')), 'state.json'))
    const manager = createGoalManager({
      state,
      registry: singleBackendRegistry(fakeBackend()),
      dispatch: async () => {},
      cardBus: createCardBus(),
      verify: async () => { await gate; return '{"passed": true, "reason": "ok"}' },
    })
    const app = new Hono()
    registerGoal(app, manager)
    await post(app, { action: 'set', sessionId: 'ses_1', objective: 'x' })
    const p = manager.handleTurnEnd('ses_1')
    await Promise.resolve()
    expect((await (await app.request('/api/session/ses_1/goal')).json()).verifying).toBe(true)
    release()
    await p
    expect((await (await app.request('/api/session/ses_1/goal')).json()).verifying).toBe(false)
  })
})
