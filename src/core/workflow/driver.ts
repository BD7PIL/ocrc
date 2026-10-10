import type {
  ActorRef,
  ActorSessionSeed,
  AskMessage,
  AskStats,
  InstanceRef,
  PersonaSpec,
  RunEvent,
  SessionRef,
  SubmitVerdict,
  WorkflowDriver,
  WorkflowReportSink,
} from '../../../vendor/zcode-dwf/dist/dynamic-workflow/src/index.js'
import type { BackendRegistry } from '../agent/registry.js'
import type { ArtifactStore } from './artifacts.js'
import type { WorkflowJournal } from './journal.js'
import type { WorldReader } from './world.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('workflow-driver')

/**
 * The driver: everything the vendored engine cannot do itself.
 *
 * The engine is a pure deterministic state machine — it decides *what* should
 * happen and journals the decision; this file performs the side effects against
 * ocrc's engine (actor sessions, prompts, aborts) and reports back through the
 * engine's `WorkflowReportSink`.
 *
 * Two seams are worth naming up front, because they are where the design shows:
 *
 *  - **Actor sessions are journaled, not derived.** The engine wants a
 *    `(runId, actorRef)`-deterministic session so a crash+resume re-attaches to the
 *    same conversation. ocrc's backend mints session ids itself, so instead of
 *    deriving the id we persist the mapping in the journal (the actor record's
 *    `sessionId`) and reuse it on resume while the session still exists. Same
 *    guarantee, different mechanism.
 *
 *  - **Turn ends arrive from the host, not from here.** `startAsk` sends the prompt
 *    and returns; the host's relay hook later calls
 *    {@link WorkflowDriverHandle.notifyTurnEnd} for that session. The ordering
 *    matters: the relay fires it *after* the final assistant card is published, so
 *    the text we hand the engine is the same text the user sees.
 */

export interface ActorModel {
  providerID: string
  modelID: string
}

export interface WorkflowDriverDeps {
  runId: string
  registry: BackendRegistry
  journal: WorkflowJournal
  world: WorldReader
  artifacts: ArtifactStore
  /** The engine's upward report face — the manager passes the one it got from
   *  `makeDriver(sink)`. */
  sink: WorkflowReportSink
  /** Workspace the run executes in (also the actor sessions' directory). */
  cwd: string
  /** Per-run actor model; absent = the session's own default. */
  actorModel?: ActorModel
  /** The run's model-slot ceiling (caps.maxConcurrency). */
  maxConcurrency?: number
  /** Extra system text prepended to every actor's persona (the workflow skill). */
  personaPrelude?: string
  /** Register a freshly minted actor session (host bookkeeping + UI tagging). */
  onActorSession?: (sessionId: string, actor: ActorRef, name?: string) => void
  /** Boundary C fan-out: the manager journals + broadcasts the event. */
  emitEvent?: (event: RunEvent) => void
  /** Final assistant text for a session (default: backend history). */
  readFinalText?: (sessionId: string) => Promise<string>
  /** Token/tool accounting for a session (optional; stats are skipped without it). */
  readStats?: (sessionId: string) => Promise<AskStats | undefined>
}

export interface WorkflowDriverHandle extends WorkflowDriver {
  /** The engine changes the run's cap at runtime (AmendWorkflow settings). */
  setMaxConcurrency(n: number): void
  /** The host calls this when a session's turn ends (see the module doc). */
  notifyTurnEnd(sessionId: string): Promise<void>
  /**
   * A `submit_result` tool call from an actor session (wired in P3). The engine
   * validates and answers through {@link WorkflowDriver.respondToSubmit}.
   */
  submit(sessionId: string, payload: unknown): void
  /** Live asks, for the host's cancel/dispose paths. */
  inFlightSessions(): string[]
  /**
   * Sessions whose ask has not had its final boundary written yet — including asks of a
   * run that already settled, whose turn end is still coming (see `pendingBoundary`).
   */
  pendingBoundarySessions(): string[]
}

