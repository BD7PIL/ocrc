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
  type RunEvent,
  type RunSettlement,
  type StoredEvent,
} from '../../../vendor/zcode-dwf/dist/dynamic-workflow/src/index.js'
import { runWorkflowScript } from '../../../vendor/zcode-dwf/dist/dynamic-workflow-runtime/src/index.js'
import type { BackendRegistry } from '../agent/registry.js'
import type { ArtifactStore } from './artifacts.js'
import type { WorkflowJournal } from './journal.js'
import type { RunToolJoin } from './journal.js'
import { createWorkflowDriver, type ActorModel, type WorkflowDriverHandle } from './driver.js'
import type { WorldReader } from './world.js'
import { analyzePhases } from './phases.js'
import { projectRun, type ProjectedRun } from './projection.js'
import type { EscalationRegistry } from './escalations.js'
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
  /** The declared `phase("…")` table + parallelism map (`run-launched` metadata). */
  phaseNames?: string[]
  phaseAlongside?: number[][]
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

  // The declared phase table rides `run-launched` (the engine never reads it, it only
  // journals it), and the panel's mini rail draws from there. Cheap for the common case:
  // a script with no `phase(` marker has no phase vocabulary to find.
  const declaredPhases = analyzePhases(scriptText)

  return {
    ok: true,
    diagnostics: [],
    askSpecs: buildAskSpecs(table, schemas),
    lowered: lowerWorkflow(workflow, table).code,
    // The hash is of the AUTHOR's text, not the lowered body: resume compares
    // author text, so hashing what we happen to execute would silently misalign.
    scriptHash: createHash('sha256').update(scriptText, 'utf8').digest('hex'),
    declaredRunCommands: [...worldRun.commands],
    ...declaredPhases,
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
  /**
   * The turn that launched the run (`run-launched.inputId`). The engine journals it and
   * the model-facing notification hangs off it; when the caller has no turn id (a CLI or
   * HTTP submit) the manager mints one, because the field is host metadata either way.
   */
  inputId?: string
  toolCallId?: string
  /**
   * P4-1a: which tool call started this run. The panel joins the run to its tool card
   * with this pair (the card's own `toolCallId` is minted by the engine after the call
   * returns, so it cannot be known here).
   */
  toolJoin?: RunToolJoin
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
  /**
   * Boundary C fan-out. The engine has ALREADY journaled the event before calling
   * `driver.emit` (engine.ts: "每个事件既落 journal（dwf_event，持久）又经
   * driver.emit 扇出"), so this hook must never append again — it is the live
   * notification path, not a second writer.
   */
  onEvent?: (runId: string, event: RunEvent) => void
  /** Run reached a terminal state (notifications). */
  onSettled?: (record: RunRecord, settlement: RunSettlement) => void
  /** Approve a `world.run` command (the host's policy gate). */
  approveRun?: (runId: string, cmd: string, args: string[]) => Promise<boolean> | boolean
  personaPrelude?: string
  /** Token/tool accounting for an actor session (drives the budget gate). */
  readStats?: (sessionId: string) => Promise<import('../../../vendor/zcode-dwf/dist/dynamic-workflow/src/index.js').AskStats | undefined>
  /** Test seams. */
  runScript?: typeof runWorkflowScript
  now?: () => number
  /** Process concurrency ceiling; defaults to the vendored formula. */
  ceiling?: number
  /** P4-1a: the escalation registry the run projection reads pending questions from. */
  escalations?: EscalationRegistry
}

