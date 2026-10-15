// P1/P2 — the driver's two transcript facts: where an ask ended (the boundary), and how a
// diverging actor's session gets that prefix (the fork). Both are contract numbers/ids the
// *engine* trusts, so the tests are about exactness, and about what happens when the
// backend cannot do it at all: degrade and say so, never refuse the run.
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkflowJournal } from '../../src/core/workflow/journal'
import { createArtifactStore } from '../../src/core/workflow/artifacts'
import { createWorldReader } from '../../src/core/workflow/world'
import { createWorkflowDriver } from '../../src/core/workflow/driver'
import { singleBackendRegistry } from '../../src/core/agent/registry'
import { recentLogs } from '../../src/utils/logger'
import type { ActorSessionSeed } from '../../vendor/zcode-dwf/dist/dynamic-workflow/src/index.js'
import type { AgentBackend } from '../../src/core/agent/backend'
import type { StructuredCard } from '../../src/core/structured-card'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ocrc-wf-driver-')) })

const RUN = 'dwfrun-new'
const PREDECESSOR = 'dwfrun-old'

/** Only the log lines a test itself produces — the ring is process-wide. */
async function newLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string }> {
  const before = recentLogs().length
  const result = await fn()
  return { result, logs: recentLogs().slice(before).join('\n') }
}

/** A card window that behaves like the real thing: `limit` defaults to 50 and truncates.
 *  That default is exactly what made every busy actor report a boundary of 50. */
function cards(n: number): StructuredCard[] {
  return Array.from({ length: n }, (_, i) => ({
    kind: 'assistant', sessionId: 'ses_src', ts: i,
    messageId: `msg_${i + 1}`,
    blocks: [{ type: 'text', text: `line ${i + 1}` }],
  })) as unknown as StructuredCard[]
}

type BackendOpts = { fork?: boolean; forkThrows?: boolean; forkRefuses?: boolean; history?: StructuredCard[]; historyThrows?: boolean; live?: string[] }

interface BackendCalls {
  created: Array<{ directory: string; title?: string }>
  forked: Array<{ sessionId: string; messageId?: string }>
  renamed: Array<{ id: string; title: string }>
  historyLimits: Array<number | undefined>
}

function fakeBackend(opts: BackendOpts = {}) {
  const calls: BackendCalls = { created: [], forked: [], renamed: [], historyLimits: [] }
  const backend = {
    id: 'opencode', capabilities: {} as AgentBackend['capabilities'],
    prompt: async () => {}, abort: async () => {},
    hasSession: async (id: string) => (opts.live ?? []).includes(id),
    listSessions: async () => [], listSessionSummaries: async () => [],
    createSession: async (o: { directory: string; title?: string }) => { calls.created.push(o); return { id: 'ses_minted' } },
    deleteSession: async () => {}, renameSession: async (id: string, title: string) => { calls.renamed.push({ id, title }) },
    getSessionMeta: async () => ({}), getContext: async () => ({}),
    // The real backend's page size: an absent `limit` means the engine's own default (50).
    getHistory: async (_id: string, limit?: number) => {
      calls.historyLimits.push(limit)
      if (opts.historyThrows) throw new Error('engine busy')
      return (opts.history ?? []).slice(0, limit ?? 50)
    },
    getMessageBlocks: async () => [], getDiff: async () => [], getTodos: async () => [],
    getSessionsStatus: async () => ({}), ping: async () => true, getAgents: async () => [],
    getModels: async () => [], getMcp: async () => [], listWorkspaces: async () => [],
    listCommands: async () => [], runCommand: async () => {}, resolvePermission: async () => {},
    ...(opts.fork ? {
      forkSession: async (sessionId: string, messageId?: string) => {
        calls.forked.push({ sessionId, messageId })
        if (opts.forkThrows) throw new Error('engine said no')
        if (opts.forkRefuses) return undefined
        return { id: 'ses_forked' }
      },
    } : {}),
  } as unknown as AgentBackend
  return { backend, calls }
}

