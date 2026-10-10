// P4-2 — the seven read faces. They are all "journal → vendored wire shape", so the
// tests are about the *derivations* and, above all, about the bounds: an over-bound
// array does not lose an entry on the client, it makes the whole page fail to parse.
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkflowJournal } from '../../src/core/workflow/journal'
import { createArtifactStore } from '../../src/core/workflow/artifacts'
import {
  clampRunsLimit, projectArtifactItems, projectArtifacts, projectNodeResult, projectRunEvents,
  projectRunSummary, projectWorkspace, readArtifactChunk, runLabel, isResumable,
  resolveRunToolCallIds, toolCardRows,
  WORKFLOW_QUERY_LIMITS,
} from '../../src/core/workflow/queries'
import { buildCreateWorkflowDisplay } from '../../src/core/workflow/display'
import type { NodeRecord, RunEvent } from '../../vendor/zcode-dwf/dist/dynamic-workflow/src/index.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ocrc-wf-query-')) })

const RUN = 'dwfrun-query-test'
const CAPS = { maxConcurrency: 4 }

function fixture(opts: {
  events?: RunEvent[]
  nodes?: NodeRecord[]
  status?: 'running' | 'completed' | 'stopped'
  stopReason?: 'user' | 'superseded'
  failure?: { code: string; message: string }
  name?: string
  scriptText?: string
} = {}) {
  const journal = createWorkflowJournal({ dir })
  journal.createRun({
    runId: RUN,
    caps: CAPS,
    spentTokens: 0,
    status: 'running',
    cwd: dir,
    scriptText: opts.scriptText ?? 'return 1;',
    parentSessionId: 'ses_parent',
    ...(opts.name ? { name: opts.name } : {}),
  })
  for (const n of opts.nodes ?? []) journal.putNode(n)
  for (const ev of opts.events ?? []) journal.appendEvent(RUN, ev)
  const status = opts.status ?? 'running'
  if (status !== 'running') {
    journal.updateRunStatus(RUN, status, {
      ...(opts.stopReason ? { stopReason: opts.stopReason } : {}),
      ...(opts.failure ? { failure: opts.failure } : {}),
    })
  }
  return journal
}

const worldNode = (over: Partial<NodeRecord> = {}): NodeRecord => ({
  runId: RUN,
  siteId: 'world-read#1',
  ordinal: 1,
  kind: 'world-read',
  inputHash: 'h',
  status: 'completed',
  input: { op: 'glob', args: ['src/**/*.ts'] },
  result: ['a.ts', 'b.ts'],
  ...over,
})

describe('① projectRunEvents', () => {
  it('splits the event into type + payload and keeps the sequence', () => {
    const journal = fixture({
      events: [
        { type: 'node-executing', instance: { siteId: 'ask#1', ordinal: 1 } },
        { type: 'usage-updated', spentTokens: 42 },
      ],
    })
    const views = projectRunEvents(journal.allEvents(RUN))
    expect(views.map((v) => v.sequence)).toEqual([1, 2])
    expect(views[0]).toMatchObject({ type: 'node-executing', payload: { instance: { siteId: 'ask#1', ordinal: 1 } } })
    expect(views[1]).toMatchObject({ type: 'usage-updated', payload: { spentTokens: 42 } })
    expect(views[1]).not.toHaveProperty('truncated')
  })

  it('bounds an oversized payload and says so instead of dropping the event', () => {
    const journal = fixture({ events: [{ type: 'log', message: 'x'.repeat(20_000) }] })
    const [view] = projectRunEvents(journal.allEvents(RUN))
    expect(view!.type).toBe('log')
    expect(view!.truncated).toBe(true)
    expect((view!.payload.message as string).length).toBe(WORKFLOW_QUERY_LIMITS.EVENT_PAYLOAD_MAX_BYTES)
  })
})

