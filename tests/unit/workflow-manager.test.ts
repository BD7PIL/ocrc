// P2 — the manager owns everything the vendored engine deliberately does not:
// run ids, the run row, the process ceiling, cancellation, resume gating, amend
// lineage, cold recovery and the budget gate. The sandbox itself is stubbed here
// (deps.runScript) so these tests stay about the manager's decisions.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkflowJournal } from '../../src/core/workflow/journal'
import { createWorkflowManager, compileScript, type WorkflowManagerDeps } from '../../src/core/workflow/manager'
import { createArtifactStore } from '../../src/core/workflow/artifacts'
import { createWorldReader } from '../../src/core/workflow/world'
import { singleBackendRegistry } from '../../src/core/agent/registry'
import type { AgentBackend } from '../../src/core/agent/backend'
import type { RunSettlement } from '../../vendor/zcode-dwf/dist/dynamic-workflow/src/index.js'

const SCRIPT = `
const a = await agent("first").ask("Say one word.");
log("done");
return { a };
`

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ocrc-wf-mgr-')) })

/** A run is launched in the background (submit returns as soon as the row exists),
 *  so settle the microtask queue before asserting on the settled state. */
const settleTick = () => new Promise((r) => setTimeout(r, 20))

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

/** A sandbox stand-in: it runs the driver wiring (makeDriver) and settles the run
 *  however the test asks. */
function makeManager(over: Partial<WorkflowManagerDeps> = {}, settle: 'completed' | 'hold' = 'completed') {
  const journal = createWorkflowJournal({ dir })
  const runScript = vi.fn(async (opts: any) => {
    const driver = opts.makeDriver({} as never)
    void driver
    if (settle === 'hold') return await new Promise<RunSettlement>(() => { /* never settles */ })
    journal.updateRunStatus(opts.runId, 'completed', { result: { ok: true } })
    return { status: 'completed', artifact: { ok: true } } as RunSettlement
  })
  const settled: string[] = []
  const manager = createWorkflowManager({
    registry: singleBackendRegistry(fakeBackend()),
    journal,
    world: createWorldReader({ cwd: dir }),
    artifacts: createArtifactStore({ dir, cwd: dir }),
    runScript: runScript as never,
    ceiling: 8,
    onSettled: (record) => settled.push(record.runId),
    ...over,
  })
  return { manager, journal, runScript, settled }
}

describe('compileScript', () => {
  it('returns the lowered body, ask specs and a hash of the AUTHOR text', () => {
    const out = compileScript(SCRIPT)
    expect(out.ok).toBe(true)
    expect(out.lowered).toContain('__host')
    expect(out.askSpecs?.size).toBe(1)
    expect(out.scriptHash).toMatch(/^[0-9a-f]{64}$/)
    // Whitespace changes the hash (resume compares author text byte-for-byte).
    expect(compileScript(SCRIPT + '\n').scriptHash).not.toBe(out.scriptHash)
  })

  it('reports located diagnostics and no lowered body on a bad script', () => {
    const out = compileScript('const x: number = "nope";\nreturn x;\n')
    expect(out.ok).toBe(false)
    expect(out.lowered).toBeUndefined()
    expect(out.diagnostics.some((d) => d.code === 2322 && d.line === 1)).toBe(true)
  })
})