interface InFlight {
  instance: InstanceRef
  sessionId: string
  typed: boolean
  schema?: unknown
  nudged: boolean
  /** Whether this ask currently holds a model slot. */
  admitted: boolean
  /** The prompt to send once a slot frees. */
  pending?: { text: string; what: string }
}

/** Compose the prompt for one ask: persona, instructions, and — for typed asks —
 *  the schema contract the actor must satisfy through `submit_result`. */
export function buildAskPrompt(message: AskMessage, persona: PersonaSpec, prelude?: string): string {
  const parts: string[] = []
  const system = [prelude, persona.system].filter((s) => typeof s === 'string' && s.trim()).join('\n\n')
  if (system) parts.push(system)
  parts.push(message.instructions)
  if (message.typed) {
    parts.push(
      'When you are done, call the `submit_result` tool exactly once with your answer in its `result` argument. ' +
      'The value must satisfy this JSON Schema:\n' +
      JSON.stringify(message.schema, null, 2),
    )
  }
  return parts.join('\n\n')
}

/** The nudge the engine asked for: the turn ended without a `submit_result`. */
export function buildNudgePrompt(schema: unknown): string {
  return (
    'You ended your turn without calling `submit_result`, so there is no result for this task yet. ' +
    'Call `submit_result` now with your answer in `result`. It must satisfy this JSON Schema:\n' +
    JSON.stringify(schema, null, 2)
  )
}

