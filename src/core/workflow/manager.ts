import { createHash, randomUUID } from 'node:crypto'
import { availableParallelism } from 'node:os'
import {
  buildAskSpecs,
  collectSites,
  collectWorldRunCommands,
  createWorkflowProgram,
  lowerWorkflow,
  synthesizeAskSchemas,
  validate,
  type AskSpec,
  type Caps,
  type RunRecord,
  type RunSettlement,
  type StoredEvent,
} from '../../../vendor/zcode-dwf/dist/dynamic-workflow/src/index.js'
import { runWorkflowScript } from '../../../vendor/zcode-dwf/dist/dynamic-workflow-runtime/src/index.js'
import type { BackendRegistry } from '../agent/registry.js'
import type { ArtifactStore } from './artifacts.js'
import type { WorkflowJournal } from './journal.js'
import { createWorkflowDriver, type ActorModel, type WorkflowDriverHandle } from './driver.js'
import type { WorldReader } from './world.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('workflow')

/**
 * The workflow manager — ocrc's side of the vendored engine's run lifecycle.
 *
 * It owns what the engine deliberately does not: compiling the script once,
 * minting run ids, keeping the process-level concurrency ceiling, the token budget
 * gate, cancellation, cold recovery, and the driver wiring. Everything about run
 * *semantics* (replay, repair/nudge, settlement) stays in the vendored engine.
 */

export interface CompileOutcome {
  ok: boolean
  diagnostics: Array<{ code: number; line?: number; column?: number; message: string }>
  askSpecs?: Map<string, AskSpec>
  lowered?: string
  scriptHash?: string
  declaredRunCommands?: string[]
}

/** Mirrors the upstream run service's single compile pass (see PATCHES/notes). */
export function compileScript(scriptText: string): CompileOutcome {
  const workflow = createWorkflowProgram(scriptText)
  const diagnostics = [
    ...workflow.program.getSyntacticDiagnostics(),
    ...workflow.program.getSemanticDiagnostics(),
  ].map((d) => {
    const loc = d.start === undefined ? undefined : workflow.toScriptLoc(d.start)
    return {
      code: d.code,
      ...(loc ? { line: loc.line, column: loc.column } : {}),
      message: typeof d.messageText === 'string' ? d.messageText : d.messageText.messageText,
    }
  })
  if (diagnostics.length > 0) return { ok: false, diagnostics }

  const table = collectSites(workflow)
  const { diagnostics: schemaDiagnostics, schemas } = synthesizeAskSchemas(workflow, table)
  if (schemaDiagnostics.length > 0) return { ok: false, diagnostics: schemaDiagnostics }

  const worldRun = collectWorldRunCommands(workflow, table)
  if (worldRun.diagnostics.length > 0) return { ok: false, diagnostics: worldRun.diagnostics }

  return {
    ok: true,
    diagnostics: [],
    askSpecs: buildAskSpecs(table, schemas),
    lowered: lowerWorkflow(workflow, table).code,
    // The hash is of the AUTHOR's text, not the lowered body: resume compares
    // author text, so hashing what we happen to execute would silently misalign.
    scriptHash: createHash('sha256').update(scriptText, 'utf8').digest('hex'),
    declaredRunCommands: [...worldRun.commands],
  }
}

export interface WorkflowRunView {
  record: RunRecord
  actors: ReturnType<WorkflowJournal['listActors']>
  nodes: ReturnType<WorkflowJournal['listNodes']>
}

export interface SubmitInput {
  scriptText: string
  /** Human label for the run (`CreateWorkflow`'s optional name). */
  name?: string
  /** Workspace the run executes in. */
  cwd: string
  /** Session that asked for the run (provenance + notifications). */
  parentSessionId?: string
  toolCallId?: string
  args?: Record<string, unknown>
  /** Per-run actor model. */
  actorModel?: ActorModel
  /** Token ceiling for the whole run lineage; absent = unbounded. */
  tokenBudget?: number
  /** Per-run concurrency cap; clamped to the process ceiling. */
  maxConcurrency?: number
}

