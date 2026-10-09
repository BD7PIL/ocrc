// N12 G2 — goal manager loop tests. Everything is injected (clock, verifier,
// evidence, dispatch, registry) so the loop runs without an engine; the
// shapes mirror tests/unit/relay.test.ts (fake backend) and
// tests/unit/scheduler.test.ts (injected clock).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileBackedState } from '../../src/core/state'
import { createCardBus } from '../../src/core/card-bus'
import { singleBackendRegistry } from '../../src/core/agent/registry'
import {
  createGoalManager, parseVerification, buildContinuationPrompt, buildVerifierPrompt,
  CONTINUATION_PREFIX, MAX_ITERATIONS, type GoalDeps,
} from '../../src/core/goal'
import type { AgentBackend } from '../../src/core/agent/backend'
import type { IncomingMessage } from '../../src/core/types'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'goal-test-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** Minimal backend: only what the goal loop touches. */
function fakeBackend(over: Partial<AgentBackend> = {}): AgentBackend {
  return {
    id: 'opencode',
    capabilities: {} as AgentBackend['capabilities'],
    prompt: async () => {},
    abort: async () => {},
    hasSession: async () => true,
    listSessions: async () => [],
    listSessionSummaries: async () => [],
    createSession: async () => ({ id: 'ses_new' }),
    deleteSession: async () => {},
    renameSession: async () => {},
    getSessionMeta: async () => ({ tokens: { input: 100, output: 50 } }),
    getContext: async () => ({}),
    getHistory: async () => [],
    getMessageBlocks: async () => [],
    getDiff: async () => [],
    getTodos: async () => [],
    getSessionsStatus: async () => ({}),
    ping: async () => true,
    getAgents: async () => [],
    getModels: async () => [],
    getMcp: async () => [],
    listWorkspaces: async () => [],
    listCommands: async () => [],
    runCommand: async () => {},
    resolvePermission: async () => {},
    ...over,
  } as AgentBackend
}

interface Harness {
  manager: ReturnType<typeof createGoalManager>
  state: ReturnType<typeof createFileBackedState>
  dispatched: IncomingMessage[]
  changes: Array<{ sessionId: string; goal: unknown; verifying: boolean }>
  infos: Array<{ title: string; body: string }>
}

function harness(over: Partial<GoalDeps> = {}): Harness {
  const state = createFileBackedState(join(dir, 'state.json'))
  const dispatched: IncomingMessage[] = []
  const changes: Array<{ sessionId: string; goal: unknown; verifying: boolean }> = []
  const infos: Array<{ title: string; body: string }> = []
  const cardBus = createCardBus()
  cardBus.subscribeAll((c) => {
    if (c.kind === 'info') infos.push({ title: c.title, body: c.sections.map((s) => s.body).join('\n') })
  })
  const backend = (over as any).backend ?? fakeBackend()
  const deps: GoalDeps = {
    state,
    registry: singleBackendRegistry(backend),
    dispatch: async (msg) => { dispatched.push(msg) },
    cardBus,
    onGoalChanged: (sessionId, goal, verifying) => { changes.push({ sessionId, goal, verifying }) },
    now: () => 1_000_000,
    ...over,
  }
  delete (deps as any).backend
  const manager = createGoalManager(deps)
  return { manager, state, dispatched, changes, infos }
}

describe('parseVerification', () => {
  it('accepts the exact upstream shape', () => {
    expect(parseVerification('{"passed": true, "reason": "done", "nextAction": ""}'))
      .toEqual({ passed: true, reason: 'done' })
  })

  it('keeps a non-empty nextAction', () => {
    expect(parseVerification('{"passed": false, "reason": "gap", "nextAction": " fix A "}'))
      .toEqual({ passed: false, reason: 'gap', nextAction: 'fix A' })
  })

  it('tolerates prose around the object', () => {
    expect(parseVerification('Sure:\n```json\n{"passed": false, "reason": "x"}\n```'))
      .toEqual({ passed: false, reason: 'x' })
  })

  it('fails closed on anything without a boolean passed (upstream would pass)', () => {
    expect(parseVerification('not json')).toBeUndefined()
    expect(parseVerification('{"reason": "no passed field"}')).toBeUndefined()
    expect(parseVerification('{"passed": "true"}')).toBeUndefined()
    expect(parseVerification('[1,2]')).toBeUndefined()
    expect(parseVerification(undefined)).toBeUndefined()
  })
})

