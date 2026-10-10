// P4b — the amend-resume import cache. Two things matter and both are about honesty:
// the preflight is all-or-nothing (a half-built cache mixes imported and re-run results
// invisibly), and the builder must never invent a boundary it does not have (a fabricated
// count would silently seed the wrong transcript length).
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkflowJournal } from '../../src/core/workflow/journal'
import { buildImportedCache, buildResumeCache } from '../../src/core/workflow/imported-cache'
import type { NodeRecord } from '../../vendor/zcode-dwf/dist/dynamic-workflow/src/index.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ocrc-wf-cache-')) })

const RUN = 'dwfrun-pred'
const CAPS = { maxConcurrency: 4 }

function fixture(opts: {
  actors?: Array<{ siteId: string; ordinal: number; name?: string; sessionId?: string; resolvedModel?: string; persona?: Record<string, unknown> }>
  nodes?: NodeRecord[]
  resumedFrom?: string
} = {}) {
  const journal = createWorkflowJournal({ dir })
  journal.createRun({
    runId: RUN, caps: CAPS, spentTokens: 0, status: 'completed', cwd: dir,
    scriptText: 'return 1;', parentSessionId: 'ses_parent',
    ...(opts.resumedFrom ? { resumedFrom: opts.resumedFrom } : {}),
  })
  for (const a of opts.actors ?? []) journal.putActor({ runId: RUN, ...a })
  for (const n of opts.nodes ?? []) journal.putNode(n)
  return journal
}

// The journal keys node rows by (siteId, ordinal), so a test that wants several
// instances of one site must give them distinct ordinals — otherwise they overwrite each
// other and the "prefix" is a single row.
const ask = (over: Partial<NodeRecord> = {}): NodeRecord => ({
  runId: RUN, siteId: 'ask#1', ordinal: 1, kind: 'ask',
  actorSiteId: 'actor#1', actorOrdinal: 1, actorSeq: 1,
  inputHash: 'h1', status: 'completed', result: { ok: 1 }, messageBoundary: 4,
  ...over,
})