describe('② run summaries', () => {
  it('derives the label from name → script first line → runId', () => {
    expect(runLabel({ ...({ runId: RUN, caps: CAPS, spentTokens: 0, status: 'running' } as any), name: 'nightly' })).toBe('nightly')
    expect(runLabel({ ...({ runId: RUN, caps: CAPS, spentTokens: 0, status: 'running' } as any), scriptText: '// c\nconst a = 1;\nreturn a;' })).toBe('const a = 1;')
    expect(runLabel({ runId: RUN, caps: CAPS, spentTokens: 0, status: 'running' } as any)).toBe(RUN)
  })

  it('reports resumable from the same predicate the resume command uses', () => {
    const stopped = fixture({ status: 'stopped', stopReason: 'user' })
    expect(projectRunSummary(stopped.getRun(RUN)!, { updatedAt: 5 })).toMatchObject({ status: 'stopped', stopReason: 'user', resumable: true, updatedAt: 5 })

    const superseded = fixture({ status: 'stopped', stopReason: 'superseded' })
    expect(isResumable(superseded.getRun(RUN)!)).toBe(false)
    expect(projectRunSummary(superseded.getRun(RUN)!)).toMatchObject({ resumable: false })

    const failed = fixture({ status: 'stopped', failure: { code: 'ProviderStop', message: 'quota' } })
    expect(projectRunSummary(failed.getRun(RUN)!)).toMatchObject({ failureCode: 'ProviderStop', failureMessage: 'quota', resumable: true })
  })

  it('clamps the enumeration limit', () => {
    expect(clampRunsLimit(undefined)).toBe(WORKFLOW_QUERY_LIMITS.RUNS_LIMIT_MAX)
    expect(clampRunsLimit(0)).toBe(1)
    expect(clampRunsLimit(1_000)).toBe(WORKFLOW_QUERY_LIMITS.RUNS_LIMIT_MAX)
  })

  // The vendored directory model drops any row without `toolCallId` (`hasDetailAnchor`),
  // so this join decides whether a run is visible at all — not a cosmetic field.
  it('mints the anchor in the panel’s spelling from the session’s own tool cards', () => {
    const rows = toolCardRows([
      { kind: 'user', messageId: 'msg_0', text: 'hi' } as never,
      {
        kind: 'assistant', messageId: 'msg_1', blocks: [
          { type: 'text', text: 'working' },
          { type: 'tool', tool: 'CreateWorkflow', args: '{}', status: 'done', partId: 'prt_1' },
        ],
      } as never,
      // A tool block with no partId (old engine) has no id to mint from.
      { kind: 'assistant', messageId: 'msg_2', blocks: [{ type: 'tool', tool: 'CreateWorkflow', args: '{}', status: 'done' }] } as never,
    ])
    expect(rows).toEqual([{ toolCallId: 'tool-prt_1', toolName: 'CreateWorkflow', messageId: 'msg_1' }])
  })

  it('resolves the anchor only on an exact (messageId, toolName) match', () => {
    const rows = toolCardRows([{
      kind: 'assistant', messageId: 'msg_1',
      blocks: [{ type: 'tool', tool: 'CreateWorkflow', args: '{}', status: 'done', partId: 'prt_1' }],
    } as never])
    expect(resolveRunToolCallIds({ runA: { messageId: 'msg_1', toolName: 'CreateWorkflow' } }, rows)).toEqual({ runA: 'tool-prt_1' })
    // Same message, different tool: not a match — borrowing the neighbour's id would open
    // a different run's page.
    expect(resolveRunToolCallIds({ runA: { messageId: 'msg_1', toolName: 'AmendWorkflow' } }, rows)).toEqual({})
    expect(resolveRunToolCallIds({ runA: { messageId: 'msg_other', toolName: 'CreateWorkflow' } }, rows)).toEqual({})
    expect(resolveRunToolCallIds({}, rows)).toEqual({})
  })

  it('lets the resolved anchor win only when the record has none', () => {
    const record = fixture({ status: 'completed' }).getRun(RUN)!
    expect(projectRunSummary(record, { toolCallId: 'tool-prt_1' })).toMatchObject({ toolCallId: 'tool-prt_1' })
    expect(projectRunSummary(record)).not.toHaveProperty('toolCallId')
    expect(projectRunSummary({ ...record, toolCallId: 'tool-own' }, { toolCallId: 'tool-prt_1' }))
      .toMatchObject({ toolCallId: 'tool-own' })
  })
})

