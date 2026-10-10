import { randomUUID } from 'node:crypto'

/**
 * P4-1a: the run's escalation registry.
 *
 * Two shapes of the same fact exist in this system and they must not drift:
 *  - the engine's `escalation-raised` / `escalation-resolved` run events (Boundary C),
 *    which the vendored contract says the *driver* emits inside an ask — our driver
 *    does not raise them yet, so today they only ever appear in journals written by
 *    an engine that does;
 *  - the actor-side `escalate` tool call, which arrives over HTTP at
 *    `/api/workflow/escalate` and is the mechanism that actually exists here.
 *
 * The projection needs one list of pending questions, so the registry lives here
 * (not inside the route module) and both readers see the same records. It is
 * deliberately in-memory: a question lives exactly as long as the run that asked
 * it, and a restarted host has no live run to answer — the vendored schema says the
 * same thing ("纯内存、随 run 终态清空").
 */
export interface EscalationRecord {
  /** Global question id (`dwfq-<runId tail>-<seq>`), the answer key. */
  qid: string
  runId: string
  question: string
  context?: string
  /** Session that raised it, so the projection can name the actor. */
  sessionId?: string
  askedAt: number
  answer?: string
}

export interface EscalationRegistry {
  /** Record a raised question. Re-raising the same text returns the same record. */
  raise(input: { runId: string; question: string; context?: string; sessionId?: string }): EscalationRecord
  /** Parent-side answer (`ResolveWorkflowQuestion`). False when the question is unknown. */
  answer(runId: string, question: string, answer: string): boolean
  /** Unanswered questions of a run, in ask order. */
  pending(runId: string): EscalationRecord[]
  /** Every question of a run (the run view shows answered ones too). */
  all(runId: string): EscalationRecord[]
  /** Run settled — nothing is listening any more. */
  clear(runId: string): void
}

export function createEscalationRegistry(deps: { now?: () => number } = {}): EscalationRegistry {
  const now = deps.now ?? (() => Date.now())
  const byRun = new Map<string, EscalationRecord[]>()
  let seq = 0

  function list(runId: string): EscalationRecord[] {
    let l = byRun.get(runId)
    if (!l) { l = []; byRun.set(runId, l) }
    return l
  }

  return {
    raise(input) {
      const l = list(input.runId)
      const existing = l.find((e) => e.question === input.question)
      if (existing) return existing
      seq += 1
      const rec: EscalationRecord = {
        qid: `dwfq-${input.runId.slice(-8)}-${seq}`,
        runId: input.runId,
        question: input.question,
        ...(input.context ? { context: input.context } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        askedAt: now(),
      }
      l.push(rec)
      return rec
    },
    answer(runId, question, answer) {
      const hit = list(runId).find((e) => e.question === question)
      if (!hit) return false
      hit.answer = answer
      return true
    },
    pending(runId) {
      return list(runId).filter((e) => e.answer === undefined)
    },
    all(runId) {
      return [...list(runId)]
    },
    clear(runId) {
      byRun.delete(runId)
    },
  }
}