describe('goal manager', () => {
  it('set → active record with a fresh iteration and run clock', () => {
    const h = harness()
    const res = h.manager.set('ses_1', '  把测试跑绿  ')
    expect(res.ok).toBe(true)
    const goal = h.manager.status('ses_1')!
    expect(goal).toMatchObject({ objective: '把测试跑绿', status: 'active', iteration: 1, tokensUsed: 0 })
    expect(goal.activeRunStartedAtMs).toBe(1_000_000)
    expect(h.changes.at(-1)).toMatchObject({ sessionId: 'ses_1', verifying: false })
  })

  it('rejects an empty objective and a goal under plan mode', () => {
    const h = harness({ isPlanMode: () => true })
    expect(h.manager.set('ses_1', '   ')).toEqual({ ok: false, error: 'empty_objective' })
    expect(h.manager.set('ses_1', 'do it')).toEqual({ ok: false, error: 'plan_mode' })
    expect(h.manager.status('ses_1')).toBeUndefined()
  })

  it('pass → complete, no continuation dispatched', async () => {
    const h = harness({ verify: async () => '{"passed": true, "reason": "全部完成"}' })
    h.manager.set('ses_1', '目标')
    await h.manager.handleTurnEnd('ses_1')
    const goal = h.manager.status('ses_1')!
    expect(goal.status).toBe('complete')
    expect(goal.verifications).toEqual([{ iteration: 1, outcome: 'pass', at: 1_000_000, reason: '全部完成' }])
    expect(h.dispatched).toHaveLength(0)
    expect(h.infos.map((i) => i.title)).toContain('目标已完成')
    // accounting ran: cumulative tokens sampled from getSessionMeta
    expect(goal.tokensUsed).toBe(150)
    expect(goal.timeUsedSeconds).toBe(0)
  })

  it('not satisfied + nextAction → bumps iteration and dispatches a continuation', async () => {
    const h = harness({
      verify: async () => '{"passed": false, "reason": "还差 A", "nextAction": "完成 A"}',
    })
    h.manager.set('ses_1', '目标')
    await h.manager.handleTurnEnd('ses_1')

    const goal = h.manager.status('ses_1')!
    expect(goal.status).toBe('active')
    expect(goal.iteration).toBe(2)
    expect(goal.verifications).toEqual([
      { iteration: 1, outcome: 'notSatisfied', at: 1_000_000, reason: '还差 A', nextAction: '完成 A' },
    ])
    expect(goal.iterations.map((i) => i.iteration)).toEqual([1, 2])

    expect(h.dispatched).toHaveLength(1)
    const msg = h.dispatched[0]
    expect(msg.sessionId).toBe('ses_1')
    expect(msg.origin).toBe('goalContinuation')
    expect(msg.text.startsWith(CONTINUATION_PREFIX)).toBe(true)
    expect(msg.text).toContain('<untrusted_objective>')
    expect(msg.text).toContain('完成 A')
  })

  it('not satisfied without nextAction → paused, nothing dispatched', async () => {
    const h = harness({ verify: async () => '{"passed": false, "reason": "没线索"}' })
    h.manager.set('ses_1', '目标')
    await h.manager.handleTurnEnd('ses_1')
    expect(h.manager.status('ses_1')!.status).toBe('paused')
    expect(h.dispatched).toHaveLength(0)
    expect(h.infos.map((i) => i.title)).toContain('目标已暂停')
  })

  it('fails closed on a broken verifier (no valid JSON) — upstream would pass', async () => {
    const h = harness({ verify: async () => 'the model rambled without JSON' })
    h.manager.set('ses_1', '目标')
    await h.manager.handleTurnEnd('ses_1')
    const goal = h.manager.status('ses_1')!
    expect(goal.status).toBe('paused')
    expect(goal.verifications[0]).toMatchObject({ outcome: 'failed', iteration: 1 })
    expect(h.dispatched).toHaveLength(0)
  })

  it('fails closed when the verifier call itself throws / returns undefined', async () => {
    const h = harness({ verify: async () => { throw new Error('provider down') } })
    h.manager.set('ses_1', '目标')
    await h.manager.handleTurnEnd('ses_1')
    expect(h.manager.status('ses_1')!.verifications[0]).toMatchObject({ outcome: 'failed' })
  })

  it('gate: iteration cap stops the loop at MAX_ITERATIONS', async () => {
    const h = harness({
      verify: async () => `{"passed": false, "reason": "还没", "nextAction": "下一步 ${Math.random()}"}`,
    })
    h.manager.set('ses_1', '目标')
    // Drive turns until the cap bites (each turn advances one iteration).
    for (let i = 0; i < MAX_ITERATIONS + 3; i++) await h.manager.handleTurnEnd('ses_1')
    const goal = h.manager.status('ses_1')!
    expect(goal.status).toBe('paused')
    expect(goal.iteration).toBeLessThanOrEqual(MAX_ITERATIONS)
    expect(h.infos.some((i) => i.body.includes('迭代上限'))).toBe(true)
  })

  it('gate: two identical nextActions in a row stop the loop', async () => {
    const h = harness({
      verify: async () => '{"passed": false, "reason": "还是它", "nextAction": "修同一个东西"}',
    })
    h.manager.set('ses_1', '目标')
    await h.manager.handleTurnEnd('ses_1') // iteration 1 → notSatisfied, continues
    expect(h.manager.status('ses_1')!.status).toBe('active')
    await h.manager.handleTurnEnd('ses_1') // iteration 2 → same nextAction → stall
    const goal = h.manager.status('ses_1')!
    expect(goal.status).toBe('paused')
    expect(h.infos.some((i) => i.body.includes('无进展'))).toBe(true)
    expect(h.dispatched).toHaveLength(1) // only the first continuation went out
  })

  it('gate: token budget stops the loop with budget_limited', async () => {
    const h = harness({
      verify: async () => '{"passed": false, "reason": "没完", "nextAction": "继续"}',
      backend: undefined,
    })
    h.manager.set('ses_1', '目标', { tokenBudget: 100 }) // backend reports 150 used
    await h.manager.handleTurnEnd('ses_1')
    const goal = h.manager.status('ses_1')!
    expect(goal.status).toBe('budget_limited')
    expect(goal.tokensUsed).toBe(150)
    expect(h.dispatched).toHaveLength(0)
  })

  it('pause/resume round-trips and restarts the run clock', () => {
    let clock = 1_000_000
    const h = harness({ now: () => clock })
    h.manager.set('ses_1', '目标')
    expect(h.manager.pause('ses_1').ok).toBe(true)
    expect(h.manager.status('ses_1')!.status).toBe('paused')
    expect(h.manager.status('ses_1')!.activeRunStartedAtMs).toBeUndefined()
    expect(h.manager.pause('ses_1')).toEqual({ ok: false, error: 'not_active' })
    clock = 2_000_000
    expect(h.manager.resume('ses_1').ok).toBe(true)
    expect(h.manager.status('ses_1')).toMatchObject({ status: 'active', activeRunStartedAtMs: 2_000_000 })
    expect(h.manager.resume('ses_1')).toEqual({ ok: false, error: 'not_paused' })
  })

  it('refuses set/resume under plan mode (mutual exclusion)', () => {
    let plan = false
    const h = harness({ isPlanMode: () => plan })
    h.manager.set('ses_1', '目标')
    h.manager.pause('ses_1')
    plan = true
    expect(h.manager.resume('ses_1')).toEqual({ ok: false, error: 'plan_mode' })
    expect(h.manager.status('ses_1')!.status).toBe('paused')
  })

  it('a paused goal is inert at turn end', async () => {
    const verify = vi.fn(async () => '{"passed": true, "reason": "x"}')
    const h = harness({ verify })
    h.manager.set('ses_1', '目标')
    h.manager.pause('ses_1')
    await h.manager.handleTurnEnd('ses_1')
    expect(verify).not.toHaveBeenCalled()
  })

  it('clear removes the record and pushes an undefined goal', () => {
    const h = harness()
    h.manager.set('ses_1', '目标')
    expect(h.manager.clear('ses_1')).toBe(true)
    expect(h.manager.status('ses_1')).toBeUndefined()
    expect(h.changes.at(-1)).toMatchObject({ goal: undefined })
    expect(h.manager.clear('ses_1')).toBe(false)
  })

  it('verifying is observable while the verifier runs (bridge derives the state)', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const h = harness({
      verify: async () => { await gate; return '{"passed": true, "reason": "ok"}' },
    })
    h.manager.set('ses_1', '目标')
    const p = h.manager.handleTurnEnd('ses_1')
    await Promise.resolve()
    expect(h.manager.isVerifying('ses_1')).toBe(true)
    expect(h.changes.some((c) => c.verifying)).toBe(true)
    release()
    await p
    expect(h.manager.isVerifying('ses_1')).toBe(false)
  })

  it('re-entrancy: a continuation turn ending while one is in flight is ignored', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const verify = vi.fn(async () => { await gate; return '{"passed": false, "reason": "x", "nextAction": "y"}' })
    const h = harness({ verify })
    h.manager.set('ses_1', '目标')
    const p1 = h.manager.handleTurnEnd('ses_1')
    await Promise.resolve()
    await h.manager.handleTurnEnd('ses_1') // concurrent — must be dropped
    release()
    await p1
    expect(verify).toHaveBeenCalledTimes(1)
  })

  it('cold recovery pauses active goals and leaves others alone', () => {
    const h = harness()
    h.manager.set('ses_a', '目标 A')
    h.manager.set('ses_b', '目标 B')
    h.manager.pause('ses_b')
    expect(h.manager.recoverOnStart()).toBe(1)
    expect(h.manager.status('ses_a')!.status).toBe('paused')
    expect(h.manager.status('ses_a')!.activeRunStartedAtMs).toBeUndefined()
    expect(h.manager.status('ses_b')!.status).toBe('paused')
  })

  it('recovers goals from a previous process (persisted state)', async () => {
    const path = join(dir, 'state.json')
    const state = createFileBackedState(path)
    const m1 = createGoalManager({
      state,
      registry: singleBackendRegistry(fakeBackend()),
      dispatch: async () => {},
      cardBus: createCardBus(),
      now: () => 1_000_000,
    })
    m1.set('ses_1', '重启前的目标')
    await state.flush()
    const state2 = createFileBackedState(path)
    const m2 = createGoalManager({
      state: state2,
      registry: singleBackendRegistry(fakeBackend()),
      dispatch: async () => {},
      cardBus: createCardBus(),
      now: () => 2_000_000,
    })
    expect(m2.recoverOnStart()).toBe(1)
    expect(m2.status('ses_1')).toMatchObject({ objective: '重启前的目标', status: 'paused' })
  })

  it('stop() makes further turn ends inert', async () => {
    const verify = vi.fn(async () => '{"passed": true, "reason": "x"}')
    const h = harness({ verify })
    h.manager.set('ses_1', '目标')
    h.manager.stop()
    await h.manager.handleTurnEnd('ses_1')
    expect(verify).not.toHaveBeenCalled()
  })

  it('collects todo items onto the iteration the continuation closes', async () => {
    const backend = fakeBackend({
      getTodos: async () => [
        { id: 't1', content: 'A', status: 'completed' },
        { id: 't2', content: 'B', status: 'in_progress' },
      ],
    })
    const h = harness({ backend, verify: async () => '{"passed": false, "reason": "x", "nextAction": "y"}' })
    h.manager.set('ses_1', '目标')
    await h.manager.handleTurnEnd('ses_1')
    const goal = h.manager.status('ses_1')!
    const first = goal.iterations.find((i) => i.iteration === 1)!
    expect(first.items).toEqual([
      { id: 't1', content: 'A', status: 'completed' },
      { id: 't2', content: 'B', status: 'pending' },
    ])
  })

  it('injected evidence feeds the verifier prompt', async () => {
    const seen: string[] = []
    const h = harness({
      collectEvidence: async () => 'TODO: 还差 B',
      verify: async (_sid, prompt) => { seen.push(prompt); return '{"passed": true, "reason": "ok"}' },
    })
    h.manager.set('ses_1', '目标')
    await h.manager.handleTurnEnd('ses_1')
    expect(seen[0]).toContain('<evidence>')
    expect(seen[0]).toContain('TODO: 还差 B')
    expect(seen[0]).toContain('<untrusted_objective>')
  })
})

describe('prompt builders', () => {
  const goal = { objective: '修 <脚本> & 测试', tokenBudget: 1000, tokensUsed: 250, timeUsedSeconds: 7 }

  it('continuation prompt escapes the objective and states the budget', () => {
    const text = buildContinuationPrompt(goal, { nextAction: '跑测试', reason: '还差' })
    expect(text).toContain('修 &lt;脚本&gt; &amp; 测试')
    expect(text).toContain('- Tokens remaining: 750')
    expect(text).toContain('Next action: 跑测试')
  })

  it('verifier prompt demands the exact JSON shape and carries evidence', () => {
    const text = buildVerifierPrompt({ ...goal, status: 'active' }, 'User: hi')
    expect(text).toContain('{"passed": boolean, "reason": string, "nextAction": string}')
    expect(text).toContain('<evidence>')
    expect(text).toContain('User: hi')
  })
})
