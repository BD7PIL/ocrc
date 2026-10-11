// P4-1a — the run projection is the bridge between the journal and the panel, so the
// tests here are about *derivations*: every field must come from a fact the journal
// actually holds, and nothing may be invented. Two of these are load-bearing enough to
// name up front:
//   - the bounds are the vendored wire limits (an over-bound table makes the client's
//     whole frame fail to parse), so clamping must set `truncated` and never silently
//     drop rows without it;
//   - `resumable` must equal the manager's own resume predicate, or the panel shows a
//     Resume button that the command then refuses.
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkflowJournal } from '../../src/core/workflow/journal'
import { createEscalationRegistry } from '../../src/core/workflow/escalations'
import { projectRun, projectRuns, serializePreview, WORKFLOW_PROJECTION_LIMITS } from '../../src/core/workflow/projection'
import { analyzePhases } from '../../src/core/workflow/phases'
import { compileScript } from '../../src/core/workflow/manager'
import type { NodeRecord, RunEvent } from '../../vendor/zcode-dwf/dist/dynamic-workflow/src/index.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ocrc-wf-proj-')) })

const CAPS = { maxConcurrency: 4 }

/** A journal with one run and the given events; returns the projection inputs. */
function fixture(opts: {
  events?: RunEvent[]
  status?: 'running' | 'completed' | 'stopped' | 'errored'
  stopReason?: 'user' | 'interrupted' | 'superseded'
  supersededBy?: string
  resumedFrom?: string
  result?: unknown
  failure?: { code: string; message: string }
  nodes?: NodeRecord[]
  actors?: Array<{ siteId: string; ordinal: number; name?: string; sessionId?: string }>
}) {
  const journal = createWorkflowJournal({ dir })
  const runId = 'dwfrun-aaaa-bbbb'
  journal.createRun({
    runId,
    caps: CAPS,
    spentTokens: 0,
    status: 'running',
    cwd: dir,
    scriptText: 'return 1;',
    parentSessionId: 'ses_parent',
    ...(opts.resumedFrom ? { resumedFrom: opts.resumedFrom } : {}),
  })
  for (const a of opts.actors ?? []) journal.putActor({ runId, ...a })
  for (const n of opts.nodes ?? []) journal.putNode(n)
  for (const ev of opts.events ?? []) journal.appendEvent(runId, ev)
  const status = opts.status ?? 'running'
  if (status !== 'running') {
    journal.updateRunStatus(runId, status, {
      ...(opts.stopReason ? { stopReason: opts.stopReason } : {}),
      ...(opts.supersededBy ? { supersededBy: opts.supersededBy } : {}),
      ...(opts.failure ? { failure: opts.failure } : {}),
      ...(opts.result !== undefined ? { result: opts.result } : {}),
    })
  }
  return { journal, runId }
}

function project(journal: ReturnType<typeof createWorkflowJournal>, runId: string, over: Record<string, unknown> = {}) {
  return projectRun({
    record: journal.getRun(runId)!,
    actors: journal.listActors(runId, { withPersona: true }),
    nodes: journal.listNodes(runId, { kinds: 'all', withResult: true }),
    events: journal.allEvents(runId),
    ceiling: 8,
    ...over,
  })
}

const askNode = (over: Partial<NodeRecord> = {}): NodeRecord => ({
  runId: 'dwfrun-aaaa-bbbb',
  siteId: 'ask#1',
  ordinal: 1,
  kind: 'ask',
  actorSiteId: 'agent#1',
  actorOrdinal: 1,
  inputHash: 'h1',
  status: 'running',
  ...over,
})