export interface WorkflowManager {
  submit(input: SubmitInput): Promise<{ ok: true; runId: string } | { ok: false; error: string; diagnostics?: CompileOutcome['diagnostics'] }>
  list(): RunRecord[]
  get(runId: string): WorkflowRunView | undefined
  events(runId: string, opts?: { afterSequence?: number; limit?: number }): StoredEvent[]
  /**
   * P4-1a: the vendored run state the panel reads, for one session (or every run).
   * Recomputed from the journal on every call — the journal is the single source of
   * truth and the projection is a pure function of it.
   */
  projectedRuns(sessionId?: string): ProjectedRun[]
  /** Same, for one run (the side pages). */
  projectedRun(runId: string): ProjectedRun | undefined
  /** The run that owns a parent session (tool-card join / notification anchor). */
  runsForSession(sessionId: string): RunRecord[]
  /**
   * The run an *actor* session belongs to. Actor sessions are minted by the driver and
   * recorded on the actor rows, so this is a journal read — and it is how an actor-side
   * tool call (escalate / submit_result) finds the run to talk to.
   */
  runForActorSession(sessionId: string): string | undefined
  /** The tool call that started a run (the panel's card join input). */
  runJoin(runId: string): RunToolJoin | undefined
  /**
   * P4-1c: change one setting on a *live* run, in place — same runId, no successor, no
   * ask lost (the vendored `amendWorkflowRunSettings` command's semantics for the
   * concurrency knob). Returns the new caps, or a refusal reason.
   */
  amendSettings(runId: string, patch: { maxConcurrency?: number }): { ok: true; maxConcurrency: number } | { ok: false; error: string }
  cancel(runId: string, reason?: 'user' | 'model'): boolean
  resume(runId: string): Promise<{ ok: true } | { ok: false; error: string; diagnostics?: CompileOutcome['diagnostics'] }>
  /** Supersede a run with a revised script: new run, lineage pointer to the old. */
  amend(runId: string, scriptText: string, opts?: { toolJoin?: RunToolJoin }): Promise<{ ok: true; runId: string } | { ok: false; error: string; diagnostics?: CompileOutcome['diagnostics'] }>
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

  /** `run-launched` metadata for a launch. The phase tables come from the compile pass
   *  (the analyzer's own vocabulary), the model string is the host's pick for this run. */
  function launchMetaFor(
    compiled: CompileOutcome,
    inputId: string | undefined,
    actorModel?: ActorModel,
  ): { inputId: string; phaseNames?: string[]; phaseAlongside?: number[][]; subagentModel?: string } {
    return {
      inputId: inputId ?? randomUUID(),
      ...(compiled.phaseNames ? { phaseNames: compiled.phaseNames } : {}),
      ...(compiled.phaseAlongside ? { phaseAlongside: compiled.phaseAlongside } : {}),
      ...(actorModel ? { subagentModel: `${actorModel.providerID}/${actorModel.modelID}` } : {}),
    }
  }

  /** The projection's artifact input: the byte store's index (content members) — the
   *  event rows in the journal supply `kind` and the preset declarations. */
  function artifactFacts(runId: string) {
    return deps.artifacts.listVersions(runId).map((v) => ({
      id: v.id,
      // The store only ever holds content members; presets never reach it.
      kind: 'file',
      version: v.version,
      contentType: v.contentType,
      bytes: v.bytes,
    }))
  }

