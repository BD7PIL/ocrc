// P4-1b — host run projection → the vendor's `workflowRuns` state key.
//
// The shape of this bridge is forced by two facts:
//
//  1. The host already reduces the journal into the vendored run state (that is what
//     `GET /api/workflow/projection` returns), so this module never derives run fields
//     itself — one reduction, one author.
//  2. The *container* (revision + key-level deltas) is the consumer's business: the
//     vendor's `diffWorkflowRunsState` compares two states and the panel is the one
//     holding the prior state. So the revision counter lives here, next to the cache
//     it versions, and the deltas come out of the vendor's own diff (never a hand-
//     rolled patch — the apply order header → cleared → removals → upserts is subtle
//     enough that a second implementation would eventually disagree with the client).
//
// Two things the vendored run schema has no field for are carried beside `runs` in the
// host response and consumed here, not forwarded onto the wire:
//   - `joins`: which tool call started a run, so we can resolve the card join key
//     (`tool-<partId>`) from the rows we hold — the host cannot know it, because the
//     engine mints that id after the tool call returns;
//   - `sessions`: runId → parent session, for the sidebar's cross-session summary.
import { diffWorkflowRunsState } from '@zcode/shared/zcode-protocol-v4/workflow-runs-delta'
import type { ConversationDelta } from '@zcode/shared/zcode-protocol-v4/delta'
import type { WorkflowRunState, WorkflowRunsState } from '@zcode/shared/zcode-protocol-v4/workflow-runs'

function token(): string {
  try { return localStorage.getItem('ocrc.token') ?? '' } catch { return '' }
}

export interface RunToolJoin {
  messageId: string
  toolName: string
}

export interface WorkflowProjectionResponse {
  runs: WorkflowRunState[]
  joins: Record<string, RunToolJoin>
  sessions: Record<string, string>
}

const EMPTY: WorkflowProjectionResponse = { runs: [], joins: {}, sessions: {} }

/** Read the host's projection. A failure degrades to "no runs" rather than throwing:
 *  the workflow surface is an addition to a conversation, and a conversation that
 *  fails to render because the sidebar could not read its runs is worse than one
 *  without a run card. */
export async function fetchWorkflowProjection(sessionId?: string): Promise<WorkflowProjectionResponse> {
  const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
  try {
    const res = await fetch(`/api/workflow/projection${query}`, { headers: { Authorization: `Bearer ${token()}` } })
    if (!res.ok) return EMPTY
    const body = (await res.json()) as Partial<WorkflowProjectionResponse>
    return {
      runs: Array.isArray(body.runs) ? body.runs : [],
      joins: body.joins ?? {},
      sessions: body.sessions ?? {},
    }
  } catch {
    return EMPTY
  }
}

/** The row fields the join needs (the bridge's own tool rows). */
export interface ToolRowLike {
  toolCallId?: unknown
  toolName?: unknown
  __messageId?: unknown
}

/**
 * Fill in `toolCallId` from the rows the bridge already has.
 *
 * The plugin knows `(sessionID, messageID)` and its own tool name; the row knows
 * `toolCallId` (`tool-<partId>`) and the message id it belongs to. Matching the pair is
 * therefore exact — and when it does not match (a run started over HTTP, or a row that
 * has already been folded out of the window) the field simply stays absent. The run is
 * still listed in the status panel; it just has no timeline card to attach to, which is
 * the honest rendering of "we do not know which call started this".
 */
export function resolveToolCallIds(
  runs: WorkflowRunState[],
  joins: Record<string, RunToolJoin>,
  rows: readonly ToolRowLike[],
): WorkflowRunState[] {
  return runs.map((run) => {
    if (run.toolCallId) return run
    const join = joins[run.runId]
    if (!join) return run
    const row = rows.find(
      (r) => r.__messageId === join.messageId && String(r.toolName ?? '') === join.toolName && typeof r.toolCallId === 'string',
    )
    return row ? { ...run, toolCallId: row.toolCallId as string } : run
  })
}

export interface WorkflowRunsUpdate {
  state: WorkflowRunsState
  deltas: ConversationDelta[]
}

/**
 * Version a new run list against the prior state and produce the wire deltas.
 *
 * `revision` is monotonically incremented here (the container's only version carrier
 * is the number itself, and the vendor's apply takes `max`, so a client that misses a
 * frame still converges). No change ⇒ no delta, and the revision does not move —
 * exactly the rule the vendored reducer follows, and the reason the panel does not
 * re-render on a no-op hint.
 */
export function nextWorkflowRunsState(
  prior: WorkflowRunsState | undefined,
  runs: WorkflowRunState[],
): WorkflowRunsUpdate {
  // No change ⇒ no bump. This is not an optimisation: the vendored diff falls back to
  // re-sending the whole key when the revision moves without any op to explain it, so
  // bumping on an idempotent hint would quietly turn every hint into a full payload —
  // the exact cost the delta path exists to avoid. The prior state (and its run
  // references) are returned as-is, which is what the client's memo compares.
  if (prior && runsEqual(prior.runs, runs)) return { state: prior, deltas: [] }
  const state: WorkflowRunsState = { revision: (prior?.revision ?? 0) + 1, runs }
  return { state, deltas: diffWorkflowRunsState(prior, state) }
}

/** True when two run lists are semantically identical (used to skip a needless bump). */
export function runsEqual(a: WorkflowRunState[] | undefined, b: WorkflowRunState[]): boolean {
  if (!a || a.length !== b.length) return false
  return JSON.stringify(a) === JSON.stringify(b)
}