describe('③④⑤ artifacts', () => {
  it('groups versions per id and takes the latest as the head', () => {
    const journal = fixture({
      events: [
        { type: 'artifact-published', instance: { siteId: 'artifact#1', ordinal: 1 }, artifact: { id: 'report.md', kind: 'markdown', version: 1, bytes: 10, contentType: 'text/markdown', uri: 'u1', publishedAt: 1 } },
        { type: 'artifact-published', instance: { siteId: 'artifact#1', ordinal: 2 }, artifact: { id: 'report.md', kind: 'markdown', version: 2, bytes: 20, title: 'Report', publishedAt: 2 } },
      ],
    })
    const [artifact] = projectArtifacts(journal.allEvents(RUN))
    expect(artifact).toMatchObject({ id: 'report.md', kind: 'markdown', version: 2, title: 'Report', itemCount: 0 })
    expect(artifact!.versions.map((v) => v.version)).toEqual([1, 2])
    expect(artifact!.versions[0]).toMatchObject({ bytes: 10, uri: 'u1', publishedAt: 1 })
  })

  it('counts tagged reports per artifact and pages the board data by sequence', () => {
    const journal = fixture({
      events: [
        { type: 'report', instance: { siteId: 'report#1', ordinal: 1 }, item: { p95: 1 }, artifactId: 'perf' },
        { type: 'report', instance: { siteId: 'report#1', ordinal: 2 }, item: { p95: 2 }, artifactId: 'perf' },
        { type: 'report', instance: { siteId: 'report#1', ordinal: 3 }, item: { other: 1 } },
        { type: 'artifact-published', instance: { siteId: 'artifact#1', ordinal: 1 }, artifact: { id: 'perf', kind: 'metrics', version: 1, publishedAt: 4 } },
      ],
    })
    const events = journal.allEvents(RUN)
    expect(projectArtifacts(events)[0]).toMatchObject({ id: 'perf', kind: 'metrics', itemCount: 2 })

    const first = projectArtifactItems(events, 'perf', { limit: 1 })
    expect(first.hasMore).toBe(true)
    expect(first.items[0]).toMatchObject({ sequence: 1, siteId: 'report#1', ordinal: 1, item: { p95: 1 } })
    const second = projectArtifactItems(events, 'perf', { afterSequence: first.items[0]!.sequence })
    expect(second.items.map((i) => i.sequence)).toEqual([2])
    expect(second.hasMore).toBe(false)
    // An untagged report is not board data for this artifact.
    expect(projectArtifactItems(events, 'perf', { afterSequence: 2 }).items).toEqual([])
  })

  it('reads a byte block and reports the next offset, then null at the end', async () => {
    const store = createArtifactStore({ dir, cwd: dir })
    await store.publish({ runId: RUN, siteId: 'artifact#1', ordinal: 1, op: 'markdown', id: 'out.md', version: 1, content: 'x'.repeat(10) } as never)
    const first = readArtifactChunk(store, RUN, 'out.md', 1, 0, 4)!
    expect(Buffer.from(first.dataBase64, 'base64').toString()).toBe('xxxx')
    expect(first).toMatchObject({ totalBytes: 10, nextOffset: 4, mediaType: 'text/markdown; charset=utf-8' })
    const last = readArtifactChunk(store, RUN, 'out.md', 1, 8, 4)!
    expect(Buffer.from(last.dataBase64, 'base64').toString()).toBe('xx')
    expect(last.nextOffset).toBeNull()
    // An unknown version is "not found", never a path the caller supplied.
    expect(readArtifactChunk(store, RUN, '../../etc/passwd', 1, 0, 4)).toBeUndefined()
  })
})