  function project(runId: string): ProjectedRun | undefined {
    const record = deps.journal.getRun(runId)
    if (!record) return undefined
    return projectRun({
      record,
      actors: deps.journal.listActors(runId),
      nodes: deps.journal.listNodes(runId),
      events: deps.journal.allEvents(runId),
      artifacts: artifactFacts(runId),
      escalations: deps.escalations?.all(runId) ?? [],
      ceiling,
    })
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
    /** `run-launched` metadata: the turn anchor and the declared phase tables. */
    launchMeta?: { inputId: string; phaseNames?: string[]; phaseAlongside?: number[][]; subagentModel?: string }
  }): Promise<void> {
    const abort = new AbortController()
    // The engine hands us its report sink only when it constructs the driver
    // (`makeDriver(sink)`), which happens after this entry exists — so the entry
    // is created first and the driver is filled in by the factory below.
    const entry: Live = { abort, driver: undefined as unknown as WorkflowDriverHandle }
    const makeDriver = (sink: import('../../../vendor/zcode-dwf/dist/dynamic-workflow/src/index.js').WorkflowReportSink) => {
      const driver = createWorkflowDriver({
        runId: input.runId,
        registry: deps.registry,
        journal: deps.journal,
        world: deps.world,
        artifacts: deps.artifacts,
        sink,
        cwd: input.cwd,
        ...(input.actorModel ? { actorModel: input.actorModel } : {}),
        ...(deps.personaPrelude ? { personaPrelude: deps.personaPrelude } : {}),
        ...(deps.readStats ? { readStats: deps.readStats } : {}),
        maxConcurrency: input.caps.maxConcurrency,
        onActorSession: (sessionId, actor, name) => {
          log.info(`run ${input.runId.slice(-8)} actor ${name ?? `${actor.siteId}#${actor.ordinal}`} → session ${sessionId.slice(-8)}`)
        },
        emitEvent: (event) => {
          deps.onEvent?.(input.runId, event)
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
      entry.driver = driver
      return driver
    }

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
      ...(input.launchMeta ? { launch: input.launchMeta } : {}),
    })
    live.delete(input.runId)
    const record = deps.journal.getRun(input.runId)
    if (record) deps.onSettled?.(record, settlement)
    // A settled run has nobody listening: the escalation registry is in-memory by
    // contract, and a terminal run "欠谁一个答案" is always false.
    deps.escalations?.clear(input.runId)
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
      if (input.toolJoin) deps.journal.updateRunJoin(runId, input.toolJoin)
      void launch({
        runId,
        scriptText: input.scriptText,
        compiled: compiled as CompileOutcome & { ok: true },
        cwd: input.cwd,
        caps,
        ...(input.actorModel ? { actorModel: input.actorModel } : {}),
        ...(input.tokenBudget ? { tokenBudget: input.tokenBudget } : {}),
        launchMeta: launchMetaFor(compiled, input.inputId, input.actorModel),
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

    projectedRuns(sessionId) {
      const records = deps.journal.listRuns()
      const scoped = sessionId ? records.filter((r) => r.parentSessionId === sessionId) : records
      const out: ProjectedRun[] = []
      for (const record of scoped) {
        const projected = project(record.runId)
        if (projected) out.push(projected)
      }
      return out
    },

    projectedRun(runId) {
      return project(runId)
    },

    runsForSession(sessionId) {
      return deps.journal.listRuns().filter((r) => r.parentSessionId === sessionId)
    },

    runForActorSession(sessionId) {
      for (const record of deps.journal.listRuns()) {
        if (deps.journal.listActors(record.runId).some((a) => a.sessionId === sessionId)) return record.runId
      }
      return undefined
    },

    runJoin(runId) {
      return deps.journal.getRunJoin(runId)
    },

    amendSettings(runId, patch) {
      const record = deps.journal.getRun(runId)
      if (!record) return { ok: false, error: 'not_found' }
      const entry = live.get(runId)
      if (!entry) {
        // A settled run has no in-flight asks to re-throttle; changing its row would
        // only rewrite history. The honest answer is "start a run to change its caps".
        return { ok: false, error: 'not_running' }
      }
      if (patch.maxConcurrency === undefined) return { ok: false, error: 'nothing_to_change' }
      const next = Math.max(1, Math.min(Math.floor(patch.maxConcurrency), ceiling))
      // The caps write and the seat-gate change are one step: the vendored contract
      // requires them to agree (`run-caps-changed` carries both, and a resume reads
      // the row back). The driver emits `run-caps-changed`; we own the row.
      entry.driver.setMaxConcurrency(next)
      const caps: Caps = { ...record.caps, maxConcurrency: next }
      deps.journal.updateRunCaps(runId, caps)
      return { ok: true, maxConcurrency: next }
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
      if (record.stopReason === 'superseded') {
        // A superseded run was stopped *because* its revision is alive; resuming it
        // would run two generations of the same lineage side by side. The projection
        // says `resumable: false` for exactly this case, and the two must agree.
        return { ok: false, error: 'not_resumable:superseded' }
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
        // A resume re-runs the script; the actor model is pinned by the predecessor's
        // records, so it is not re-supplied here.
        launchMeta: launchMetaFor(compiled, undefined),
      })
      return { ok: true }
    },

    async amend(runId, scriptText, opts) {
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
      if (opts?.toolJoin) deps.journal.updateRunJoin(nextRunId, opts.toolJoin)
      void launch({
        runId: nextRunId,
        scriptText,
        compiled: compiled as CompileOutcome & { ok: true },
        cwd: predecessor.cwd ?? process.cwd(),
        caps,
        launchMeta: launchMetaFor(compiled, undefined),
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