describe('projectRun — lifecycle from events, outcomes from records', () => {
  it('derives node phases from node events and settles from the row', () => {
    const { journal, runId } = fixture({
      events: [
        { type: 'node-queued', instance: { siteId: 'ask#1', ordinal: 1 }, kind: 'ask', actor: { siteId: 'agent#1', ordinal: 1 }, instructionsHead: 'read the config' },
        { type: 'node-dispatched', instance: { siteId: 'ask#1', ordinal: 1 } },
        { type: 'node-executing', instance: { siteId: 'ask#1', ordinal: 1 } },
      ],
      nodes: [askNode()],
    })
    const run = project(journal, runId)
    expect(run.nodes).toHaveLength(1)
    expect(run.nodes[0]).toMatchObject({
      siteId: 'ask#1',
      ordinal: 1,
      kind: 'ask',
      phase: 'executing',
      actorSiteId: 'agent#1',
      actorOrdinal: 1,
      instructionsHead: 'read the config',
    })
    // No fabricated progress readings: our driver does not emit `node-progress`, so the
    // vendored "absent means unknown" rule is the honest answer.
    expect(run.nodes[0]).not.toHaveProperty('turn')
    expect(run.nodes[0]).not.toHaveProperty('toolCalls')
    expect(run.nodes[0]).not.toHaveProperty('lastTool')
  })

  it('lets the settled row win over a stale executing event', () => {
    const { journal, runId } = fixture({
      events: [
        { type: 'node-queued', instance: { siteId: 'ask#1', ordinal: 1 }, kind: 'ask' },
        { type: 'node-executing', instance: { siteId: 'ask#1', ordinal: 1 } },
      ],
      nodes: [askNode({ status: 'completed', result: { ok: 1 } })],
    })
    expect(project(journal, runId).nodes[0]).toMatchObject({ phase: 'settled', outcome: 'ok' })
  })

  it('carries the cache hit marker of a replayed settle', () => {
    const { journal, runId } = fixture({
      events: [{ type: 'node-settled', instance: { siteId: 'ask#1', ordinal: 1 }, outcome: 'ok', cached: true }],
      nodes: [askNode({ status: 'completed' })],
    })
    expect(project(journal, runId).nodes[0]).toMatchObject({ phase: 'settled', cached: true })
  })

  it('keeps report/artifact rows out of nodes[] (they are not steps of work)', () => {
    const { journal, runId } = fixture({
      nodes: [
        askNode(),
        { runId: 'dwfrun-aaaa-bbbb', siteId: 'report#1', ordinal: 1, kind: 'report', inputHash: 'h2', status: 'completed' },
        { runId: 'dwfrun-aaaa-bbbb', siteId: 'artifact#1', ordinal: 1, kind: 'artifact', inputHash: 'h3', status: 'completed' },
      ],
    })
    const run = project(journal, runId)
    expect(run.nodes.map((n) => n.siteId)).toEqual(['ask#1'])
    expect(run.usage.nodesUsed).toBe(1)
  })

  it('derives actor status from its nodes and the run terminal state', () => {
    const { journal, runId } = fixture({
      events: [{ type: 'node-executing', instance: { siteId: 'ask#1', ordinal: 1 } }],
      actors: [
        { siteId: 'agent#1', ordinal: 1, name: 'reader', sessionId: 'ses_a1' },
        { siteId: 'agent#2', ordinal: 1, name: 'idle' },
      ],
      nodes: [askNode()],
    })
    const run = project(journal, runId)
    expect(run.actors).toEqual([
      { siteId: 'agent#1', ordinal: 1, name: 'reader', sessionId: 'ses_a1', status: 'running' },
      { siteId: 'agent#2', ordinal: 1, name: 'idle', status: 'waiting' },
    ])
  })

  it('reports usage from the engine total and the node table', () => {
    const { journal, runId } = fixture({
      events: [{ type: 'usage-updated', spentTokens: 1234 }],
      nodes: [askNode({ status: 'completed' }), askNode({ siteId: 'ask#2', ordinal: 2 })],
    })
    const run = project(journal, runId)
    expect(run.usage).toEqual({ spentTokens: 1234, nodesUsed: 2 })
  })

  it('resets the token counter on a resume (run-started), like the vendored reducer', () => {
    const { journal, runId } = fixture({
      events: [
        { type: 'usage-updated', spentTokens: 500 },
        { type: 'run-started', runId: 'dwfrun-aaaa-bbbb', caps: CAPS },
        { type: 'usage-updated', spentTokens: 40 },
      ],
    })
    expect(project(journal, runId).usage.spentTokens).toBe(40)
  })
})

