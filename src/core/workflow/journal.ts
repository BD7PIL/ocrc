import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ActorRecord,
  Caps,
  JournalStorePort,
  ListEventsOptions,
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
 *   run-join    {join} — host-only metadata: which tool call started this run
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

type Line =
  | { k: 'run'; rec: RunRecord }
  | { k: 'run-status'; status: RunStatus; settlement?: RunSettlementRecord }
  | { k: 'run-usage'; spentTokens: number }
  | { k: 'run-caps'; caps: Caps }
  | { k: 'run-join'; join: RunToolJoin }
  | { k: 'actor'; rec: ActorRecord }
  | { k: 'node'; rec: NodeRecord }
  | { k: 'event'; seq: number; at: number; ev: RunEvent }

interface RunState {
  record?: RunRecord
  join?: RunToolJoin
  actors: Map<string, ActorRecord>
  nodes: Map<string, NodeRecord>
  events: StoredEvent[]
  /** Set when the run file does not exist yet — nothing to flush on teardown. */
  dirty: boolean
}

const actorKey = (siteId: string, ordinal: number) => `${siteId}#${ordinal}`

export interface WorkflowJournal extends JournalStorePort {
  /** Runs known to the store, newest first (the manager's list face). */
  listRuns(): RunRecord[]
  /** All events of a run, oldest first (recovery + the UI event page). */
  allEvents(runId: string): StoredEvent[]
  /** Host metadata: which tool call started this run (the card join key's input). */
  updateRunJoin(runId: string, join: RunToolJoin): void
  getRunJoin(runId: string): RunToolJoin | undefined
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
    return { actors: new Map(), nodes: new Map(), events: [], dirty: false }
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
      case 'run-join': state.join = line.join; break
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
    updateRunJoin(runId, join) {
      const state = load(runId)
      if (!state.record) throw new Error(`workflow journal: unknown run ${runId}`)
      append(runId, { k: 'run-join', join })
    },
    getRunJoin(runId) {
      return load(runId).join
    },
    putActor(record) {
      append(record.runId, { k: 'actor', rec: record })
    },
    getActor(runId, siteId, ordinal) {
      return load(runId).actors.get(actorKey(siteId, ordinal))
    },
    listActors(runId) {
      return [...load(runId).actors.values()]
    },
    putNode(record) {
      append(record.runId, { k: 'node', rec: record })
    },
    getNode(runId, siteId, ordinal) {
      return load(runId).nodes.get(actorKey(siteId, ordinal))
    },
    listNodes(runId) {
      return [...load(runId).nodes.values()]
    },
    appendEvent(runId, event) {
      const state = load(runId)
      const seq = state.events.length + 1
      const at = now()
      append(runId, { k: 'event', seq, at, ev: event })
      return { sequence: seq, event, timeCreated: at }
    },
    listEvents(runId, options?: ListEventsOptions) {
      const { events } = load(runId)
      const after = options?.afterSequence
      let out = after === undefined ? events : events.filter((e) => e.sequence > after)
      if (options?.limit !== undefined) out = out.slice(0, options.limit)
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
