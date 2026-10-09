import { randomUUID } from 'node:crypto'
import type { CardBus } from '../card-bus.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('workflow-approval')

/**
 * P3: the human gate for `world.run`.
 *
 * A workflow script may only run commands the compiler saw as literals, and the
 * vendored contract keeps that authorization face honest by making the driver
 * re-check. What it deliberately does NOT provide is the human decision — that is
 * host policy. This module is that policy: it publishes an approval card (the same
 * card the panel and Telegram already render for engine permissions), waits for a
 * decision, and remembers an `always` per (run, command) so a loop that runs the
 * same command twenty times asks once.
 *
 * Fail-closed everywhere: no session to ask, no answer in time, a decision for an
 * unknown request — all deny.
 */
export interface ApprovalRequest {
  runId: string
  /** Session to surface the card in (the run's parent). */
  sessionId: string
  cmd: string
  args: string[]
}

export interface ApprovalDeps {
  cardBus: CardBus
  /** How long to wait for a human before denying. Default 5 minutes. */
  timeoutMs?: number
  now?: () => number
}

export interface ApprovalDecision {
  decision: 'once' | 'always' | 'reject'
}

export interface WorkflowApproval {
  /** Ask (or reuse a remembered "always"). Resolves true only on an allow. */
  request(req: ApprovalRequest): Promise<boolean>
  /** A decision from the panel (or any transport). */
  resolve(requestId: string, decision: ApprovalDecision['decision']): boolean
  /** Requests still waiting for a decision (the run view lists them). */
  pending(): Array<{ requestId: string; runId: string; cmd: string }>
  stop(): void
}

interface Pending {
  requestId: string
  req: ApprovalRequest
  settle: (allowed: boolean) => void
  timer: NodeJS.Timeout
}

export function createWorkflowApproval(deps: ApprovalDeps): WorkflowApproval {
  const timeoutMs = deps.timeoutMs ?? 300_000
  const waiting = new Map<string, Pending>()
  /** `${runId}\u0000${cmd}` → the user said "always". */
  const remembered = new Set<string>()
  const key = (runId: string, cmd: string) => `${runId}\u0000${cmd}`
  let stopped = false

  return {
    async request(req) {
      if (stopped) return false
      if (remembered.has(key(req.runId, req.cmd))) {
        log.info(`world.run \`${req.cmd}\` allowed by a remembered decision (run ${req.runId.slice(-8)})`)
        return true
      }
      const requestId = `wfrun-approval:${randomUUID()}`
      const allowed = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          waiting.delete(requestId)
          log.warn(`world.run \`${req.cmd}\` denied: no decision within ${Math.round(timeoutMs / 1000)}s`)
          resolve(false)
        }, timeoutMs)
        timer.unref?.()
        waiting.set(requestId, { requestId, req, settle: resolve, timer })
        deps.cardBus.publish({
          kind: 'approval',
          sessionId: req.sessionId,
          requestId,
          title: `Workflow 请求执行命令：${req.cmd}${req.args.length ? ` ${req.args.join(' ')}` : ''}`,
          args: { runId: req.runId, command: req.cmd, argv: req.args },
        })
        log.info(`world.run \`${req.cmd}\` awaiting a decision (${requestId.slice(-12)})`)
      })
      return allowed
    },

    resolve(requestId, decision) {
      const pending = waiting.get(requestId)
      if (!pending) return false
      clearTimeout(pending.timer)
      waiting.delete(requestId)
      const allowed = decision !== 'reject'
      if (decision === 'always') remembered.add(key(pending.req.runId, pending.req.cmd))
      log.info(`world.run \`${pending.req.cmd}\` ${allowed ? 'approved' : 'rejected'}${decision === 'always' ? ' (always for this run)' : ''}`)
      pending.settle(allowed)
      return true
    },

    pending() {
      return [...waiting.values()].map((p) => ({ requestId: p.requestId, runId: p.req.runId, cmd: p.req.cmd }))
    },

    stop() {
      stopped = true
      for (const p of waiting.values()) {
        clearTimeout(p.timer)
        p.settle(false)
      }
      waiting.clear()
    },
  }
}