function makeDriver(opts: BackendOpts = {}) {
  const journal = createWorkflowJournal({ dir })
  const { backend, calls } = fakeBackend(opts)
  const driver = createWorkflowDriver({
    runId: RUN, registry: singleBackendRegistry(backend), journal,
    world: createWorldReader({ cwd: dir }), artifacts: createArtifactStore({ dir, cwd: dir }),
    cwd: dir,
    sink: {
      askSubmitAttempted: () => {}, askTurnEnded: () => {}, askProgress: () => {},
      askStats: () => {}, askFailed: () => {}, stopRun: () => {}, runStalled: () => {},
      askWaiting: () => {}, askExecuting: () => {}, askMutating: () => {}, concurrencyChanged: () => {},
    } as never,
  })
  return { driver, journal, calls }
}

function runRecord(runId: string, extra: Record<string, unknown> = {}) {
  return {
    runId, caps: { maxConcurrency: 4 }, spentTokens: 0, status: 'running' as const,
    cwd: dir, scriptText: 'return 1;', ...extra,
  } as never
}

/** The predecessor's journal facts a seed points at: an actor session and its boundary. */
function seedFacts(journal: ReturnType<typeof createWorkflowJournal>, boundary: { count: number; messageId?: string } = { count: 4, messageId: 'msg_4' }) {
  journal.createRun(runRecord(PREDECESSOR))
  journal.putAskBoundary(PREDECESSOR, {
    siteId: 'site-x', ordinal: 1, sessionId: 'ses_src', count: boundary.count,
    ...(boundary.messageId ? { messageId: boundary.messageId } : {}),
  })
  journal.createRun(runRecord(RUN, { resumedFrom: PREDECESSOR }))
}

const SEED: ActorSessionSeed = { sourceSessionId: 'ses_src', messageCount: 4 }