describe('projectRun — phases, reports, artifacts, questions', () => {
  it('builds the phase table from phase-entered and the declared table from run-launched', () => {
    const { journal, runId } = fixture({
      events: [
        { type: 'run-launched', inputId: 'in-1', phaseNames: ['collect', 'analyze'], subagentModel: 'zai/glm-4.6' },
        { type: 'phase-entered', name: 'collect', ordinal: 1 },
        { type: 'phase-entered', name: 'analyze', ordinal: 1 },
        { type: 'phase-entered', name: 'collect', ordinal: 2 },
      ],
    })
    const run = project(journal, runId)
    expect(run.phaseNames).toEqual(['collect', 'analyze'])
    expect(run.subagentModel).toBe('zai/glm-4.6')
    // rounds takes the max ordinal (a resume replays the prefix and must not double it).
    expect(run.phases).toEqual([{ name: 'collect', rounds: 2 }, { name: 'analyze', rounds: 1 }])
    expect(run.currentPhase).toBe('collect')
  })

  it('omits reports/pendingQuestions/artifacts entirely when there are none', () => {
    const { journal, runId } = fixture({})
    const run = project(journal, runId)
    // The vendored convention is "zero rows ⇒ the key is absent", not an empty array:
    // the side panel hides the section from absence, not from emptiness.
    expect(run).not.toHaveProperty('reports')
    expect(run).not.toHaveProperty('pendingQuestions')
    expect(run).not.toHaveProperty('artifacts')
    expect(run).not.toHaveProperty('phases')
  })

  it('projects reports with the vendored serialization rule and de-dupes by instance', () => {
    const { journal, runId } = fixture({
      events: [
        { type: 'report', instance: { siteId: 'report#1', ordinal: 1 }, item: { p95: 12 } },
        { type: 'report', instance: { siteId: 'report#1', ordinal: 1 }, item: { p95: 12 } },
        { type: 'report', instance: { siteId: 'report#1', ordinal: 2 }, item: 'plain text', artifactId: 'perf' },
      ],
    })
    const run = project(journal, runId)
    expect(run.reports).toHaveLength(2)
    expect(run.reports?.[0]!.preview).toBe('{\n  "p95": 12\n}')
    expect(run.reports?.[1]).toMatchObject({ preview: 'plain text', artifactId: 'perf' })
  })

  it('counts tagged reports into the artifact itemCount', () => {
    const { journal, runId } = fixture({
      events: [
        { type: 'report', instance: { siteId: 'report#1', ordinal: 1 }, item: 1, artifactId: 'perf' },
        { type: 'report', instance: { siteId: 'report#1', ordinal: 2 }, item: 2, artifactId: 'perf' },
        {
          type: 'artifact-published',
          instance: { siteId: 'artifact#1', ordinal: 1 },
          artifact: { id: 'perf', kind: 'metrics', version: 1, title: 'Perf' },
        },
      ],
    })
    const run = project(journal, runId)
    expect(run.artifacts).toEqual([{ id: 'perf', kind: 'metrics', version: 1, title: 'Perf', itemCount: 2 }])
  })

  it('keeps only the newest version of an artifact', () => {
    const { journal, runId } = fixture({
      events: [
        { type: 'artifact-published', instance: { siteId: 'artifact#1', ordinal: 1 }, artifact: { id: 'r', kind: 'markdown', version: 1 } },
        { type: 'artifact-published', instance: { siteId: 'artifact#1', ordinal: 2 }, artifact: { id: 'r', kind: 'markdown', version: 2, title: 'Report' } },
      ],
    })
    expect(project(journal, runId).artifacts).toEqual([{ id: 'r', kind: 'markdown', version: 2, title: 'Report' }])
  })

  it('merges the byte store into an artifact the events do not describe', () => {
    const { journal, runId } = fixture({})
    const run = project(journal, runId, {
      artifacts: [{ id: 'out.md', kind: 'file', version: 1, contentType: 'text/markdown; charset=utf-8', bytes: 42 }],
    })
    expect(run.artifacts).toEqual([{ id: 'out.md', kind: 'file', version: 1, contentType: 'text/markdown; charset=utf-8', bytes: 42 }])
  })

  it('lists an escalation as a pending question and drops it once answered', () => {
    const escalations = createEscalationRegistry()
    const { journal, runId } = fixture({ actors: [{ siteId: 'agent#1', ordinal: 1, name: 'reader', sessionId: 'ses_a1' }] })
    escalations.raise({ runId, question: 'Which config?', sessionId: 'ses_a1' })
    let run = project(journal, runId, { escalations: escalations.all(runId) })
    expect(run.pendingQuestions).toHaveLength(1)
    expect(run.pendingQuestions?.[0]).toMatchObject({ question: 'Which config?', actorSiteId: 'agent#1', actorName: 'reader' })
    expect(run.pendingQuestions?.[0]!.qid).toMatch(/^dwfq-/)

    escalations.answer(runId, 'Which config?', 'the prod one')
    run = project(journal, runId, { escalations: escalations.all(runId) })
    expect(run).not.toHaveProperty('pendingQuestions')
  })

  it('reads engine-raised escalations and honours resolution', () => {
    const { journal, runId } = fixture({
      events: [
        { type: 'escalation-raised', qid: 'dwfq-x-1', actor: { siteId: 'agent#1', ordinal: 1 }, actorName: 'reader', question: 'blocked', askedAt: 111 },
        { type: 'escalation-raised', qid: 'dwfq-x-2', actor: { siteId: 'agent#2', ordinal: 1 }, question: 'other', askedAt: 222 },
        { type: 'escalation-resolved', qid: 'dwfq-x-1', answer: 'because' },
      ],
    })
    const run = project(journal, runId)
    expect(run.pendingQuestions).toEqual([
      { qid: 'dwfq-x-2', actorSiteId: 'agent#2', actorOrdinal: 1, question: 'other', askedAt: 222 },
    ])
  })
})