export interface WorkflowManagerDeps {
  registry: BackendRegistry
  journal: WorkflowJournal
  world: WorldReader
  artifacts: ArtifactStore
  /** Emitted for every Boundary C event (journal already holds it). */
  onEvent?: (runId: string, event: StoredEvent) => void
  /** Run reached a terminal state (notifications). */
  onSettled?: (record: RunRecord, settlement: RunSettlement) => void
  /** Approve a `world.run` command (the host's policy gate). */
  approveRun?: (runId: string, cmd: string, args: string[]) => Promise<boolean> | boolean
  personaPrelude?: string
  /** Test seams. */
  runScript?: typeof runWorkflowScript
  now?: () => number
  /** Process concurrency ceiling; defaults to the vendored formula. */
  ceiling?: number
}

export interface WorkflowManager {
  submit(input: SubmitInput): Promise<{ ok: true; runId: string } | { ok: false; error: string; diagnostics?: CompileOutcome['diagnostics'] }>
  list(): RunRecord[]
  get(runId: string): WorkflowRunView | undefined
  events(runId: string, opts?: { afterSequence?: number; limit?: number }): StoredEvent[]
  cancel(runId: string, reason?: 'user' | 'model'): boolean
  resume(runId: string): Promise<{ ok: true } | { ok: false; error: string; diagnostics?: CompileOutcome['diagnostics'] }>
  /** Supersede a run with a revised script: new run, lineage pointer to the old. */
  amend(runId: string, scriptText: string): Promise<{ ok: true; runId: string } | { ok: false; error: string; diagnostics?: CompileOutcome['diagnostics'] }>
  /** In-flight runs in this process (diagnostics / dispose). */
  live(): string[]
  /** P3: the live driver for a run, so actor-side tools can reach it. */
  driverFor(runId: string): WorkflowDriverHandle | undefined
  /**
   * A session's turn ended. Routes to whichever live run owns that session as an
   * actor — the host calls this from its single relay hook (the same one the goal
   * loop hangs off), so nothing else has to know about actor sessions.
   */
  handleTurnEnd(sessionId: string): Promise<void>
  /** P3: a `submit_result` tool call from an actor session. */
  submitFromSession(sessionId: string, payload: unknown): boolean
  /** Cold start: runs left `running` by a dead process become `interrupted`. */
  recoverOnStart(): number
  stop(): void
}

const TERMINAL = new Set(['completed', 'errored', 'stopped'])