export function createWorkflowDriver(deps: WorkflowDriverDeps): WorkflowDriverHandle {
  /** sessionId → the ask in flight on it. The engine serialises asks per actor, so
   *  one entry per session is enough. */
  const bySession = new Map<string, InFlight>()
  const byInstance = new Map<string, InFlight>()
  const instanceKey = (i: InstanceRef) => `${i.siteId}#${i.ordinal}`
  /**
   * Sessions whose asks still owe their authoritative boundary, in ask order.
   *
   * A **queue** per session, not one instance: the vendored field is defined over the
   * *complete* exchange, so for a typed ask its number can only be final at the model's
   * turn end — and the engine dispatches ask N+1 the moment N settles, while a typed ask
   * settles at *accept* (mid-turn). So one actor can have two exchanges outstanding at
   * once, and the turn end that arrives belongs to the oldest of them. A single slot per
   * session silently overwrote the older ask and left it frozen at its provisional count.
   *
   * The queue also survives `dispose()`, which the engine calls the instant a run settles
   * (engine-settlement.js). dispose ends the run's command surface (cancels, aborts, the
   * seat queue); a boundary read is none of those — it is a bookkeeping write to a journal
   * the run still owns — so the host's post-settlement turn-end path (manager
   * `settledDrivers`) can still land the number the contract asks for.
   */
  const pendingBoundary = new Map<string, InstanceRef[]>()
  const queueBoundary = (sessionId: string, instance: InstanceRef) => {
    const queue = pendingBoundary.get(sessionId) ?? []
    queue.push(instance)
    pendingBoundary.set(sessionId, queue)
  }
  /** The oldest outstanding exchange on this session, if any. */
  function takeBoundary(sessionId: string): InstanceRef | undefined {
    const queue = pendingBoundary.get(sessionId)
    const next = queue?.shift()
    if (queue && queue.length === 0) pendingBoundary.delete(sessionId)
    return next
  }

  const backend = () => deps.registry.active()

  // ── run-level seat gate ────────────────────────────────────────────────────
  // The engine journals `caps.maxConcurrency` but does not enforce it: admission
  // is the driver's side (the core is a pure state machine with no notion of a
  // running model request). So the run's concurrency ceiling lives here, and the
  // contract's vocabulary is what reports it: a queued ask is `askWaiting` with
  // cause 'slot', a started one is `askExecuting`.
  let cap = Math.max(1, deps.maxConcurrency ?? 4)
  let inFlight = 0
  const queue: InFlight[] = []

  /**
   * The read window for a boundary measurement.
   *
   * The boundary is a **contract number** (a seeding implementation copies exactly this
   * many units), so it must be the transcript's real length, not the length of the page
   * `getHistory` defaults to — that default is 50, which made every busy actor report `50`
   * regardless of how much it had said. 1000 cards is far past any actor transcript this
   * design produces (an actor is one persona with a handful of asks); a read that comes
   * back exactly full is therefore *suspicious*, and says so in the log instead of quietly
   * publishing a floor as if it were the count.
   */
  const BOUNDARY_WINDOW = 1000

  interface TranscriptBoundary {
    /** How many transcript units the session held (the vendored `messageBoundary`). */
    count: number
    /** The id of the last unit inside that prefix — what a copy can stop at. */
    messageId?: string
  }

  /**
   * P4b: the ask's transcript boundary — how many transcript units the actor's session
   * held when this exchange ended, and the id of the last one.
   *
   * The vendored contract calls the count `NodeRecord.messageBoundary`: a **count offset**,
   * because a count survives prefix-copying (copy the first N units into a new session and
   * N still means the same place). That is what makes amend-resume's transcript seeding
   * addressable across a chain of revisions.
   *
   * The unit here is OUR transcript's unit — a `StructuredCard`, the thing
   * `backend.getHistory` returns and the thing a seeding implementation would copy. The
   * vendored field is a number with a documented meaning, not a schema over someone else's
   * store, so counting our own units is the honest reading; counting something we do not
   * have (engine message rows) would be a fabricated number.
   *
   * `messageId` is what lets a backend that can only copy at a message boundary
   * (`forkSession(session, messageID)`) be exact rather than approximate. It is absent when
   * the engine's cards carry no message ids: then seeding degrades, the count does not.
   */
  async function transcriptBoundary(sessionId: string): Promise<TranscriptBoundary | undefined> {
    try {
      const cards = await backend().getHistory(sessionId, BOUNDARY_WINDOW)
      if (cards.length >= BOUNDARY_WINDOW) {
        log.warn(`messageBoundary: ${sessionId.slice(-8)} returned a full ${BOUNDARY_WINDOW}-unit window — the count may be a floor`)
      }
      const last = [...cards].reverse().find((c) => typeof (c as { messageId?: unknown }).messageId === 'string' && (c as { messageId?: string }).messageId)
      return { count: cards.length, ...(last ? { messageId: (last as { messageId: string }).messageId } : {}) }
    } catch (err) {
      log.warn(`messageBoundary: history read failed for ${sessionId.slice(-8)}: ${(err as Error).message}`)
      return undefined
    }
  }

  /**
   * Record a boundary: the vendored count on the node row (engine contract), plus the
   * host's own line carrying the message id (journal.ts `AskBoundary`). One step, because
   * the two are the same measurement — a count with no id seeds nothing, and an id with no
   * count cannot be truncated to.
   */
  function recordBoundary(instance: InstanceRef, sessionId: string, boundary: TranscriptBoundary): void {
    try {
      deps.journal.putAskBoundary(deps.runId, {
        siteId: instance.siteId,
        ordinal: instance.ordinal,
        sessionId,
        count: boundary.count,
        ...(boundary.messageId ? { messageId: boundary.messageId } : {}),
      })
    } catch (err) {
      log.warn(`messageBoundary: journal write failed for ${instance.siteId}#${instance.ordinal}: ${(err as Error).message}`)
    }
    backfillBoundary(instance, boundary.count)
  }

  /** Backfill the boundary onto the ask's node row (the engine owns the row; the boundary
   *  is a driver-owned field, exactly like `stats`). */
  function backfillBoundary(instance: InstanceRef, boundary: number): void {
    try {
      const record = deps.journal.getNode(deps.runId, instance.siteId, instance.ordinal)
      if (!record) return
      if (record.messageBoundary === boundary) return
      deps.journal.putNode({ ...record, messageBoundary: boundary })
    } catch (err) {
      log.warn(`messageBoundary: write failed for ${instance.siteId}#${instance.ordinal}: ${(err as Error).message}`)
    }
  }

  async function finalText(sessionId: string): Promise<string> {
    if (deps.readFinalText) {
      try { return await deps.readFinalText(sessionId) } catch { /* fall through */ }
    }
    try {
      const history = await backend().getHistory(sessionId, 20)
      for (let i = history.length - 1; i >= 0; i--) {
        const card = history[i] as unknown as { kind?: string; blocks?: Array<{ type?: string; text?: string }> }
        if (card.kind !== 'assistant' || !Array.isArray(card.blocks)) continue
        const text = card.blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n')
        if (text.trim()) return text
      }
    } catch (err) {
      log.warn(`finalText: history read failed for ${sessionId.slice(-8)}: ${(err as Error).message}`)
    }
    return ''
  }

  function send(sessionId: string, text: string, what: string, entry: InFlight): void {
    void backend()
      .prompt(sessionId, { text, ...(deps.actorModel ? { model: deps.actorModel } : {}) })
      .catch((err) => {
        log.error(`${what} dispatch failed for ${sessionId.slice(-8)}`, err as Error)
        // A prompt that never started must not hold a seat forever.
        if (entry.admitted) releaseSlot()
        forget(entry)
        deps.sink.askFailed(entry.instance, {
          name: 'WorkflowError', code: 'DriverError',
          message: `actor session prompt failed: ${(err as Error).message}`,
        } as never)
      })
  }

  function forget(entry: InFlight): void {
    bySession.delete(entry.sessionId)
    byInstance.delete(instanceKey(entry.instance))
  }

  /** Hand a slot to the next queued ask, if any. */
  function releaseSlot(): void {
    inFlight = Math.max(0, inFlight - 1)
    while (inFlight < cap && queue.length > 0) {
      const next = queue.shift()!
      startNow(next)
    }
  }

  function startNow(entry: InFlight): void {
    inFlight += 1
    entry.admitted = true
    const pending = entry.pending
    entry.pending = undefined
    if (!pending) return
    deps.sink.askExecuting(entry.instance)
    send(entry.sessionId, pending.text, pending.what, entry)
  }

  /** Admit or queue an ask, depending on the run's free seats. */
  function admit(entry: InFlight, text: string, what: string): void {
    entry.pending = { text, what }
    if (inFlight < cap) { startNow(entry); return }
    // The ask is live but has no model slot: report the wait the way the vendored
    // contract expects (cause 'slot'), then park it.
    queue.push(entry)
    deps.sink.askWaiting(entry.instance, { cause: 'slot' })
  }

  /**
   * Amend-resume: mint the diverging actor's session from the predecessor's transcript.
   *
   * The vendored contract (see `WorkflowDriver.createActorSession`) makes this the
   * driver's job: the new run's actor continues the *same conversation* it was having in
   * the predecessor, truncated at the last ask the cache imported. Without it a diverging
   * actor starts blank and silently loses everything it had already been told.
   *
   * The copy primitive is the backend's `forkSession(session, messageID)` — a new session
   * holding the source's transcript up to that message, with no model turn. That is a
   * *capability*, not a given: v2/ACP backends do not have it. When it is missing, or the
   * boundary names no message, or the fork fails, the actor gets an empty session and the
   * log says which of those happened. It never refuses the amend — a degradation the user
   * can see is worth more than a run they cannot start.
   *
   * **The engine's cut is exclusive.** Measured directly against the engine (P4b gate +
   * probe, 2026-10-10): a six-message session forked at `message[3]` comes back with three
   * messages — everything *before* the one named, `{}` (no id) copying the whole tail. Our
   * boundary therefore names the last message *inside* the prefix, and the fork point has to
   * be the message that follows it. That is why this reads the source here instead of
   * pointing the fork at the boundary: pointing it at the boundary loses exactly the message
   * the ask produced.
   *
   * Returns the session id, or undefined to mean "mint an empty one instead".
   */
  async function seedActorSession(actor: ActorRef, seed: ActorSessionSeed, title: string): Promise<string | undefined> {
    const backendNow = backend()
    if (!backendNow.forkSession) {
      log.warn(`no transcript seeding for ${actor.siteId}#${actor.ordinal}: backend '${backendNow.id}' lacks forkSession`)
      return undefined
    }
    const predecessor = deps.journal.getRun(deps.runId)?.resumedFrom
    // The boundary is keyed on (source session, count): the count is what the engine asked
    // for, and the session id is what the seed names — together they pick exactly one row
    // even when two actors of the predecessor ended at the same count.
    const boundary = (predecessor ? deps.journal.listAskBoundaries(predecessor) : [])
      .find((b) => b.sessionId === seed.sourceSessionId && b.count === seed.messageCount)
    // One card per user/assistant message, so the card at index `count` is produced by the
    // first message *after* the prefix; missing it means the session ends at the boundary,
    // where the exclusive cut and the tail copy are the same thing.
    const source = await backendNow.getHistory(seed.sourceSessionId, BOUNDARY_WINDOW).catch(() => undefined)
    let forkPoint: string | undefined
    if (source) {
      forkPoint = source.length > seed.messageCount
        ? (source[seed.messageCount] as { messageId?: unknown } | undefined)?.messageId as string | undefined
        : undefined
    } else {
      // The transcript cannot be read, so the next message cannot be named. The boundary's
      // own message is still a *known* position, and pointing the exclusive cut at it copies
      // everything but that last message — one card short of the contract, and said out loud.
      log.warn(`transcript seeding for ${actor.siteId}#${actor.ordinal}: source read failed — the copy will be one message short`)
      forkPoint = boundary?.messageId
    }
    if (boundary === undefined) {
      log.warn(`no transcript seeding for ${actor.siteId}#${actor.ordinal}: no boundary at ${seed.messageCount} units for session ${seed.sourceSessionId.slice(-8)}`)
      return undefined
    }
    if (forkPoint === undefined && source !== undefined && source.length < seed.messageCount) {
      log.warn(`transcript seeding for ${actor.siteId}#${actor.ordinal}: source has ${source.length} of ${seed.messageCount} units — copying what exists`)
    }
    try {
      const forked = await backendNow.forkSession(seed.sourceSessionId, forkPoint)
      if (!forked) {
        log.warn(`no transcript seeding for ${actor.siteId}#${actor.ordinal}: fork refused by the engine`)
        return undefined
      }
      // The fork inherits the source's title ("workflow <old runId> · <actor>"); the run
      // suffix is the part the panel keys on, so re-title it. Best effort: a failure here
      // costs a stale label, not the transcript.
      await backendNow.renameSession(forked.id, title).catch(() => { /* label only */ })
      log.info(`actor ${actor.siteId}#${actor.ordinal} seeded from ${seed.sourceSessionId.slice(-8)}: ${seed.messageCount} units (fork before ${String(forkPoint).slice(-8) || 'the tail'})`)
      return forked.id
    } catch (err) {
      log.warn(`no transcript seeding for ${actor.siteId}#${actor.ordinal}: fork failed: ${(err as Error).message}`)
      return undefined
    }
  }

  return {
    async createActorSession(actor, persona, seed?: ActorSessionSeed) {
      const existing = deps.journal.getActor(deps.runId, actor.siteId, actor.ordinal)
      if (existing?.sessionId) {
        const alive = await backend().hasSession(existing.sessionId).catch(() => false)
        if (alive) {
          // Resume: re-attach to the conversation this actor already owns — *including*
          // the seeded one. This early return is the vendored contract's idempotency
          // requirement (a crash-resume must not copy the prefix twice): the actor row
          // holds the session id, so the copy below can only ever run for a session that
          // does not exist yet.
          log.info(`actor ${actor.siteId}#${actor.ordinal} re-attached to session ${existing.sessionId.slice(-8)}`)
          return { id: existing.sessionId }
        }
      }

      const title = `workflow ${deps.runId.slice(-8)} · ${persona.name ?? `${actor.siteId}#${actor.ordinal}`}`
      const seededId = seed ? await seedActorSession(actor, seed, title) : undefined
      const sessionId = seededId
        ?? (await backend().createSession({ directory: deps.cwd, title })).id
      deps.journal.putActor({
        runId: deps.runId, siteId: actor.siteId, ordinal: actor.ordinal,
        ...(persona.name ? { name: persona.name } : {}),
        persona,
        sessionId,
        ...(deps.actorModel ? { resolvedModel: `${deps.actorModel.providerID}/${deps.actorModel.modelID}` } : {}),
      })
      deps.onActorSession?.(sessionId, actor, persona.name)
      return { id: sessionId }
    },

    startAsk(session: SessionRef, instance: InstanceRef, message: AskMessage) {
      const entry: InFlight = {
        instance, sessionId: session.id, typed: message.typed,
        ...(message.typed ? { schema: message.schema } : {}),
        nudged: false, admitted: false,
      }
      bySession.set(session.id, entry)
      byInstance.set(instanceKey(instance), entry)
      queueBoundary(session.id, instance)

      const persona = deps.journal.getActor(deps.runId, instance.siteId, instance.ordinal)?.persona ?? {}
      admit(entry, buildAskPrompt(message, persona, deps.personaPrelude), 'ask')
    },

    respondToSubmit(instance, verdict: SubmitVerdict) {
      const entry = byInstance.get(instanceKey(instance))
      if (!entry) return
      if (verdict.kind === 'nudge') {
        // The engine's single nudge: re-prompt the same session and wait for
        // another turn. `nudged` guards against looping if the model ignores us.
        if (entry.nudged) return
        entry.nudged = true
        admit(entry, buildNudgePrompt(entry.schema), 'nudge')
        return
      }
      if (verdict.kind === 'accept') {
        // The node is settled; free its seat for the next queued ask.
        if (entry.admitted) releaseSlot()
        // A **provisional** boundary: the exchange is over the moment the value is
        // accepted, but the vendored contract puts the number after the *complete*
        // exchange — repair/nudge rounds and the wrap-up messages the model emits after
        // submitting — and those land after this point. Writing it here is what lets a
        // revision amend a just-finished run at all (the cache preflight refuses a
        // completed ask with no boundary); the authoritative re-measure happens at the
        // turn end, which the manager still routes for a settled run (see
        // `settledDrivers` — that is the whole reason it exists).
        void (async () => {
          const boundary = await transcriptBoundary(entry.sessionId)
          if (boundary) recordBoundary(entry.instance, entry.sessionId, boundary)
        })()
        return
      }
      if (verdict.kind === 'reject') {
        // A repair turn: the model fixes the value in the SAME session and submits
        // again. `turn`-level bookkeeping stays with the engine.
        // One line per violation: path, expected, got — the shape the vendored
        // validator designs its output for, and what a repair turn can act on.
        const violations = verdict.violations
          .map((v) => `${v.path}: expected ${v.expected}, got ${v.got}`)
          .join('; ')
        admit(entry, `Your \`submit_result\` did not satisfy the schema. Fix these and call \`submit_result\` again:\n${violations}`, 'repair')
      }
    },

    cancelAsk(instance) {
      const entry = byInstance.get(instanceKey(instance))
      if (!entry) return
      const queued = queue.indexOf(entry)
      if (queued >= 0) queue.splice(queued, 1)
      if (entry.admitted) releaseSlot()
      // A cancelled ask is never importable (only a completed one is), so its boundary is
      // no longer owed — drop the obligation with the entry.
      const owed = pendingBoundary.get(entry.sessionId)
      if (owed) {
        const kept = owed.filter((i) => instanceKey(i) !== instanceKey(entry.instance))
        if (kept.length > 0) pendingBoundary.set(entry.sessionId, kept)
        else pendingBoundary.delete(entry.sessionId)
      }
      forget(entry)
      void backend().abort(entry.sessionId).catch(() => { /* already idle */ })
    },

    setMaxConcurrency(n) {
      const next = Math.max(1, Math.floor(n))
      if (next === cap) return
      const previousCap = cap
      log.info(`run ${deps.runId.slice(-8)} concurrency cap ${cap} → ${next}`)
      cap = next
      // The contract's `key` is the provider key for the AIMD controller; the
      // run-level seat gate is per-run, so the run id is the honest key here.
      deps.sink.concurrencyChanged({ key: deps.runId, previous: previousCap, next, reason: 'settings_changed' as never })
      while (inFlight < cap && queue.length > 0) startNow(queue.shift()!)
    },

    async executeWorldRead(op, args) {
      // The run's own workspace, not the host's cwd — a run started for another
      // directory must read and write there.
      return await deps.world.read(op, args, deps.cwd, deps.runId)
    },

    async executeArtifactPublish(request) {
      return await deps.artifacts.publish(request, deps.cwd)
    },

    journal: deps.journal,
    emit(event: RunEvent) {
      // Boundary C fan-out lives with the manager (journal + broadcast); the engine
      // only asks us to hand the event over.
      try {
        deps.emitEvent?.(event)
      } catch (err) {
        log.warn(`emit failed for ${String((event as { type?: string }).type)}: ${(err as Error).message}`)
      }
    },

    dispose() {
      bySession.clear()
      byInstance.clear()
      queue.length = 0
      inFlight = 0
    },

    async notifyTurnEnd(sessionId) {
      const entry = bySession.get(sessionId)
      if (!entry) {
        // No in-flight ask: either it was never ours, or the run settled and the engine
        // disposed the driver before this turn ended. Only the second case has something
        // to do — the boundary the oldest outstanding exchange is still owed.
        const instance = takeBoundary(sessionId)
        if (!instance) return
        const late = await transcriptBoundary(sessionId)
        if (late) recordBoundary(instance, sessionId, late)
        return
      }
      const text = await finalText(sessionId)
      if (deps.readStats) {
        try {
          const stats = await deps.readStats(sessionId)
          if (stats) deps.sink.askStats(entry.instance, stats)
        } catch { /* observation only */ }
      }
      // Typed asks settle through `submit_result`, never through the final text —
      // that is the whole point of the typed path. Either way the turn is over, so
      // its model seat goes back to the run.
      if (!entry.typed) forget(entry)
      if (entry.admitted) releaseSlot()
      // The boundary is written AFTER the engine is told the turn ended: that call is what
      // settles the node (and rewrites its row), so writing first would be overwritten.
      // This turn end completes the *oldest* outstanding exchange on the session (see
      // `pendingBoundary`); `askTurnEnded` above still carries the entry the engine is
      // currently tracking, which is the newest ask.
      deps.sink.askTurnEnded(entry.instance, text)
      const completing = takeBoundary(sessionId) ?? entry.instance
      const boundary = await transcriptBoundary(sessionId)
      if (boundary) recordBoundary(completing, sessionId, boundary)
    },

    submit(sessionId, payload) {
      const entry = bySession.get(sessionId)
      if (!entry) return
      deps.sink.askSubmitAttempted(entry.instance, payload)
    },

    inFlightSessions() {
      return [...bySession.keys()]
    },

    pendingBoundarySessions() {
      return [...pendingBoundary.keys()]
    },
  }
}