describe('workflow manager', () => {
  it('submits a run: row created, script hashed, sandbox launched with a driver', async () => {
    const { manager, journal, runScript, settled } = makeManager()
    const res = await manager.submit({ scriptText: SCRIPT, cwd: dir, name: 'demo' })
    expect(res.ok).toBe(true)
    const runId = (res as { runId: string }).runId
    expect(runId).toMatch(/^dwfrun-[0-9a-f-]+$/)
    await settleTick()

    const record = journal.getRun(runId)
    expect(record).toMatchObject({ name: 'demo', status: 'completed', cwd: dir, caps: { maxConcurrency: 4 } })
    expect(record?.scriptHash).toMatch(/^[0-9a-f]{64}$/)
    expect(runScript).toHaveBeenCalledTimes(1)
    expect(settled).toEqual([runId])
  })

  it('refuses to create a run when the script does not compile', async () => {
    const { manager, journal, runScript } = makeManager()
    const res = await manager.submit({ scriptText: 'const x: number = "no";\nreturn x;', cwd: dir })
    expect(res).toMatchObject({ ok: false, error: 'compile_failed' })
    expect((res as { diagnostics: unknown[] }).diagnostics.length).toBeGreaterThan(0)
    expect(journal.listRuns()).toHaveLength(0)
    expect(runScript).not.toHaveBeenCalled()
  })

  it('clamps the per-run concurrency to the process ceiling', async () => {
    const { manager, journal } = makeManager()
    const res = await manager.submit({ scriptText: SCRIPT, cwd: dir, maxConcurrency: 64 })
    const runId = (res as { runId: string }).runId
    expect(journal.getRun(runId)?.caps.maxConcurrency).toBe(8)
  })

  it('list/get/events expose the journal', async () => {
    const { manager } = makeManager()
    const res = await manager.submit({ scriptText: SCRIPT, cwd: dir })
    const runId = (res as { runId: string }).runId
    expect(manager.list().map((r) => r.runId)).toContain(runId)
    expect(manager.get(runId)?.record.runId).toBe(runId)
    expect(manager.get('nope')).toBeUndefined()
    expect(Array.isArray(manager.events(runId))).toBe(true)
  })

  it('cancel aborts only a run that is actually in flight', async () => {
    const { manager } = makeManager({}, 'hold')
    const res = await manager.submit({ scriptText: SCRIPT, cwd: dir })
    const runId = (res as { runId: string }).runId
    expect(manager.live()).toEqual([runId])
    expect(manager.cancel(runId)).toBe(true)
    expect(manager.cancel('dwfrun-absent')).toBe(false)
  })

  it('resume only accepts a stopped run with byte-identical text', async () => {
    const { manager, journal } = makeManager()
    const res = await manager.submit({ scriptText: SCRIPT, cwd: dir })
    const runId = (res as { runId: string }).runId

    // completed → not resumable
    expect(await manager.resume(runId)).toMatchObject({ ok: false, error: 'not_resumable:completed' })

    journal.updateRunStatus(runId, 'stopped', { stopReason: 'interrupted' })
    expect(await manager.resume(runId)).toMatchObject({ ok: true })
    await settleTick()
    expect(journal.getRun(runId)?.status).toBe('completed') // the stub settles it again

    expect(await manager.resume('dwfrun-absent')).toMatchObject({ ok: false, error: 'not_found' })
  })

  it('amend supersedes the predecessor and points the new run at it', async () => {
    const { manager, journal } = makeManager()
    const first = (await manager.submit({ scriptText: SCRIPT, cwd: dir })) as { runId: string }
    const amended = await manager.amend(first.runId, SCRIPT.replace('one word', 'two words'))
    expect(amended.ok).toBe(true)
    const nextId = (amended as { runId: string }).runId
    await settleTick()

    expect(journal.getRun(first.runId)).toMatchObject({ status: 'stopped', stopReason: 'superseded', supersededBy: nextId })
    expect(journal.getRun(nextId)?.resumedFrom).toBe(first.runId)
  })

  it('amend refuses a script that does not compile and leaves the predecessor alone', async () => {
    const { manager, journal } = makeManager()
    const first = (await manager.submit({ scriptText: SCRIPT, cwd: dir })) as { runId: string }
    const bad = await manager.amend(first.runId, 'const x: number = "no";\nreturn x;')
    expect(bad).toMatchObject({ ok: false, error: 'compile_failed' })
    expect(journal.getRun(first.runId)?.status).toBe('completed')
  })

  it('cold recovery turns in-flight runs into interrupted (never auto-resumes)', async () => {
    const { manager, journal } = makeManager({}, 'hold')
    const res = (await manager.submit({ scriptText: SCRIPT, cwd: dir })) as { runId: string }
    expect(journal.getRun(res.runId)?.status).toBe('running')

    // A fresh manager over the same journal = what a host restart sees.
    const restarted = createWorkflowManager({
      registry: singleBackendRegistry(fakeBackend()),
      journal,
      world: createWorldReader({ cwd: dir }),
      artifacts: createArtifactStore({ dir, cwd: dir }),
      runScript: (async () => { throw new Error('must not run') }) as never,
    })
    expect(restarted.recoverOnStart()).toBe(1)
    expect(journal.getRun(res.runId)).toMatchObject({ status: 'stopped', stopReason: 'interrupted' })
    expect(restarted.recoverOnStart()).toBe(0)
  })

  it('stops a run the moment its usage crosses the budget', async () => {
    const journal = createWorkflowJournal({ dir })
    let aborted = false
    const runScript = vi.fn(async (opts: any) => {
      const driver = opts.makeDriver({
        askSubmitAttempted: () => {}, askTurnEnded: () => {}, askProgress: () => {},
        askStats: () => {}, askFailed: () => {}, stopRun: () => {}, runStalled: () => {},
        askWaiting: () => {}, askExecuting: () => {}, askMutating: () => {}, concurrencyChanged: () => {},
      })
      opts.signal.addEventListener('abort', () => { aborted = true })
      // The engine reports usage through Boundary C; the manager watches that.
      driver.emit({ type: 'usage-updated', spentTokens: 5000 } as never)
      journal.updateRunStatus(opts.runId, 'stopped', { stopReason: 'user' })
      return { status: 'stopped', reason: 'user' } as RunSettlement
    })
    const manager = createWorkflowManager({
      registry: singleBackendRegistry(fakeBackend()),
      journal,
      world: createWorldReader({ cwd: dir }),
      artifacts: createArtifactStore({ dir, cwd: dir }),
      runScript: runScript as never,
    })
    await manager.submit({ scriptText: SCRIPT, cwd: dir, tokenBudget: 1000 })
    expect(aborted).toBe(true)
  })
})