describe('P2 — transcript seeding for a diverging actor', () => {
  it('forks the source *before* the message that follows the boundary', async () => {
    // The engine's cut is exclusive (measured): forking at message index N copies N
    // messages. Our boundary names the last message *inside* the prefix (index 3 of a
    // 4-unit prefix), so the fork point must be the next one — pointing it at the boundary
    // would drop exactly the message the ask produced.
    const { driver, journal, calls } = makeDriver({ fork: true, history: cards(6) })
    seedFacts(journal)
    const session = await driver.createActorSession({ siteId: 'site-x', ordinal: 1 }, { name: 'analyst' } as never, SEED)
    expect(session.id).toBe('ses_forked')
    expect(calls.forked).toEqual([{ sessionId: 'ses_src', messageId: 'msg_5' }])
    expect(calls.created).toHaveLength(0)
    // The actor row points at the seeded session, so a resume re-attaches to *it*.
    expect(journal.getActor(RUN, 'site-x', 1)?.sessionId).toBe('ses_forked')
    // The fork inherits the source's title, which names the old run; re-titled.
    expect(calls.renamed[0]).toMatchObject({ id: 'ses_forked' })
    expect(calls.renamed[0]!.title).toContain(RUN.slice(-8))
  })

  it('copies the tail when the session ends exactly at the boundary', async () => {
    // No message follows the prefix, so the exclusive cut and the whole-tail copy are the
    // same thing — and the tail copy is what the vendored contract wants there.
    const { driver, journal, calls } = makeDriver({ fork: true, history: cards(4) })
    seedFacts(journal)
    const session = await driver.createActorSession({ siteId: 'site-x', ordinal: 1 }, { name: 'analyst' } as never, SEED)
    expect(session.id).toBe('ses_forked')
    expect(calls.forked).toEqual([{ sessionId: 'ses_src', messageId: undefined }])
  })

  it('takes the fork point from the source transcript, not from the line’s id', async () => {
    // The line's id is a hint at the *boundary*; the fork point is a property of the
    // source as it stands now, so a line with no id still seeds.
    const { driver, journal, calls } = makeDriver({ fork: true, history: cards(6) })
    seedFacts(journal, { count: 4 })
    const session = await driver.createActorSession({ siteId: 'site-x', ordinal: 1 }, { name: 'analyst' } as never, SEED)
    expect(session.id).toBe('ses_forked')
    expect(calls.forked).toEqual([{ sessionId: 'ses_src', messageId: 'msg_5' }])
  })

  it('falls back to the boundary message — one message short, and says so — when the source cannot be read', async () => {
    const { driver, journal, calls } = makeDriver({ fork: true, historyThrows: true })
    seedFacts(journal)
    const { result: session, logs } = await newLogs(() => driver.createActorSession({ siteId: 'site-x', ordinal: 1 }, { name: 'analyst' } as never, SEED))
    expect(session.id).toBe('ses_forked')
    expect(calls.forked).toEqual([{ sessionId: 'ses_src', messageId: 'msg_4' }])
    expect(logs).toContain('one message short')
  })

  it('mints an empty session when the backend has no fork primitive', async () => {
    const { driver, journal, calls } = makeDriver({ fork: false, history: cards(6) })
    seedFacts(journal)
    const { result: session, logs } = await newLogs(() => driver.createActorSession({ siteId: 'site-x', ordinal: 1 }, { name: 'analyst' } as never, SEED))
    expect(session.id).toBe('ses_minted')
    expect(calls.forked).toHaveLength(0)
    expect(calls.created).toHaveLength(1)
    expect(logs).toContain('lacks forkSession')
  })

  it('mints an empty session when no boundary matches the seeded count', async () => {
    const { driver, journal, calls } = makeDriver({ fork: true, history: cards(6) })
    seedFacts(journal)
    // The engine asks for 7 units — the predecessor never recorded that boundary (a
    // two-revision chain reaching past the immediate predecessor, for instance).
    const { result: session, logs } = await newLogs(() =>
      driver.createActorSession({ siteId: 'site-x', ordinal: 1 }, { name: 'analyst' } as never, { sourceSessionId: 'ses_src', messageCount: 7 }))
    expect(session.id).toBe('ses_minted')
    expect(calls.forked).toHaveLength(0)
    expect(logs).toContain('no boundary at 7 units')
  })

  it('mints an empty session when the fork fails or is refused', async () => {
    for (const opts of [{ fork: true, forkThrows: true }, { fork: true, forkRefuses: true }]) {
      const { driver, journal, calls } = makeDriver({ ...opts, history: cards(6) })
      seedFacts(journal)
      const session = await driver.createActorSession({ siteId: 'site-x', ordinal: 1 }, { name: 'analyst' } as never, SEED)
      expect(session.id).toBe('ses_minted')
      expect(calls.created).toHaveLength(1)
      expect(calls.forked).toHaveLength(1)
    }
  })

  it('re-attaches instead of seeding when the actor session is still alive', async () => {
    // The vendored contract's idempotency rule: a crash-resume must not copy the prefix
    // twice. Our mechanism is the journaled session id, so the copy is unreachable here.
    const { driver, journal, calls } = makeDriver({ fork: true, history: cards(6), live: ['ses_live'] })
    seedFacts(journal)
    journal.putActor({ runId: RUN, siteId: 'site-x', ordinal: 1, name: 'analyst', persona: {}, sessionId: 'ses_live' } as never)
    const session = await driver.createActorSession({ siteId: 'site-x', ordinal: 1 }, { name: 'analyst' } as never, SEED)
    expect(session.id).toBe('ses_live')
    expect(calls.forked).toHaveLength(0)
    expect(calls.created).toHaveLength(0)
  })

  it('never seeds when the engine sent no seed at all', async () => {
    const { driver, journal, calls } = makeDriver({ fork: true, history: cards(6) })
    seedFacts(journal)
    const session = await driver.createActorSession({ siteId: 'site-x', ordinal: 1 }, { name: 'analyst' } as never)
    expect(session.id).toBe('ses_minted')
    expect(calls.forked).toHaveLength(0)
  })
})

