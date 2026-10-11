import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ActorRecord,
  Caps,
  JournalStorePort,
  ListActorsOptions,
  ListEventsOptions,
  ListNodesOptions,
  NodeKind,
  NodeRecord,
  RunEvent,
  RunRecord,
  RunSettlementRecord,
  RunStatus,
  StoredEvent,
} from '../../../vendor/zcode-dwf/dist/dynamic-workflow/src/index.js'

/**
 * JSONL journal — the host's `JournalStorePort` implementation.
 *
 * One file per run: `<workflowsDir>/runs/<runId>.jsonl`, one JSON object per line,
 * appended synchronously. Why not the upstream's SQLite: this deployment's floor is
 * EL7 / glibc 2.17, where native modules (better-sqlite3) are a real risk, while
 * `appendFileSync` is O(1), crash-safe to the last complete line, and matches the
 * rest of ocrc's stores (state.json / schedules.json / acp-sessions.json).
 *
 * The port is synchronous by contract, so every read is served from an in-memory
 * index that is built once per run (lazily, from the file) and kept current on
 * writes. A run's journal is therefore read from disk at most once per process.
 *
 * Line kinds (the `k` field):
 *   run         the RunRecord as created (full snapshot, written once)
 *   run-status  {status, settlement?} — the terminal/again status transition
 *   run-usage   {spentTokens}
 *   run-caps    {caps}
 *   run-script  {scriptText, scriptHash} — engine writes back the effective script (v3.15.1)
 *   run-join    {join} — host-only metadata: which tool call started this run
 *   ask-boundary {boundary} — host-only metadata: where an ask ended in its actor's
 *                 transcript (the count plus the id a fork can stop at)
 *   actor       full ActorRecord snapshot (upsert by siteId/ordinal)
 *   node        full NodeRecord snapshot (upsert by siteId/ordinal)
 *   event       one Boundary C RunEvent (sequence = 1-based count of event lines)
 *
 * Later lines win, so a reader can rebuild state by replaying top to bottom — which
 * is exactly what a cold recovery does, and why the file is append-only.
 */
export interface WorkflowJournalOptions {
  /** Directory holding `runs/` — normally `<ocrcHome>/workflows`. */
  dir: string
  now?: () => number
}

/**
 * Which tool call started a run.
 *
 * The vendored `RunRecord.toolCallId` is the join key between a run and its tool card,
 * but the id itself (`tool-<partId>`) is minted by the engine *after* the tool call
 * returns — the plugin's `ToolContext` carries only `sessionID` / `messageID`. So the
 * host records the pair it does know, and the panel resolves it against the tool row
 * it already has (that row carries both `toolCallId` and the message id). This lives
 * outside `RunRecord` on purpose: it is ocrc's own bookkeeping, and the vendored
 * record is the engine's shape, not ours to extend.
 */
export interface RunToolJoin {
  /** The parent session's message that contained the tool call. */
  messageId: string
  /** Tool name as the model called it (`CreateWorkflow` / `AmendWorkflow`). */
  toolName: string
}

/**
 * Where an ask's exchange ended in its actor's transcript — host bookkeeping, like
 * `RunToolJoin`, and for the same reason: the vendored `NodeRecord.messageBoundary` is a
 * bare count, while a transcript *copy* also needs to name the unit it stops at.
 *
 * `count` is in our own transcript units (a `StructuredCard` — what `getHistory` returns
 * and what a seeding copy would copy), which is the reading the vendored contract means by
 * a count offset: "copy the first N" survives prefix-copying, an id does not. `messageId`
 * is the id of the last unit inside that prefix, so a backend that can only fork at a
 * message boundary has something exact to fork at.
 *
 * A re-measure appends another line and the last one wins: the value written at a typed
 * ask's accept is *provisional* (the model's wrap-up cards land later), and the turn end
 * supplies the authoritative one — the vendored field is defined over the complete
 * exchange.
 */
export interface AskBoundary {
  siteId: string
  ordinal: number
  /** The actor session this was measured on (the fork source). */
  sessionId?: string
  count: number
  messageId?: string
}

