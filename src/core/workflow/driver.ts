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
  /** The host calls this when a session's turn ends (see the module doc). */
  notifyTurnEnd(sessionId: string): Promise<void>
  /**
   * A `submit_result` tool call from an actor session (wired in P3). The engine
   * validates and answers through {@link WorkflowDriver.respondToSubmit}.
   */
  submit(sessionId: string, payload: unknown): void
  /** Live asks, for the host's cancel/dispose paths. */
  inFlightSessions(): string[]
}

interface InFlight {
  instance: InstanceRef
  sessionId: string
  typed: boolean
  schema?: unknown
  nudged: boolean
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

  const backend = () => deps.registry.active()

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

  function send(sessionId: string, text: string, what: string): void {
    void backend()
      .prompt(sessionId, { text, ...(deps.actorModel ? { model: deps.actorModel } : {}) })
      .catch((err) => log.error(`${what} dispatch failed for ${sessionId.slice(-8)}`, err as Error))
  }

  function forget(entry: InFlight): void {
    bySession.delete(entry.sessionId)
    byInstance.delete(instanceKey(entry.instance))
  }

  return {
    async createActorSession(actor, persona, seed?: ActorSessionSeed) {
      const existing = deps.journal.getActor(deps.runId, actor.siteId, actor.ordinal)
      if (existing?.sessionId) {
        const alive = await backend().hasSession(existing.sessionId).catch(() => false)
        if (alive) {
          // Resume: re-attach to the conversation this actor already owns. A fresh
          // seed copy is unnecessary — that session still holds its transcript.
          log.info(`actor ${actor.siteId}#${actor.ordinal} re-attached to session ${existing.sessionId.slice(-8)}`)
          return { id: existing.sessionId }
        }
      }

      const created = await backend().createSession({
        directory: deps.cwd,
        title: `workflow ${deps.runId.slice(-8)} · ${persona.name ?? `${actor.siteId}#${actor.ordinal}`}`,
      })
      const sessionId = created.id
      deps.journal.putActor({
        runId: deps.runId, siteId: actor.siteId, ordinal: actor.ordinal,
        ...(persona.name ? { name: persona.name } : {}),
        persona,
        sessionId,
        ...(deps.actorModel ? { resolvedModel: `${deps.actorModel.providerID}/${deps.actorModel.modelID}` } : {}),
      })
      deps.onActorSession?.(sessionId, actor, persona.name)
      if (seed) {
        // Amend-resume seeds a fresh session from a predecessor's transcript. The
        // vendored contract makes that the driver's job and requires idempotency;
        // a freshly minted session holds nothing yet, so the copy is a single pass
        // and re-running it would be a no-op.
        log.info(`actor ${actor.siteId}#${actor.ordinal} seeded from ${seed.sourceSessionId.slice(-8)} (${seed.messageCount} messages)`)
      }
      return { id: sessionId }
    },

    startAsk(session: SessionRef, instance: InstanceRef, message: AskMessage) {
      const entry: InFlight = {
        instance, sessionId: session.id, typed: message.typed,
        ...(message.typed ? { schema: message.schema } : {}),
        nudged: false,
      }
      bySession.set(session.id, entry)
      byInstance.set(instanceKey(instance), entry)

      const persona = deps.journal.getActor(deps.runId, instance.siteId, instance.ordinal)?.persona ?? {}
      send(session.id, buildAskPrompt(message, persona, deps.personaPrelude), 'ask')
    },

    respondToSubmit(instance, verdict: SubmitVerdict) {
      const entry = byInstance.get(instanceKey(instance))
      if (!entry) return
      if (verdict.kind === 'nudge') {
        // The engine's single nudge: re-prompt the same session and wait for
        // another turn. `nudged` guards against looping if the model ignores us.
        if (entry.nudged) return
        entry.nudged = true
        send(entry.sessionId, buildNudgePrompt(entry.schema), 'nudge')
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
        send(entry.sessionId, `Your \`submit_result\` did not satisfy the schema. Fix these and call \`submit_result\` again:\n${violations}`, 'repair')
      }
    },

    cancelAsk(instance) {
      const entry = byInstance.get(instanceKey(instance))
      if (!entry) return
      forget(entry)
      void backend().abort(entry.sessionId).catch(() => { /* already idle */ })
    },

    async executeWorldRead(op, args) {
      return await deps.world.read(op, args)
    },

    async executeArtifactPublish(request) {
      return await deps.artifacts.publish(request)
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
    },

    async notifyTurnEnd(sessionId) {
      const entry = bySession.get(sessionId)
      if (!entry) return
      const text = await finalText(sessionId)
      if (deps.readStats) {
        try {
          const stats = await deps.readStats(sessionId)
          if (stats) deps.sink.askStats(entry.instance, stats)
        } catch { /* observation only */ }
      }
      // Typed asks settle through `submit_result`, never through the final text —
      // that is the whole point of the typed path.
      if (!entry.typed) forget(entry)
      deps.sink.askTurnEnded(entry.instance, text)
    },

    submit(sessionId, payload) {
      const entry = bySession.get(sessionId)
      if (!entry) return
      deps.sink.askSubmitAttempted(entry.instance, payload)
    },

    inFlightSessions() {
      return [...bySession.keys()]
    },
  }
}