describe('⑥ projectWorkspace', () => {
  it('lists world calls with a summary and the event-derived timestamps', () => {
    const journal = fixture({
      nodes: [worldNode(), worldNode({ siteId: 'world-run#1', kind: 'world-run', input: { op: 'run', args: ['ls'] }, result: { exitCode: 0, stdout: 'ok', stderr: '' } })],
      events: [
        { type: 'node-queued', instance: { siteId: 'world-read#1', ordinal: 1 }, kind: 'world-read' },
        { type: 'node-settled', instance: { siteId: 'world-read#1', ordinal: 1 }, outcome: 'ok' },
      ],
    })
    const events = journal.allEvents(RUN)
    const view = projectWorkspace(journal.listNodes(RUN), events, 1_000)
    expect(view.truncated).toBeUndefined()
    expect(view.nodes[0]).toMatchObject({ siteId: 'world-read#1', kind: 'world-read', op: 'glob', args: ['src/**/*.ts'], status: 'completed' })
    expect(view.nodes[0]!.summary).toMatchObject({ resultCount: 2 })
    // createdAt/updatedAt come from the events (the node table has no timestamps).
    expect(view.nodes[0]!.createdAt).toBe(events[0]!.timeCreated)
    expect(view.nodes[0]!.updatedAt).toBe(events[1]!.timeCreated)
    expect(view.nodes[1]).toMatchObject({ kind: 'world-run', status: 'completed' })
    expect(view.nodes[1]!.summary).toMatchObject({ exitCode: 0, stdoutBytes: 2, stderrBytes: 0 })
    // A node with no events falls back to the run's own creation time, never 0.
    expect(view.nodes[1]!.createdAt).toBe(1_000)
  })

  it('carries a structured failure and keeps ask nodes out of the transcript', () => {
    const journal = fixture({
      nodes: [
        worldNode({ status: 'failed', error: { code: 'WorldRunDenied', message: 'denied' } as never, result: undefined }),
        { runId: RUN, siteId: 'ask#1', ordinal: 1, kind: 'ask', inputHash: 'h', status: 'completed' },
      ],
    })
    const view = projectWorkspace(journal.listNodes(RUN), [], 1_000)
    expect(view.nodes).toHaveLength(1)
    expect(view.nodes[0]).toMatchObject({ status: 'failed', error: { code: 'WorldRunDenied', message: 'denied' } })
  })
})

describe('⑦ projectNodeResult', () => {
  it('passes a small body through untouched', () => {
    const journal = fixture({ nodes: [worldNode()] })
    const view = projectNodeResult(journal.listNodes(RUN)[0]!)
    expect(view).toMatchObject({ status: 'completed', truncated: false })
    expect(view.result).toEqual(['a.ts', 'b.ts'])
  })

  it('bounds a large body shape-preservingly and reports the true size', () => {
    const big = { stdout: 'y'.repeat(50_000), exitCode: 0 }
    const journal = fixture({ nodes: [worldNode({ result: big })] })
    const view = projectNodeResult(journal.listNodes(RUN)[0]!, 1_024)
    expect(view.truncated).toBe(true)
    expect(view.totalBytes).toBeGreaterThan(1_024)
    // Keys survive (a card's field access must still find them), values are cut.
    expect(Object.keys(view.result as object).sort()).toEqual(['exitCode', 'stdout'])
    expect(((view.result as { stdout: string }).stdout).length).toBeLessThan(50_000)
  })
})

describe('P4-2 display — the tool card’s static picture', () => {
  const SCRIPT = `
phase("collect");
const a = await agent("reader").ask("read");
phase("analyze");
const b = await agent("analyst").ask("analyze " + a);
return { b };
`

  it('builds the graph the run pane draws', () => {
    const display = buildCreateWorkflowDisplay(SCRIPT)
    expect(display).toMatchObject({ kind: 'create_workflow', ok: true, errorCount: 0 })
    const graph = display.causalityGraph as Record<string, any>
    expect(graph.steps.length).toBeGreaterThan(0)
    expect(graph.participants.length).toBeGreaterThan(0)
    expect(graph.phases.map((p: any) => p.name)).toEqual(['collect', 'analyze'])
    expect(graph.phaseEdges.length).toBeGreaterThan(0)
    expect(graph.lanes.length).toBeGreaterThan(0)
  })

  it('reports diagnostics instead of a graph when the script does not typecheck', () => {
    const display = buildCreateWorkflowDisplay('const x: number = "no";\nreturn x;')
    expect(display.ok).toBe(false)
    expect(display.errorCount).toBeGreaterThan(0)
    expect(display.diagnostics[0]).toMatchObject({ line: 1, code: 2322 })
  })

  it('gives a no-phase script a graph without a phase vocabulary', () => {
    const display = buildCreateWorkflowDisplay('const a = await agent("x").ask("hi");\nreturn a;')
    const graph = display.causalityGraph as Record<string, any>
    expect(graph.phases).toBeUndefined()
    expect(graph.phaseEdges).toBeUndefined()
    expect(graph.steps.length).toBeGreaterThan(0)
  })
})