describe('P1 — the ask boundary is a real count', () => {
  function startAsk(driver: ReturnType<typeof createWorkflowDriver>, sessionId = 'ses_actor') {
    driver.startAsk({ id: sessionId }, { siteId: 'site-x', ordinal: 1 }, { instructions: 'do it', typed: false } as never)
    return sessionId
  }

  it('reads past the engine’s default page and records the true count', async () => {
    // 120 cards: with the default page this boundary read back as 50 — a number the engine
    // would have copied the wrong length of prefix from.
    const { driver, journal, calls } = makeDriver({ history: cards(120) })
    journal.createRun(runRecord(RUN))
    journal.putNode({ runId: RUN, kind: 'ask', siteId: 'site-x', ordinal: 1, inputHash: 'h', status: 'completed', result: null } as never)
    await driver.notifyTurnEnd(startAsk(driver))
    expect(calls.historyLimits.some((l) => (l ?? 0) > 50)).toBe(true)
    expect(journal.getAskBoundary(RUN, 'site-x', 1)).toMatchObject({ count: 120, messageId: 'msg_120', sessionId: 'ses_actor' })
    // The vendored count rides on the node row too — one measurement, two homes.
    expect(journal.getNode(RUN, 'site-x', 1)?.messageBoundary).toBe(120)
  })

  it('says so when the window comes back full instead of publishing a floor as a count', async () => {
    const { driver, journal } = makeDriver({ history: cards(1000) })
    journal.createRun(runRecord(RUN))
    const { logs } = await newLogs(() => driver.notifyTurnEnd(startAsk(driver)))
    expect(journal.getAskBoundary(RUN, 'site-x', 1)?.count).toBe(1000)
    expect(logs).toContain('may be a floor')
  })

  it('records nothing when the transcript cannot be read', async () => {
    const { driver, journal, calls } = makeDriver({ historyThrows: true })
    journal.createRun(runRecord(RUN))
    const { logs } = await newLogs(() => driver.notifyTurnEnd(startAsk(driver)))
    expect(journal.getAskBoundary(RUN, 'site-x', 1)).toBeUndefined()
    // The boundary read is the one that asks for the window (finalText reads its own 20).
    expect(calls.historyLimits.at(-1)).toBe(1000)
    expect(logs).toContain('history read failed')
  })

  it('lands the boundary when the turn ends after the run settled', async () => {
    // The engine calls `dispose()` the moment a run settles, which clears the in-flight
    // tables — but the turn end that owns the final number is still coming. The boundary
    // obligation has to outlive dispose, or the last ask of every run keeps a provisional
    // count (and a seeding copy of it truncates in the wrong place).
    const { driver, journal } = makeDriver({ history: cards(6) })
    journal.createRun(runRecord(RUN))
    startAsk(driver)
    expect(driver.pendingBoundarySessions()).toEqual(['ses_actor'])
    driver.dispose!() // 生产 driver 必实现 dispose；WorkflowDriver 合同标可选（fake 可省）
    expect(driver.inFlightSessions()).toEqual([])
    expect(driver.pendingBoundarySessions()).toEqual(['ses_actor'])
    await driver.notifyTurnEnd('ses_actor')
    expect(journal.getAskBoundary(RUN, 'site-x', 1)).toMatchObject({ count: 6, messageId: 'msg_6' })
    expect(driver.pendingBoundarySessions()).toEqual([])
  })

  it('attributes a turn end to the oldest outstanding exchange on the session', async () => {
    // Two asks can be outstanding on one actor session at once: a typed ask settles at
    // accept (mid-turn) while the model keeps going, so the next ask is dispatched before
    // the first turn ends. The turn end belongs to the older one — a single slot per
    // session silently overwrote it and left that ask at its provisional count.
    const { driver, journal } = makeDriver({ history: cards(4) })
    journal.createRun(runRecord(RUN))
    startAsk(driver)
    driver.startAsk({ id: 'ses_actor' }, { siteId: 'site-x', ordinal: 2 }, { instructions: 'and again', typed: true } as never)
    await driver.notifyTurnEnd('ses_actor')
    expect(journal.getAskBoundary(RUN, 'site-x', 1)).toMatchObject({ count: 4 })
    expect(journal.getAskBoundary(RUN, 'site-x', 2)).toBeUndefined()
    await driver.notifyTurnEnd('ses_actor')
    expect(journal.getAskBoundary(RUN, 'site-x', 2)).toMatchObject({ count: 4 })
    expect(driver.pendingBoundarySessions()).toEqual([])
  })

  it('drops a cancelled ask’s boundary obligation', async () => {
    const { driver, journal } = makeDriver({ history: cards(4) })
    journal.createRun(runRecord(RUN))
    startAsk(driver)
    driver.cancelAsk({ siteId: 'site-x', ordinal: 1 })
    expect(driver.pendingBoundarySessions()).toEqual([])
    await driver.notifyTurnEnd('ses_actor')
    expect(journal.getAskBoundary(RUN, 'site-x', 1)).toBeUndefined()
  })
})