describe('projectRun — resumable / result / concurrency / bounds', () => {
  it('marks a stopped run resumable and a superseded one not', () => {
    const stopped = fixture({ status: 'stopped', stopReason: 'interrupted' })
    expect(project(stopped.journal, stopped.runId).resumable).toBe(true)

    const superseded = fixture({ status: 'stopped', stopReason: 'superseded', supersededBy: 'dwfrun-next' })
    const run = project(superseded.journal, superseded.runId)
    expect(run.resumable).toBeUndefined()
    expect(run.supersededBy).toBe('dwfrun-next')

    const completed = fixture({ status: 'completed', result: { ok: true } })
    expect(project(completed.journal, completed.runId).resumable).toBeUndefined()
  })

  it('previews the run result and the failure message', () => {
    const done = fixture({ status: 'completed', result: { files: 3 } })
    expect(project(done.journal, done.runId).resultPreview).toBe('{\n  "files": 3\n}')

    const failed = fixture({ status: 'errored', failure: { code: 'ScriptError', message: 'boom' } })
    const run = project(failed.journal, failed.runId)
    expect(run.error).toBe('ScriptError: boom')
    expect(run.status).toBe('errored')
  })

  it('reports a run limit below the process ceiling, and stays quiet on the ceiling', () => {
    // ocrc's default per-run cap is 4, so on a wide machine the readout is always
    // meaningful ("4 of 8"); a run whose limit *is* the ceiling has nothing to say.
    const limited = fixture({})
    expect(project(limited.journal, limited.runId).concurrency).toEqual({ cap: 4, ceiling: 8, limit: 4 })
    expect(project(limited.journal, limited.runId).concurrencyCeiling).toBe(8)

    const onCeiling = fixture({})
    const run = project(onCeiling.journal, onCeiling.runId, { ceiling: 4 })
    expect(run).not.toHaveProperty('concurrency')
    expect(run.concurrencyCeiling).toBe(4)
  })

  it('surfaces a lowered per-run limit and a throttled shared cap', () => {
    const { journal, runId } = fixture({
      events: [
        { type: 'run-caps-changed', runId: 'dwfrun-aaaa-bbbb', caps: { maxConcurrency: 2 }, previous: CAPS },
        { type: 'concurrency-changed', key: 'zai/glm-4.6', previous: 8, next: 3, reason: 'retry_after' as never },
      ],
    })
    expect(project(journal, runId).concurrency).toEqual({ key: 'zai/glm-4.6', cap: 3, ceiling: 8, limit: 2 })
  })

  it('clamps every table to the vendored wire bounds and flags truncation', () => {
    const nodes: NodeRecord[] = []
    for (let i = 1; i <= WORKFLOW_PROJECTION_LIMITS.maxNodes + 5; i++) {
      nodes.push(askNode({ siteId: 'ask#1', ordinal: i, status: 'completed' }))
    }
    const { journal, runId } = fixture({ nodes })
    const run = project(journal, runId)
    // Over-bound tables do not lose a key on the client — they make the whole frame
    // fail to parse, so the projection must clamp and say so.
    expect(run.nodes).toHaveLength(WORKFLOW_PROJECTION_LIMITS.maxNodes)
    expect(run.truncated).toBe(true)
  })

  it('caps the run list at the vendored maxRuns', () => {
    const { journal, runId } = fixture({})
    const inputs = Array.from({ length: WORKFLOW_PROJECTION_LIMITS.maxRuns + 3 }, () => ({
      record: journal.getRun(runId)!,
      actors: [],
      nodes: [],
      events: [],
    }))
    expect(projectRuns(inputs)).toHaveLength(WORKFLOW_PROJECTION_LIMITS.maxRuns)
  })
})