export function createWorkflowManager(deps: WorkflowManagerDeps): WorkflowManager {
  const runScript = deps.runScript ?? runWorkflowScript
  const now = deps.now ?? (() => Date.now())
  const ceiling = deps.ceiling ?? Math.max(1, Math.min(16, availableParallelism() - 2))

  interface Live {
    abort: AbortController
    driver: WorkflowDriverHandle
  }
  const live = new Map<string, Live>()

  function mintRunId(): string {
    // Charset-safe by construction: it lands in session ids, URLs and file names.
    return `dwfrun-${randomUUID()}`
  }

  /**
   * Kick a run off. Deliberately NOT awaited by its callers: a run outlives the
   * tool call that started it (the whole point of a background workflow), so
   * submit/resume/amend return as soon as the run row exists and the sandbox has
   * been handed the work. Settlement arrives through `onSettled`.
   */
  async function launch(input: {
    runId: string
    scriptText: string
    compiled: CompileOutcome & { ok: true }
    cwd: string
    caps: Caps
    actorModel?: ActorModel
    tokenBudget?: number
  }): Promise<void> {
    const abort = new AbortController()
    let handle: WorkflowDriverHandle | undefined
    const makeDriver = (sink: import('../../../vendor/zcode-dwf/dist/dynamic-workflow/src/index.js').WorkflowReportSink) => {
      handle = createWorkflowDriver({
        runId: input.runId,
        registry: deps.registry,
        journal: deps.journal,
        world: deps.world,
        artifacts: deps.artifacts,
        sink,
        cwd: input.cwd,
        ...(input.actorModel ? { actorModel: input.actorModel } : {}),
        ...(deps.personaPrelude ? { personaPrelude: deps.personaPrelude } : {}),
        onActorSession: (sessionId, actor, name) => {
          log.info(`run ${input.runId.slice(-8)} actor ${name ?? `${actor.siteId}#${actor.ordinal}`} → session ${sessionId.slice(-8)}`)
        },
        emitEvent: (event) => {
          const stored = deps.journal.appendEvent(input.runId, event)
          deps.onEvent?.(input.runId, stored)
          // Token budget gate. It hangs off the engine's own usage event so the
          // accounting has exactly one source (the driver's askStats → the engine's
          // running total), and it stops the run the moment the ceiling is crossed
          // instead of after the next turn.
          if (event.type === 'usage-updated' && input.tokenBudget && event.spentTokens > input.tokenBudget) {
            log.warn(`run ${input.runId.slice(-8)} over budget (${event.spentTokens}/${input.tokenBudget} tokens) — stopping`)
            entry.abort.abort('user')
          }
        },
      })
      return handle
    }

    const entry: Live = { abort, driver: handle as unknown as WorkflowDriverHandle }
    live.set(input.runId, entry)

    const settlement = await runScript({
      scriptText: input.scriptText,
      ...(input.compiled.lowered ? { lowered: input.compiled.lowered } : {}),
      runId: input.runId,
      cwd: input.cwd,
      makeDriver,
      caps: input.caps,
      askSpecs: input.compiled.askSpecs as ReadonlyMap<string, AskSpec>,
      validate: (schema, value) => validate(schema as never, value),
      signal: abort.signal,
    })
    // The driver is created inside makeDriver, which the harness always calls
    // before running — so `handle` is set by here.
    if (handle) entry.driver = handle

    live.delete(input.runId)
    const record = deps.journal.getRun(input.runId)
    if (record) deps.onSettled?.(record, settlement)
    log.info(`run ${input.runId.slice(-8)} settled: ${settlement.status}`)
  }

  return {
    async submit(input) {
      const compiled = compileScript(input.scriptText)
      if (!compiled.ok) {
        return { ok: false, error: 'compile_failed', diagnostics: compiled.diagnostics }
      }
      const runId = mintRunId()
      const caps: Caps = { maxConcurrency: Math.max(1, Math.min(input.maxConcurrency ?? 4, ceiling)) }
      // The row exists before we return, so a caller can immediately read the run
      // back (and a crash between here and the first event still leaves a run that
      // cold recovery can mark interrupted).
      deps.journal.createRun({
        runId,
        caps,
        spentTokens: 0,
        status: 'running',
        cwd: input.cwd,
        scriptText: input.scriptText,
        ...(compiled.scriptHash ? { scriptHash: compiled.scriptHash } : {}),
        ...(input.name ? { name: input.name } : {}),
        ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
        ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
        ...(input.args ? { args: input.args } : {}),
      })
      void launch({
        runId,
        scriptText: input.scriptText,
        compiled: compiled as CompileOutcome & { ok: true },
        cwd: input.cwd,
        caps,
        ...(input.actorModel ? { actorModel: input.actorModel } : {}),
        ...(input.tokenBudget ? { tokenBudget: input.tokenBudget } : {}),
      })
      return { ok: true, runId }
    },

    list() {
      return deps.journal.listRuns()
    },

    get(runId) {
      const record = deps.journal.getRun(runId)
      if (!record) return undefined
      return { record, actors: deps.journal.listActors(runId), nodes: deps.journal.listNodes(runId) }
    },

    events(runId, opts) {
      return deps.journal.listEvents(runId, opts)
    },

    cancel(runId, reason = 'user') {
      const entry = live.get(runId)
      if (!entry) return false
      entry.abort.abort(reason)
      return true
    },

    async resume(runId) {
      const record = deps.journal.getRun(runId)
      if (!record) return { ok: false, error: 'not_found' }
      if (record.status !== 'stopped') {
        // The vendored contract: only a stopped run is resumable byte-identically.
        // An errored run needs a revised script (amend), a completed one is done.
        return { ok: false, error: `not_resumable:${record.status}` }
      }
      if (!record.scriptText) return { ok: false, error: 'no_script' }
      const compiled = compileScript(record.scriptText)
      if (!compiled.ok) return { ok: false, error: 'compile_failed', diagnostics: compiled.diagnostics }
      if (record.scriptHash && compiled.scriptHash !== record.scriptHash) {
        return { ok: false, error: 'script_changed' }
      }
      deps.journal.updateRunStatus(runId, 'running')
      void launch({
        runId,
        scriptText: record.scriptText,
        compiled: compiled as CompileOutcome & { ok: true },
        cwd: record.cwd ?? process.cwd(),
        caps: record.caps,
      })
      return { ok: true }
    },

    async amend(runId, scriptText) {
      const predecessor = deps.journal.getRun(runId)
      if (!predecessor) return { ok: false, error: 'not_found' }
      if (!TERMINAL.has(predecessor.status)) {
        // Supersede is explicit: stop the old run first, then start the revision.
        return { ok: false, error: 'still_running' }
      }
      const compiled = compileScript(scriptText)
      if (!compiled.ok) return { ok: false, error: 'compile_failed', diagnostics: compiled.diagnostics }

      const nextRunId = mintRunId()
      // Supersede: the predecessor is marked stopped(superseded) and never touched
      // again; the new run carries the lineage pointer. The imported cache (which
      // lets the revision reuse finished actor work) is built from the predecessor
      // journal — that port lands with the AmendWorkflow tool face (P4), so a
      // revision here re-runs the script rather than replaying its cache.
      deps.journal.updateRunStatus(runId, 'stopped', { stopReason: 'superseded', supersededBy: nextRunId })
      const caps: Caps = { maxConcurrency: predecessor.caps.maxConcurrency }
      deps.journal.createRun({
        runId: nextRunId,
        caps,
        spentTokens: 0,
        status: 'running',
        cwd: predecessor.cwd ?? process.cwd(),
        scriptText,
        ...(compiled.scriptHash ? { scriptHash: compiled.scriptHash } : {}),
        ...(predecessor.name ? { name: predecessor.name } : {}),
        ...(predecessor.parentSessionId ? { parentSessionId: predecessor.parentSessionId } : {}),
        ...(predecessor.toolCallId ? { toolCallId: predecessor.toolCallId } : {}),
        ...(predecessor.args ? { args: predecessor.args } : {}),
        resumedFrom: runId,
      })
      void launch({
        runId: nextRunId,
        scriptText,
        compiled: compiled as CompileOutcome & { ok: true },
        cwd: predecessor.cwd ?? process.cwd(),
        caps,
      })
      return { ok: true, runId: nextRunId }
    },

    live() {
      return [...live.keys()]
    },

    driverFor(runId) {
      return live.get(runId)?.driver
    },

    async handleTurnEnd(sessionId) {
      for (const entry of live.values()) {
        if (!entry.driver.inFlightSessions().includes(sessionId)) continue
        await entry.driver.notifyTurnEnd(sessionId)
        return
      }
    },

    submitFromSession(sessionId, payload) {
      for (const entry of live.values()) {
        if (!entry.driver.inFlightSessions().includes(sessionId)) continue
        entry.driver.submit(sessionId, payload)
        return true
      }
      return false
    },

    recoverOnStart() {
      let recovered = 0
      for (const record of deps.journal.listRuns()) {
        if (record.status !== 'running' && record.status !== 'pending') continue
        // A run left `running` by a dead process is `interrupted` (resumable), and
        // we never auto-resume: the actor sessions it owns are the user's to
        // inspect, and re-running spends tokens.
        deps.journal.updateRunStatus(record.runId, 'stopped', { stopReason: 'interrupted' })
        recovered++
      }
      if (recovered) log.info(`cold recovery: ${recovered} in-flight workflow run(s) marked interrupted`)
      return recovered
    },

    stop() {
      // Host shutdown: in-flight runs are stopped as `interrupted` (resumable), not
      // cancelled as user actions — see recoverOnStart for the crash path.
      for (const entry of live.values()) {
        try { entry.abort.abort('interrupted') } catch { /* already settled */ }
      }
      live.clear()
    },
  }
}
