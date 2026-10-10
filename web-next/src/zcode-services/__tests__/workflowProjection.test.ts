// P4-1b — the bridge's pure parts. The interesting behaviours are all about *joining*
// things the host cannot know (the card's toolCallId) and about *versioning* the
// container, so those are what these tests pin.
import { describe, it, expect } from 'vitest'
import { nextWorkflowRunsState, resolveToolCallIds, runsEqual } from '../workflowProjection.js'
import type { WorkflowRunState } from '@zcode/shared/zcode-protocol-v4/workflow-runs'

function run(over: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
    runId: 'dwfrun-1',
    status: 'running',
    usage: { spentTokens: 0, nodesUsed: 0 },
    actors: [],
    nodes: [],
    lastEventSequence: 0,
    ...over,
  }
}

describe('resolveToolCallIds', () => {
  it('matches the row by (messageId, toolName) — the pair the host could record', () => {
    const rows = [
      { toolCallId: 'tool-part_1', toolName: 'CreateWorkflow', __messageId: 'msg_1' },
      { toolCallId: 'tool-part_2', toolName: 'CreateWorkflow', __messageId: 'msg_2' },
    ]
    const out = resolveToolCallIds(
      [run({ runId: 'r1' })],
      { r1: { messageId: 'msg_2', toolName: 'CreateWorkflow' } },
      rows,
    )
    // The message id disambiguates two calls to the same tool in one session.
    expect(out[0]!.toolCallId).toBe('tool-part_2')
  })

  it('leaves the field absent when the row is gone (honest: no card to join)', () => {
    const out = resolveToolCallIds(
      [run({ runId: 'r1' })],
      { r1: { messageId: 'msg_gone', toolName: 'CreateWorkflow' } },
      [{ toolCallId: 'tool-part_1', toolName: 'CreateWorkflow', __messageId: 'msg_1' }],
    )
    expect(out[0]!.toolCallId).toBeUndefined()
    // The run itself is untouched — it still shows in the status panel.
    expect(out[0]!.runId).toBe('r1')
  })

  it('does not overwrite a toolCallId the host already supplied', () => {
    const out = resolveToolCallIds(
      [run({ runId: 'r1', toolCallId: 'launch-abc' })],
      { r1: { messageId: 'msg_1', toolName: 'CreateWorkflow' } },
      [{ toolCallId: 'tool-part_1', toolName: 'CreateWorkflow', __messageId: 'msg_1' }],
    )
    expect(out[0]!.toolCallId).toBe('launch-abc')
  })

  it('ignores a run with no join record at all (started over HTTP / by the CLI)', () => {
    const out = resolveToolCallIds([run({ runId: 'r9' })], {}, [])
    expect(out[0]!.toolCallId).toBeUndefined()
  })
})

describe('nextWorkflowRunsState', () => {
  it('mints key-level deltas from the vendor diff, with a monotonic revision', () => {
    const first = nextWorkflowRunsState(undefined, [run()])
    expect(first.state.revision).toBe(1)
    expect(first.deltas).toEqual([
      {
        op: 'workflowRun.updated',
        runId: 'dwfrun-1',
        revision: 1,
        run: { runId: 'dwfrun-1', status: 'running', usage: { spentTokens: 0, nodesUsed: 0 }, lastEventSequence: 0 },
      },
    ])

    const second = nextWorkflowRunsState(first.state, [run({ status: 'completed' })])
    expect(second.state.revision).toBe(2)
    expect(second.deltas).toEqual([
      { op: 'workflowRun.updated', runId: 'dwfrun-1', revision: 2, run: { status: 'completed' } },
    ])
  })

  it('emits a removal when a run falls out of the window', () => {
    const prior = nextWorkflowRunsState(undefined, [run({ runId: 'a' }), run({ runId: 'b' })]).state
    const next = nextWorkflowRunsState(prior, [run({ runId: 'b' })])
    expect(next.deltas).toEqual([{ op: 'workflowRun.removed', runId: 'a', revision: 2 }])
  })

  it('emits no delta and does not move the revision when nothing changed', () => {
    const prior = nextWorkflowRunsState(undefined, [run()]).state
    const same = nextWorkflowRunsState(prior, [run()])
    expect(same.deltas).toEqual([])
    // The revision must not move: a bump with no op makes the vendored diff resend the
    // whole key, which is the cost this path exists to avoid.
    expect(same.state).toBe(prior)
  })
})

describe('runsEqual', () => {
  it('compares the list, and treats a missing prior as different', () => {
    expect(runsEqual(undefined, [])).toBe(false)
    expect(runsEqual([], [])).toBe(true)
    expect(runsEqual([run()], [run()])).toBe(true)
    expect(runsEqual([run()], [run({ status: 'completed' })])).toBe(false)
    expect(runsEqual([run()], [run(), run({ runId: 'b' })])).toBe(false)
  })
})
