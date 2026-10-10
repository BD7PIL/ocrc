// P2 — the JSONL journal must satisfy the vendored port exactly: synchronous
// upserts, monotonic event sequence, pagination semantics, and a cold read that
// rebuilds the same state from the file alone.
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkflowJournal } from '../../src/core/workflow/journal'
import type { NodeRecord, RunRecord } from '../../vendor/zcode-dwf/dist/dynamic-workflow/src/index.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ocrc-wf-journal-')) })

function runRecord(runId = 'dwfrun-1'): RunRecord {
  return { runId, caps: { maxConcurrency: 4 }, spentTokens: 0, status: 'pending', cwd: '/tmp/proj' }
}
function nodeRecord(runId: string, siteId: string, ordinal: number, status: NodeRecord['status'] = 'running'): NodeRecord {
  return { runId, siteId, ordinal, kind: 'ask', inputHash: `h-${siteId}-${ordinal}`, status }
}

describe('workflow journal', () => {
  it('round-trips a run record and its status transition', () => {
    const j = createWorkflowJournal({ dir })
    j.createRun(runRecord())
    expect(j.getRun('dwfrun-1')?.status).toBe('pending')

    j.updateRunStatus('dwfrun-1', 'completed', { result: { ok: true } })
    expect(j.getRun('dwfrun-1')).toMatchObject({ status: 'completed', result: { ok: true } })
  })

  it('refuses status/usage/caps writes for an unknown run (port contract)', () => {
    const j = createWorkflowJournal({ dir })
    expect(() => j.updateRunStatus('nope', 'running')).toThrow(/unknown run/)
    expect(() => j.updateRunUsage('nope', 1)).toThrow(/unknown run/)
    expect(() => j.updateRunCaps('nope', { maxConcurrency: 1 })).toThrow(/unknown run/)
  })

  it('upserts actors and nodes by (siteId, ordinal)', () => {
    const j = createWorkflowJournal({ dir })
    j.createRun(runRecord())
    j.putNode(nodeRecord('dwfrun-1', 'site-a', 1))
    j.putNode(nodeRecord('dwfrun-1', 'site-a', 1, 'completed'))
    j.putNode(nodeRecord('dwfrun-1', 'site-b', 1, 'failed'))

    expect(j.getNode('dwfrun-1', 'site-a', 1)?.status).toBe('completed')
    expect(j.listNodes('dwfrun-1')).toHaveLength(2)

    j.putActor({ runId: 'dwfrun-1', siteId: 'site-a', ordinal: 1, name: 'reviewer', sessionId: 'ses_1' })
    j.putActor({ runId: 'dwfrun-1', siteId: 'site-a', ordinal: 1, name: 'reviewer', sessionId: 'ses_1', resolvedModel: 'stub/model' })
    expect(j.getActor('dwfrun-1', 'site-a', 1)?.resolvedModel).toBe('stub/model')
    expect(j.listActors('dwfrun-1')).toHaveLength(1)
  })

  it('assigns a monotonic event sequence and stamps each event with a time', () => {
    const j = createWorkflowJournal({ dir, now: () => 1_700_000_000_000 })
    j.createRun(runRecord())
    const a = j.appendEvent('dwfrun-1', { type: 'run-started', runId: 'dwfrun-1', caps: { maxConcurrency: 4 } })
    const b = j.appendEvent('dwfrun-1', { type: 'run-settled', status: 'completed', artifact: 1 } as never)
    expect([a.sequence, b.sequence]).toEqual([1, 2])
    expect(a.timeCreated).toBe(1_700_000_000_000)
  })

  it('paginates by cursor at the storage layer', () => {
    const j = createWorkflowJournal({ dir })
    j.createRun(runRecord())
    for (let i = 0; i < 5; i++) j.appendEvent('dwfrun-1', { type: 'phase-entered', phaseName: `p${i}` } as never)

    expect(j.listEvents('dwfrun-1')).toHaveLength(5)
    expect(j.listEvents('dwfrun-1', { afterSequence: 3 }).map((e) => e.sequence)).toEqual([4, 5])
    expect(j.listEvents('dwfrun-1', { afterSequence: 0, limit: 2 }).map((e) => e.sequence)).toEqual([1, 2])
    // Unknown run / out-of-range cursor are empty, never an error.
    expect(j.listEvents('nope')).toEqual([])
    expect(j.listEvents('dwfrun-1', { afterSequence: 99 })).toEqual([])
  })

  it('rebuilds identical state from the file alone (cold read)', () => {
    const j = createWorkflowJournal({ dir })
    j.createRun(runRecord())
    j.putNode(nodeRecord('dwfrun-1', 'site-a', 1, 'completed'))
    j.putActor({ runId: 'dwfrun-1', siteId: 'site-a', ordinal: 1, sessionId: 'ses_1' })
    j.appendEvent('dwfrun-1', { type: 'run-started', runId: 'dwfrun-1', caps: { maxConcurrency: 4 } })
    j.updateRunUsage('dwfrun-1', 1234)
    j.updateRunStatus('dwfrun-1', 'stopped', { stopReason: 'interrupted' })

    const cold = createWorkflowJournal({ dir })
    expect(cold.getRun('dwfrun-1')).toMatchObject({ status: 'stopped', stopReason: 'interrupted', spentTokens: 1234 })
    expect(cold.getNode('dwfrun-1', 'site-a', 1)?.status).toBe('completed')
    expect(cold.getActor('dwfrun-1', 'site-a', 1)?.sessionId).toBe('ses_1')
    expect(cold.listEvents('dwfrun-1')).toHaveLength(1)
  })

  it('persists ask boundaries per instance, and the last write wins', () => {
    const j = createWorkflowJournal({ dir })
    j.createRun(runRecord())
    j.putAskBoundary('dwfrun-1', { siteId: 'site-a', ordinal: 1, sessionId: 'ses_1', count: 4, messageId: 'msg_4' })
    j.putAskBoundary('dwfrun-1', { siteId: 'site-a', ordinal: 2, sessionId: 'ses_2', count: 9 })
    // A re-measure of the same ask (a repair round) replaces it rather than stacking.
    j.putAskBoundary('dwfrun-1', { siteId: 'site-a', ordinal: 1, sessionId: 'ses_1', count: 6, messageId: 'msg_6' })

    const cold = createWorkflowJournal({ dir })
    expect(cold.getAskBoundary('dwfrun-1', 'site-a', 1)).toEqual({ siteId: 'site-a', ordinal: 1, sessionId: 'ses_1', count: 6, messageId: 'msg_6' })
    expect(cold.getAskBoundary('dwfrun-1', 'site-a', 2)).toMatchObject({ count: 9 })
    expect(cold.getAskBoundary('dwfrun-1', 'site-b', 1)).toBeUndefined()
    expect(cold.listAskBoundaries('dwfrun-1')).toHaveLength(2)
  })

  it('survives a torn trailing line (crash mid-append)', () => {
    const j = createWorkflowJournal({ dir })
    j.createRun(runRecord())
    j.appendEvent('dwfrun-1', { type: 'run-started', runId: 'dwfrun-1', caps: { maxConcurrency: 4 } })
    const file = j.filePath('dwfrun-1')
    writeFileSync(file, readFileSync(file, 'utf-8') + '{"k":"event","seq":2,"at":1,"ev":{')

    const cold = createWorkflowJournal({ dir })
    expect(cold.getRun('dwfrun-1')?.runId).toBe('dwfrun-1')
    expect(cold.listEvents('dwfrun-1')).toHaveLength(1)
  })

  it('lists runs newest-first and can drop one', () => {
    const j = createWorkflowJournal({ dir })
    j.createRun(runRecord('dwfrun-a'))
    j.createRun(runRecord('dwfrun-b'))
    expect(j.listRuns().map((r) => r.runId).sort()).toEqual(['dwfrun-a', 'dwfrun-b'])
    j.drop('dwfrun-a')
    expect(j.listRuns().map((r) => r.runId)).toEqual(['dwfrun-b'])
  })

  it('refuses a runId that could escape the runs directory', () => {
    const j = createWorkflowJournal({ dir })
    expect(() => j.createRun(runRecord('../../etc/passwd'))).toThrow(/unsafe runId/)
  })
})