describe('buildImportedCache', () => {
  it('indexes a named actor’s completed ask prefix by actorSeq', () => {
    const journal = fixture({
      actors: [{ siteId: 'actor#1', ordinal: 1, name: 'reader', sessionId: 'ses_a', resolvedModel: 'zai/glm-4.6', persona: { name: 'reader' } }],
      nodes: [
        ask({ ordinal: 1, actorSeq: 1, inputHash: 'h1', result: { a: 1 }, messageBoundary: 4 }),
        ask({ ordinal: 2, actorSeq: 2, inputHash: 'h2', result: { b: 2 }, messageBoundary: 9 }),
      ],
    })
    const built = buildImportedCache(journal, RUN)
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.stats).toEqual({ actors: 1, askEntries: 2, worldEntries: 0 })
    const candidate = built.cache.actors.get('reader')!
    expect(candidate.transcriptSourceSessionId).toBe('ses_a')
    expect(candidate.resolvedModel).toBe('zai/glm-4.6')
    expect(candidate.entries.map((e) => [e.inputHash, e.messageBoundary])).toEqual([['h1', 4], ['h2', 9]])
  })

  it('stops the prefix at the first unfinished ask (a hole would renumber the rest)', () => {
    const journal = fixture({
      actors: [{ siteId: 'actor#1', ordinal: 1, name: 'reader', sessionId: 'ses_a' }],
      nodes: [
        ask({ ordinal: 1, actorSeq: 1, inputHash: 'h1', messageBoundary: 4 }),
        ask({ ordinal: 2, actorSeq: 2, inputHash: 'h2', status: 'running', result: undefined, messageBoundary: undefined }),
        ask({ ordinal: 3, actorSeq: 3, inputHash: 'h3', messageBoundary: 12 }),
      ],
    })
    const built = buildImportedCache(journal, RUN)
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.cache.actors.get('reader')!.entries.map((e) => e.inputHash)).toEqual(['h1'])
  })

  it('refuses the whole cache when a completed ask has no boundary (the vendored gate)', () => {
    const journal = fixture({
      actors: [{ siteId: 'actor#1', ordinal: 1, name: 'reader', sessionId: 'ses_a' }],
      nodes: [
        ask({ ordinal: 1, actorSeq: 1, inputHash: 'h1', messageBoundary: 4 }),
        ask({ ordinal: 2, actorSeq: 2, inputHash: 'h2', messageBoundary: undefined }),
      ],
    })
    expect(buildImportedCache(journal, RUN)).toMatchObject({ ok: false, reason: 'missing_boundaries' })
  })

  it('takes the count from the host boundary line when there is one', () => {
    // The driver writes both (the line and the node field); the line is the one the fork
    // path reads, so it is the reading the cache must agree with. This row has a node
    // count of 4 and a line count of 41: the line wins.
    const journal = fixture({
      actors: [{ siteId: 'actor#1', ordinal: 1, name: 'reader', sessionId: 'ses_a' }],
      nodes: [ask({ ordinal: 1, actorSeq: 1, inputHash: 'h1', messageBoundary: 4 })],
    })
    journal.putAskBoundary(RUN, { siteId: 'ask#1', ordinal: 1, sessionId: 'ses_a', count: 41, messageId: 'msg_41' })
    const built = buildImportedCache(journal, RUN)
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.cache.actors.get('reader')!.entries[0]!.messageBoundary).toBe(41)
  })

  it('still uses the node count for a run journalled before the line existed', () => {
    const journal = fixture({
      actors: [{ siteId: 'actor#1', ordinal: 1, name: 'reader', sessionId: 'ses_a' }],
      nodes: [ask({ ordinal: 1, actorSeq: 1, inputHash: 'h1', messageBoundary: 4 })],
    })
    const built = buildImportedCache(journal, RUN)
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.cache.actors.get('reader')!.entries[0]!.messageBoundary).toBe(4)
  })

  it('skips an anonymous actor and one with no session (nothing to address)', () => {
    const journal = fixture({
      actors: [
        { siteId: 'actor#1', ordinal: 1, sessionId: 'ses_a' },              // anonymous
        { siteId: 'actor#2', ordinal: 1, name: 'solo' },                     // no session
        { siteId: 'actor#3', ordinal: 1, name: 'worker', sessionId: 'ses_c' },
      ],
      nodes: [
        ask({ siteId: 'ask#1', actorSiteId: 'actor#1', actorOrdinal: 1 }),
        ask({ siteId: 'ask#2', actorSiteId: 'actor#2', actorOrdinal: 1 }),
        ask({ siteId: 'ask#3', actorSiteId: 'actor#3', actorOrdinal: 1, inputHash: 'h3' }),
      ],
    })
    const built = buildImportedCache(journal, RUN)
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect([...built.cache.actors.keys()]).toEqual(['worker'])
    expect(built.stats.actors).toBe(1)
  })

  it('queues world reads by input hash, in journal order', () => {
    const journal = fixture({
      nodes: [
        { runId: RUN, siteId: 'world-read#1', ordinal: 1, kind: 'world-read', inputHash: 'w1', status: 'completed', result: ['a'] },
        { runId: RUN, siteId: 'world-read#1', ordinal: 2, kind: 'world-read', inputHash: 'w1', status: 'completed', result: ['b'] },
        { runId: RUN, siteId: 'world-run#1', ordinal: 1, kind: 'world-run', inputHash: 'w2', status: 'failed', result: undefined },
      ],
    })
    const built = buildImportedCache(journal, RUN)
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.cache.world.get('w1')!.map((e) => e.result)).toEqual([['a'], ['b']])
    // A failed world call is not an importable result.
    expect(built.cache.world.has('w2')).toBe(false)
    expect(built.stats.worldEntries).toBe(2)
  })

  it('reports no_entries for an unknown run and for a run with nothing importable', () => {
    const journal = fixture({})
    expect(buildImportedCache(journal, 'dwfrun-nope')).toMatchObject({ ok: false, reason: 'no_entries' })
    expect(buildImportedCache(journal, RUN)).toMatchObject({ ok: false, reason: 'no_entries' })
  })
})

describe('buildResumeCache', () => {
  it('rebuilds from the run’s own predecessor', () => {
    const journal = fixture({
      actors: [{ siteId: 'actor#1', ordinal: 1, name: 'reader', sessionId: 'ses_a' }],
      nodes: [ask({ messageBoundary: 4 })],
    })
    // A revision of RUN, resumed from it.
    const next = 'dwfrun-next'
    journal.createRun({ runId: next, caps: CAPS, spentTokens: 0, status: 'running', cwd: dir, resumedFrom: RUN })
    const built = buildResumeCache(journal, journal.getRun(next)!)
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.cache.actors.get('reader')!.entries).toHaveLength(1)
  })

  it('reports no_entries when the run is not a revision', () => {
    const journal = fixture({ nodes: [ask({ messageBoundary: 4 })] })
    expect(buildResumeCache(journal, journal.getRun(RUN)!)).toMatchObject({ ok: false, reason: 'no_entries' })
  })
})