describe('serializePreview', () => {
  it('passes strings through and pretty-prints everything else', () => {
    expect(serializePreview('already text')).toBe('already text')
    expect(serializePreview([1, 2])).toBe('[\n  1,\n  2\n]')
    expect(serializePreview(undefined)).toBeUndefined()
  })
})

describe('analyzePhases — the declared rail', () => {
  it('returns nothing for a script with no phase markers', () => {
    expect(analyzePhases('const a = await agent("x").ask("y");\nreturn a;')).toEqual({})
  })

  it('reads the declared table in first-reach order', () => {
    const out = analyzePhases(`
phase("collect");
const a = await agent("reader").ask("read");
phase("analyze");
const b = await agent("analyst").ask("analyze " + a);
return { b };
`)
    expect(out.phaseNames).toEqual(['collect', 'analyze'])
    // Ordered phases are a straight line: the key stays absent (vendored reading).
    expect(out.phaseAlongside).toBeUndefined()
  })

  it('marks unordered phases as concurrent', () => {
    const out = analyzePhases(`
phase("left");
const p = agent("l").ask("left");
phase("right");
const q = agent("r").ask("right");
const [a, b] = await Promise.all([p, q]);
phase("join");
const c = await agent("j").ask("join " + a + b);
return { c };
`)
    expect(out.phaseNames).toEqual(['left', 'right', 'join'])
    expect(out.phaseAlongside).toEqual([[], [0], []])
  })

  it('is wired into compileScript (the launch metadata comes from the compile pass)', () => {
    const out = compileScript('phase("a");\nconst x = await agent("g").ask("hi");\nreturn x;')
    expect(out.ok).toBe(true)
    expect(out.phaseNames).toEqual(['a'])
  })
})