type Line =
  | { k: 'run'; rec: RunRecord }
  | { k: 'run-status'; status: RunStatus; settlement?: RunSettlementRecord }
  | { k: 'run-usage'; spentTokens: number }
  | { k: 'run-caps'; caps: Caps }
  | { k: 'run-script'; scriptText: string; scriptHash: string }
  | { k: 'run-join'; join: RunToolJoin }
  | { k: 'ask-boundary'; boundary: AskBoundary }
  | { k: 'actor'; rec: ActorRecord }
  | { k: 'node'; rec: NodeRecord }
  | { k: 'event'; seq: number; at: number; ev: RunEvent }

interface RunState {
  record?: RunRecord
  join?: RunToolJoin
  boundaries: Map<string, AskBoundary>
  actors: Map<string, ActorRecord>
  nodes: Map<string, NodeRecord>
  events: StoredEvent[]
  /** Set when the run file does not exist yet — nothing to flush on teardown. */
  dirty: boolean
}

const actorKey = (siteId: string, ordinal: number) => `${siteId}#${ordinal}`

/** v3.15.1 读面：`withResult=false` 的行上 `result` 缺席（内存实现以剥字段等价）。 */
function stripNodeResult(node: NodeRecord): NodeRecord {
  const { result: _result, ...rest } = node
  return rest as NodeRecord
}

export interface WorkflowJournal extends JournalStorePort {
  /** Runs known to the store, newest first (the manager's list face). */
  listRuns(): RunRecord[]
  /** All events of a run, oldest first (recovery + the UI event page). */
  allEvents(runId: string): StoredEvent[]
  /** Host metadata: which tool call started this run (the card join key's input). */
  updateRunJoin(runId: string, join: RunToolJoin): void
  getRunJoin(runId: string): RunToolJoin | undefined
  /**
   * Where an ask's exchange ended in its actor's transcript (see {@link AskBoundary}).
   * Upsert by instance: the later measurement of the same ask wins, which is what a
   * re-measure after a repair round means.
   */
  putAskBoundary(runId: string, boundary: AskBoundary): void
  getAskBoundary(runId: string, siteId: string, ordinal: number): AskBoundary | undefined
  listAskBoundaries(runId: string): AskBoundary[]
  /** Path of a run's journal file (diagnostics / artifact co-location). */
  filePath(runId: string): string
  /** Forget a run entirely (only used by tests and `ocrc wf prune`). */
  drop(runId: string): void
}

export function createWorkflowJournal(opts: WorkflowJournalOptions): WorkflowJournal {
  const runsDir = join(opts.dir, 'runs')
  const now = opts.now ?? (() => Date.now())
  const states = new Map<string, RunState>()

  function ensureDir(): void {
    try { mkdirSync(runsDir, { recursive: true }) } catch { /* best effort */ }
  }
  ensureDir()

  function fileFor(runId: string): string {
    // runIds are minted as `dwfrun-<uuid>`; refuse anything that could escape the dir.
    if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error(`workflow journal: unsafe runId "${runId}"`)
    return join(runsDir, `${runId}.jsonl`)
  }

  function emptyState(): RunState {
    return { actors: new Map(), nodes: new Map(), boundaries: new Map(), events: [], dirty: false }
  }

  function applyLine(state: RunState, line: Line): void {
    switch (line.k) {
      case 'run': state.record = line.rec; break
      case 'run-status': {
        if (!state.record) return
        state.record = { ...state.record, status: line.status }
        if (line.settlement) {
          const { stopReason, supersededBy, failure, result } = line.settlement
          state.record = {
            ...state.record,
            ...(stopReason ? { stopReason } : {}),
            ...(supersededBy ? { supersededBy } : {}),
            ...(failure ? { failure } : {}),
            ...(result !== undefined ? { result } : {}),
          }
        }
        break
      }
      case 'run-usage': if (state.record) state.record = { ...state.record, spentTokens: line.spentTokens }; break
      case 'run-caps': if (state.record) state.record = { ...state.record, caps: line.caps }; break
      case 'run-script': if (state.record) state.record = { ...state.record, scriptText: line.scriptText, scriptHash: line.scriptHash }; break
      case 'run-join': state.join = line.join; break
      case 'ask-boundary': state.boundaries.set(actorKey(line.boundary.siteId, line.boundary.ordinal), line.boundary); break
      case 'actor': state.actors.set(actorKey(line.rec.siteId, line.rec.ordinal), line.rec); break
      case 'node': state.nodes.set(actorKey(line.rec.siteId, line.rec.ordinal), line.rec); break
      case 'event': state.events.push({ sequence: line.seq, event: line.ev, timeCreated: line.at }); break
    }
  }

  /** Read a run's file once and replay it into memory. */
  function load(runId: string): RunState {
    const cached = states.get(runId)
    if (cached) return cached
    const state = emptyState()
    const file = fileFor(runId)
    if (existsSync(file)) {
      let text = ''
      try { text = readFileSync(file, 'utf-8') } catch { text = '' }
      for (const raw of text.split('\n')) {
        const line = raw.trim()
        if (!line) continue
        try { applyLine(state, JSON.parse(line) as Line) } catch { /* torn tail line: stop caring, keep what parsed */ }
      }
    }
    states.set(runId, state)
    return state
  }

  function append(runId: string, line: Line): void {
    const state = load(runId)
    applyLine(state, line)
    state.dirty = true
    ensureDir()
    try { appendFileSync(fileFor(runId), JSON.stringify(line) + '\n') } catch { /* keep the in-memory view authoritative */ }
  }

  return {
    createRun(record) {
      append(record.runId, { k: 'run', rec: record })
    },
    getRun(runId) {
      return load(runId).record
    },
    updateRunStatus(runId, status, settlement) {
      const state = load(runId)
      if (!state.record) throw new Error(`workflow journal: unknown run ${runId}`)
      append(runId, { k: 'run-status', status, ...(settlement ? { settlement } : {}) })
    },
    updateRunUsage(runId, spentTokens) {
      const state = load(runId)
      if (!state.record) throw new Error(`workflow journal: unknown run ${runId}`)
      append(runId, { k: 'run-usage', spentTokens })
    },
    updateRunCaps(runId, caps) {
      const state = load(runId)
      if (!state.record) throw new Error(`workflow journal: unknown run ${runId}`)
      append(runId, { k: 'run-caps', caps })
    },
    updateRunScript(runId, scriptText, scriptHash) {
      const state = load(runId)
      if (!state.record) throw new Error(`workflow journal: unknown run ${runId}`)
      append(runId, { k: 'run-script', scriptText, scriptHash })
    },
    updateRunJoin(runId, join) {
      const state = load(runId)
      if (!state.record) throw new Error(`workflow journal: unknown run ${runId}`)
      append(runId, { k: 'run-join', join })
    },
    getRunJoin(runId) {
      return load(runId).join
    },
    putAskBoundary(runId, boundary) {
      append(runId, { k: 'ask-boundary', boundary })
    },
    getAskBoundary(runId, siteId, ordinal) {
      return load(runId).boundaries.get(actorKey(siteId, ordinal))
    },
    listAskBoundaries(runId) {
      return [...load(runId).boundaries.values()]
    },
    putActor(record) {
      append(record.runId, { k: 'actor', rec: record })
    },
    getActor(runId, siteId, ordinal) {
      return load(runId).actors.get(actorKey(siteId, ordinal))
    },
    listActors(runId, opts) {
      const actors = [...load(runId).actors.values()]
      // v3.15.1 读面契约：withPersona=false 时行上 persona 缺席（存储层就不给）。
      return opts.withPersona ? actors : actors.map(({ persona: _p, ...rest }) => rest as ActorRecord)
    },
    putNode(record) {
      append(record.runId, { k: 'node', rec: record })
    },
    getNode(runId, siteId, ordinal, opts) {
      const node = load(runId).nodes.get(actorKey(siteId, ordinal))
      if (node && opts?.withResult === false) return stripNodeResult(node)
      return node
    },
    listNodes(runId, opts) {
      // v3.15.1 读面契约：过滤/计数都在存储层做，读者必须说清要什么（"all" 也要写出来）。
      let nodes = [...load(runId).nodes.values()]
      if (opts.kinds !== 'all') {
        const kinds = new Set<string>(opts.kinds)
        nodes = nodes.filter((n) => kinds.has(n.kind))
      }
      if (!opts.withResult) nodes = nodes.map(stripNodeResult)
      if (opts.maxResultBytes !== undefined) {
        const capped: NodeRecord[] = []
        let bytes = 0
        for (const n of nodes) {
          const size = n.result === undefined ? 0 : Buffer.byteLength(JSON.stringify(n.result), 'utf8')
          if (capped.length > 0 && bytes + size > opts.maxResultBytes) break
          capped.push(n)
          bytes += size
        }
        nodes = capped
      }
      if (opts.limit !== undefined) nodes = nodes.slice(0, opts.limit)
      return nodes
    },
    countNodes(runId, kind) {
      let count = 0
      for (const n of load(runId).nodes.values()) if (n.kind === kind) count += 1
      return count
    },
    sumResultBytes(runId, kind) {
      let total = 0
      for (const n of load(runId).nodes.values()) {
        if (n.kind !== kind || n.result === undefined) continue
        total += Buffer.byteLength(JSON.stringify(n.result), 'utf8')
      }
      return total
    },
    appendEvent(runId, event) {
      const state = load(runId)
      const seq = state.events.length + 1
      const at = now()
      append(runId, { k: 'event', seq, at, ev: event })
      return { sequence: seq, event, timeCreated: at }
    },
    listEvents(runId, options) {
      const { events } = load(runId)
      // report 的「第几条」按本 run 全部 report 事件计（run 的事实，与 types/cursor 无关），
      // 所以先在未过滤序列上编号，再按选项过滤/剥离/分页。
      let reportSeq = 0
      const reportOrdinal = new Map<number, number>()
      for (const e of events) {
        if (e.event.type !== 'report') continue
        reportSeq += 1
        reportOrdinal.set(e.sequence, reportSeq)
      }
      let out = events
      if (options.types !== 'all') {
        const types = new Set<string>(options.types)
        out = out.filter((e) => types.has(e.event.type))
      }
      if (options.reportItems !== 'all') {
        const keep = options.reportItems.limit
        out = out.map((e) => {
          if (e.event.type !== 'report') return e
          const ordinal = reportOrdinal.get(e.sequence) ?? 0
          if (ordinal <= keep) return e
          const { item: _item, ...rest } = e.event as Record<string, unknown> & { item?: unknown }
          return { ...e, event: rest as RunEvent }
        })
      }
      if (options.afterSequence !== undefined) out = out.filter((e) => e.sequence > options.afterSequence!)
      if (options.limit !== undefined) out = out.slice(0, options.limit)
      return out
    },
    allEvents(runId) {
      return load(runId).events
    },
    listRuns() {
      const ids = new Set<string>(states.keys())
      try {
        for (const f of readdirSync(runsDir)) {
          if (f.endsWith('.jsonl')) ids.add(f.slice(0, -'.jsonl'.length))
        }
      } catch { /* dir missing */ }
      const records: RunRecord[] = []
      for (const id of ids) {
        const rec = load(id).record
        if (rec) records.push(rec)
      }
      // Newest first: the run id is time-ordered by construction, but fall back to
      // file mtime so an imported/renamed journal still sorts sensibly.
      return records.sort((a, b) => mtime(b.runId) - mtime(a.runId) || b.runId.localeCompare(a.runId))
    },
    filePath(runId) {
      return fileFor(runId)
    },
    drop(runId) {
      states.delete(runId)
      try { rmSync(fileFor(runId), { force: true }) } catch { /* best effort */ }
    },
  }

  function mtime(runId: string): number {
    try { return statSync(fileFor(runId)).mtimeMs } catch { return 0 }
  }
}
