import type {
  ActorRecord,
  NodeRecord,
  RunEvent,
  RunRecord,
  StoredEvent,
} from '../../../vendor/zcode-dwf/dist/dynamic-workflow/src/index.js'
import type { EscalationRecord } from './escalations.js'

/**
 * P4-1a: the host's projection of a workflow run into the shape the ZCode frontend
 * expects (`workflowRuns[].*` in the v4 conversation snapshot).
 *
 * Why this module exists at all: the vendored engine speaks *events* (Boundary C) and
 * the journal speaks *records*, while the panel speaks one rich `WorkflowRunState`.
 * The upstream CLI produces that state with an incremental reducer fed by live
 * progress payloads; the upstream notes say cold replay is a separate seeding path
 * computed from journal rows. ocrc is a cold-seeding-shaped producer — the journal is
 * the single source of truth and every read recomputes from it — so this projector is
 * the honest counterpart of that seeding path, not a re-implementation of the reducer.
 *
 * Everything here is derived; nothing is invented:
 *   - tables (actors / nodes) come from the journal records, which are upsert-keyed and
 *     therefore already collapse resume replays;
 *   - lifecycle phases come from the node events (`node-queued` … `node-settled`),
 *     exactly the vocabulary the vendored schema documents;
 *   - `phases` / `currentPhase` come from `phase-entered`, `phaseNames` from
 *     `run-launched` (the declared table the compiler produced);
 *   - `reports` / `pendingQuestions` / `artifacts` come from their own events.
 *
 * Bounds are the vendored wire limits, and they are NOT cosmetic: the schema carries
 * `.max()` on every table, and an over-bound payload does not lose a key — it makes the
 * whole frame fail to parse on the client. So we clamp here and set `truncated`.
 *
 * Deliberately absent (the vendored schema marks all of them optional, and absence is
 * documented as "unknown" rather than "zero"): `turn` / `toolCalls` / `lastTool`
 * (they ride `node-progress`, which our driver does not emit — the panel will show
 * "no idea", which is the truth) and `phaseAlongside` (see `phaseAlongsideFor`).
 */

// ── wire bounds (mirror of @zcode/shared WORKFLOW_RUNS_LIMITS) ───────────────
const LIMITS = {
  maxRuns: 8,
  maxActors: 1_024,
  maxNodes: 1_024,
  maxReports: 64,
  maxPendingQuestions: 32,
  maxArtifacts: 32,
  maxPhases: 32,
  maxReportPreviewLength: 2_048,
  maxResultPreviewLength: 2_048,
  maxErrorLength: 2_048,
  maxQuestionLength: 2_048,
  maxActorNameLength: 128,
  maxPhaseNameLength: 128,
  maxInstructionsHeadLength: 240,
} as const

export type NodePhase = 'queued' | 'dispatched' | 'executing' | 'waiting' | 'repairing' | 'nudged' | 'settled'
export type NodeOutcome = 'ok' | 'failed' | 'cancelled'

export interface ProjectedNode {
  siteId: string
  ordinal: number
  kind?: 'ask' | 'world-read'
  phase: NodePhase
  outcome?: NodeOutcome
  cached?: boolean
  actorSiteId?: string
  actorOrdinal?: number
  phaseName?: string
  instructionsHead?: string
}

export interface ProjectedActor {
  siteId: string
  ordinal: number
  name?: string
  sessionId?: string
  status: 'waiting' | 'running' | 'completed'
  phaseName?: string
}

export interface ProjectedReport {
  siteId: string
  ordinal: number
  preview: string
  artifactId?: string
}

export interface ProjectedQuestion {
  qid: string
  actorSiteId?: string
  actorOrdinal?: number
  actorName?: string
  question: string
  context?: string
  askedAt?: number
}

export interface ProjectedArtifact {
  id: string
  kind: 'file' | 'markdown' | 'chart' | 'table' | 'metrics' | 'board'
  title?: string
  version: number
  contentType?: string
  bytes?: number
  itemCount?: number
  primary?: true
}

export interface ProjectedConcurrency {
  key?: string
  cap: number
  ceiling: number
  limit?: number
  cooldownMs?: number
}

export interface ProjectedRun {
  runId: string
  toolCallId?: string
  status: 'pending' | 'running' | 'completed' | 'errored' | 'stopped'
  stopReason?: 'user' | 'model' | 'provider' | 'interrupted' | 'superseded'
  resumedFrom?: string
  supersededBy?: string
  usage: { spentTokens: number; nodesUsed: number }
  error?: string
  /** Only present when true (the vendored "为真才在场" rule). */
  resumable?: true
  resultPreview?: string
  actors: ProjectedActor[]
  nodes: ProjectedNode[]
  reports?: ProjectedReport[]
  pendingQuestions?: ProjectedQuestion[]
  concurrency?: ProjectedConcurrency
  concurrencyCeiling?: number
  subagentModel?: string
  artifacts?: ProjectedArtifact[]
  phases?: Array<{ name: string; rounds: number }>
  currentPhase?: string
  phaseNames?: string[]
  phaseAlongside?: number[][]
  truncated?: boolean
  lastEventSequence: number
}

export interface ProjectedRuns {
  revision: number
  runs: ProjectedRun[]
}

/** The artifact metadata the projection needs (the store's index + journal rows). */
export interface ArtifactFacts {
  id: string
  kind: string
  version: number
  title?: string
  contentType?: string
  bytes?: number
  primary?: boolean
}

export interface ProjectRunInput {
  record: RunRecord
  actors: ActorRecord[]
  nodes: NodeRecord[]
  events: StoredEvent[]
  /** Latest-version metadata per artifact id (content members from the byte store). */
  artifacts?: ArtifactFacts[]
  /** Unanswered escalations (the actor-side `escalate` tool's registry). */
  escalations?: EscalationRecord[]
  /** Host fact the journal does not carry: the process concurrency ceiling. */
  ceiling?: number
}

const NODE_EVENT_PHASE: Record<string, NodePhase> = {
  'node-queued': 'queued',
  'node-dispatched': 'dispatched',
  'node-executing': 'executing',
  'node-waiting': 'waiting',
  'node-repairing': 'repairing',
  'node-nudged': 'nudged',
  'node-settled': 'settled',
}

/** The vendored rule for `report(item)` previews / a run's `result`: string as-is,
 *  everything else pretty JSON, `undefined` (not an empty string) when there is
 *  nothing to show. Mirrors `serializeWorkflowArtifact` in @zcode/shared. */
export function serializePreview(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return value
  try {
    const text = JSON.stringify(value, null, 2)
    return text === undefined ? String(value) : text
  } catch {
    return String(value)
  }
}

function clampText(text: string | undefined, max: number): string | undefined {
  if (text === undefined) return undefined
  return text.length <= max ? text : text.slice(0, max)
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

const instanceKey = (siteId: string, ordinal: number) => `${siteId}#${ordinal}`

/**
 * One run's journal → the vendored run state.
 *
 * Single pass over the events (oldest first) because the events are the only place
 * several of these facts exist at all — the node records carry the outcome, not the
 * lifecycle phase, and the phase table only ever appears as `phase-entered` lines.
 */
export function projectRun(input: ProjectRunInput): ProjectedRun {
  const { record, events } = input
  let truncated = false
  const bump = () => { truncated = true }

  // ── event-derived state ────────────────────────────────────────────────────
  interface NodeFacts {
    phase: NodePhase
    cached?: boolean
    outcome?: NodeOutcome
    phaseName?: string
    instructionsHead?: string
  }
  const nodeFacts = new Map<string, NodeFacts>()
  const reports: ProjectedReport[] = []
  const reportKeys = new Set<string>()
  const reportCountByArtifact = new Map<string, number>()
  const artifactByEventId = new Map<string, ArtifactFacts>()
  const phaseOrder: string[] = []
  const phaseRounds = new Map<string, number>()
  const raised = new Map<string, ProjectedQuestion>()
  const resolvedQids = new Set<string>()
  let currentPhase: string | undefined
  let spentTokens = record.spentTokens
  let subagentModel: string | undefined
  let declaredPhases: string[] | undefined
  let declaredAlongside: number[][] | undefined
  let capsLimit: number | undefined
  let concurrencyCap: number | undefined
  let concurrencyKey: string | undefined

  for (const stored of events) {
    const ev = stored.event as RunEvent
    switch (ev.type) {
      case 'run-started':
        // resume re-emits this: the usage counters start over for the new generation.
        spentTokens = 0
        break
      case 'run-launched':
        declaredPhases = Array.isArray(ev.phaseNames) && ev.phaseNames.length ? ev.phaseNames.slice(0, LIMITS.maxPhases) : undefined
        declaredAlongside = Array.isArray(ev.phaseAlongside) && ev.phaseAlongside.length ? ev.phaseAlongside : undefined
        subagentModel = nonEmpty(ev.subagentModel)
        break
      case 'phase-entered': {
        const name = clampText(nonEmpty(ev.name), LIMITS.maxPhaseNameLength)
        if (!name) break
        if (!phaseRounds.has(name)) {
          if (phaseOrder.length >= LIMITS.maxPhases) { bump(); break }
          phaseOrder.push(name)
          phaseRounds.set(name, 1)
        } else {
          // `ordinal` counts re-entry (a back edge). Monotonic max, like the reducer:
          // a resume replays the prefix and must not double the count.
          phaseRounds.set(name, Math.max(phaseRounds.get(name)!, ev.ordinal))
        }
        currentPhase = name
        break
      }
      case 'node-queued':
      case 'node-dispatched':
      case 'node-executing':
      case 'node-waiting':
      case 'node-repairing':
      case 'node-nudged':
      case 'node-settled': {
        const key = instanceKey(ev.instance.siteId, ev.instance.ordinal)
        const prev = nodeFacts.get(key)
        // The event's phase wins over the carried one (spread order matters here: a
        // late `...prev` would silently freeze the phase at the birth event).
        const facts: NodeFacts = { ...prev, phase: NODE_EVENT_PHASE[ev.type]! }
        // Birth stamps only ever arrive on birth events; carry the previous one.
        const born = (ev as { phaseName?: string }).phaseName
        if (nonEmpty(born)) facts.phaseName = clampText(born, LIMITS.maxPhaseNameLength)
        const head = (ev as { instructionsHead?: string }).instructionsHead
        if (nonEmpty(head)) facts.instructionsHead = clampText(head, LIMITS.maxInstructionsHeadLength)
        if (ev.type === 'node-settled') {
          facts.outcome = ev.outcome
          if (ev.cached) facts.cached = true
        }
        nodeFacts.set(key, facts)
        break
      }
      case 'report': {
        const key = instanceKey(ev.instance.siteId, ev.instance.ordinal)
        if (reportKeys.has(key)) break // replay may re-deliver; one row per instance
        const preview = clampText(serializePreview(ev.item), LIMITS.maxReportPreviewLength)
        if (preview === undefined) break
        if (reports.length >= LIMITS.maxReports) { bump(); break }
        reportKeys.add(key)
        const artifactId = nonEmpty(ev.artifactId)
        reports.push({
          siteId: ev.instance.siteId,
          ordinal: ev.instance.ordinal,
          preview,
          ...(artifactId ? { artifactId } : {}),
        })
        if (artifactId) reportCountByArtifact.set(artifactId, (reportCountByArtifact.get(artifactId) ?? 0) + 1)
        break
      }
      case 'artifact-published': {
        const a = ev.artifact
        artifactByEventId.set(a.id, {
          id: a.id,
          kind: a.kind,
          version: a.version,
          ...(nonEmpty(a.title) ? { title: a.title } : {}),
          ...(nonEmpty(a.contentType) ? { contentType: a.contentType } : {}),
          ...(typeof a.bytes === 'number' ? { bytes: a.bytes } : {}),
          ...(a.primary ? { primary: true } : {}),
        })
        break
      }
      case 'escalation-raised': {
        const qid = nonEmpty(ev.qid)
        if (!qid) break
        raised.set(qid, {
          qid,
          actorSiteId: ev.actor?.siteId,
          actorOrdinal: ev.actor?.ordinal,
          ...(nonEmpty(ev.actorName) ? { actorName: clampText(ev.actorName, LIMITS.maxActorNameLength) } : {}),
          question: clampText(ev.question, LIMITS.maxQuestionLength) ?? '',
          ...(nonEmpty(ev.context) ? { context: clampText(ev.context, LIMITS.maxQuestionLength) } : {}),
          askedAt: ev.askedAt,
        })
        break
      }
      case 'escalation-resolved':
        resolvedQids.add(ev.qid)
        break
      case 'usage-updated':
        spentTokens = ev.spentTokens
        break
      case 'run-caps-changed':
        capsLimit = ev.caps.maxConcurrency
        break
      case 'concurrency-changed': {
        concurrencyCap = ev.next
        if (nonEmpty(ev.key)) concurrencyKey = ev.key
        break
      }
      default:
        break
    }
  }

  // ── tables from the journal records ────────────────────────────────────────
  const actorRows = input.actors
    .map((a) => ({
      siteId: a.siteId,
      ordinal: a.ordinal,
      ...(nonEmpty(a.name) ? { name: clampText(a.name, LIMITS.maxActorNameLength) } : {}),
      ...(nonEmpty(a.sessionId) ? { sessionId: a.sessionId } : {}),
    }))
    .sort((a, b) => a.ordinal - b.ordinal || a.siteId.localeCompare(b.siteId))
  if (actorRows.length > LIMITS.maxActors) bump()

  const nodeRows = input.nodes
    .filter((n) => n.kind === 'ask' || n.kind === 'world-read' || n.kind === 'world-run')
    .map((n) => ({ rec: n, key: instanceKey(n.siteId, n.ordinal) }))
    .sort((a, b) => a.rec.ordinal - b.rec.ordinal || a.rec.siteId.localeCompare(b.rec.siteId))
  if (nodeRows.length > LIMITS.maxNodes) bump()

  const terminal = record.status === 'completed' || record.status === 'errored' || record.status === 'stopped'

  const nodes: ProjectedNode[] = nodeRows.slice(0, LIMITS.maxNodes).map(({ rec, key }) => {
    const facts = nodeFacts.get(key)
    // The record is the outcome authority; the events are the phase authority. A node
    // whose row says settled but whose last event is `executing` can only happen if a
    // line was lost, and the row wins.
    const settled = rec.status !== 'running'
    const phase: NodePhase = settled ? 'settled' : facts?.phase ?? 'queued'
    const outcome: NodeOutcome | undefined = settled
      ? (facts?.outcome ?? (rec.status === 'failed' ? 'failed' : 'ok'))
      : facts?.outcome
    return {
      siteId: rec.siteId,
      ordinal: rec.ordinal,
      ...(rec.kind === 'ask' ? { kind: 'ask' as const } : { kind: 'world-read' as const }),
      phase,
      ...(outcome ? { outcome } : {}),
      ...(facts?.cached ? { cached: true } : {}),
      ...(rec.actorSiteId !== undefined ? { actorSiteId: rec.actorSiteId } : {}),
      ...(rec.actorOrdinal !== undefined ? { actorOrdinal: rec.actorOrdinal } : {}),
      ...(facts?.phaseName ? { phaseName: facts.phaseName } : {}),
      ...(facts?.instructionsHead ? { instructionsHead: facts.instructionsHead } : {}),
    }
  })

  // Actor status is derived, never observed — the engine emits no actor lifecycle
  // events beyond `actor-created` (see the vendored actor-status rule).
  const nodesByActor = new Map<string, ProjectedNode[]>()
  for (const n of nodes) {
    if (n.actorSiteId === undefined || n.actorOrdinal === undefined) continue
    const key = instanceKey(n.actorSiteId, n.actorOrdinal)
    const list = nodesByActor.get(key) ?? []
    list.push(n)
    nodesByActor.set(key, list)
  }
  const ACTIVE: NodePhase[] = ['executing', 'repairing', 'nudged']
  const LIVE: NodePhase[] = ['queued', 'dispatched', 'waiting']

  const actors: ProjectedActor[] = actorRows.slice(0, LIMITS.maxActors).map((a) => {
    const own = nodesByActor.get(instanceKey(a.siteId, a.ordinal)) ?? []
    const status: ProjectedActor['status'] = own.some((n) => ACTIVE.includes(n.phase))
      ? 'running'
      : own.some((n) => LIVE.includes(n.phase)) || (own.length === 0 && !terminal)
        ? 'waiting'
        : 'completed'
    // Birth phase of the actor: the first node stamped in it, or the actor's own stamp.
    const phaseName = own.find((n) => n.phaseName)?.phaseName
    return { ...a, status, ...(phaseName ? { phaseName } : {}) }
  })

  // ── artifacts: event rows (presets + content) merged with the byte store ───
  const artifactMap = new Map<string, ProjectedArtifact>()
  const kindOf = (kind: string): ProjectedArtifact['kind'] | undefined =>
    kind === 'file' || kind === 'markdown' || kind === 'chart' || kind === 'table' || kind === 'metrics' || kind === 'board'
      ? kind
      : undefined
  for (const a of [...artifactByEventId.values(), ...(input.artifacts ?? [])]) {
    const kind = kindOf(a.kind)
    if (!kind) continue
    const prev = artifactMap.get(a.id)
    // Highest version wins; the byte store fills in what the events may not carry.
    if (prev && prev.version > a.version) continue
    const merged: ProjectedArtifact = {
      id: a.id,
      kind,
      version: a.version,
      ...(a.title ? { title: a.title } : prev?.title ? { title: prev.title } : {}),
      ...(a.contentType ? { contentType: a.contentType } : prev?.contentType ? { contentType: prev.contentType } : {}),
      ...(typeof a.bytes === 'number' ? { bytes: a.bytes } : prev?.bytes !== undefined ? { bytes: prev.bytes } : {}),
      ...((a.primary || prev?.primary) ? { primary: true as const } : {}),
    }
    const itemCount = reportCountByArtifact.get(a.id)
    if (itemCount) merged.itemCount = itemCount
    artifactMap.set(a.id, merged)
  }
  const artifactList = [...artifactMap.values()].sort((a, b) => a.id.localeCompare(b.id))
  if (artifactList.length > LIMITS.maxArtifacts) bump()

  // ── pending questions: engine events ∪ the actor-side registry ─────────────
  const questions: ProjectedQuestion[] = []
  for (const q of raised.values()) if (!resolvedQids.has(q.qid)) questions.push(q)
  for (const e of input.escalations ?? []) {
    if (e.answer !== undefined) continue
    if (questions.some((q) => q.question === e.question)) continue
    const actor = actorRows.find((a) => a.sessionId && a.sessionId === e.sessionId)
    questions.push({
      qid: e.qid,
      ...(actor ? { actorSiteId: actor.siteId, actorOrdinal: actor.ordinal } : {}),
      ...(actor?.name ? { actorName: actor.name } : {}),
      question: clampText(e.question, LIMITS.maxQuestionLength) ?? '',
      ...(e.context ? { context: clampText(e.context, LIMITS.maxQuestionLength) } : {}),
      askedAt: e.askedAt,
    })
  }
  if (questions.length > LIMITS.maxPendingQuestions) bump()

  // ── assembly ───────────────────────────────────────────────────────────────
  const run: ProjectedRun = {
    runId: record.runId,
    ...(nonEmpty(record.toolCallId) ? { toolCallId: record.toolCallId } : {}),
    status: record.status,
    ...(record.stopReason ? { stopReason: record.stopReason } : {}),
    ...(nonEmpty(record.resumedFrom) ? { resumedFrom: record.resumedFrom } : {}),
    ...(nonEmpty(record.supersededBy) ? { supersededBy: record.supersededBy } : {}),
    usage: { spentTokens, nodesUsed: nodes.length },
    ...(record.failure ? { error: clampText(failureText(record.failure), LIMITS.maxErrorLength) } : {}),
    ...(resumableOf(record) ? { resumable: true as const } : {}),
    ...(resultPreviewOf(record)),
    actors,
    nodes,
    ...(reports.length ? { reports: reports.slice(0, LIMITS.maxReports) } : {}),
    ...(questions.length ? { pendingQuestions: questions.slice(0, LIMITS.maxPendingQuestions) } : {}),
    ...(concurrencyOf(record, input.ceiling, capsLimit, concurrencyCap, concurrencyKey)),
    ...(input.ceiling !== undefined ? { concurrencyCeiling: input.ceiling } : {}),
    ...(subagentModel ? { subagentModel } : {}),
    ...(artifactList.length ? { artifacts: artifactList.slice(0, LIMITS.maxArtifacts) } : {}),
    ...(phaseOrder.length
      ? { phases: phaseOrder.map((name) => ({ name, rounds: phaseRounds.get(name) ?? 1 })) }
      : {}),
    ...(currentPhase ? { currentPhase } : {}),
    ...(declaredPhases ? { phaseNames: declaredPhases } : {}),
    ...(declaredPhases && declaredAlongside ? { phaseAlongside: declaredAlongside } : {}),
    ...(truncated ? { truncated: true } : {}),
    lastEventSequence: events.length,
  }
  return run
}

/** A run's `resumable` is the CLI's own resume predicate, not a UI guess — and the
 *  vendored contract says a superseded run is NOT resumable (its successor is alive). */
function resumableOf(record: RunRecord): boolean {
  return record.status === 'stopped' && record.stopReason !== 'superseded'
}

function resultPreviewOf(record: RunRecord): { resultPreview?: string } {
  const text = clampText(serializePreview(record.result), LIMITS.maxResultPreviewLength)
  return text === undefined ? {} : { resultPreview: text }
}

function failureText(failure: RunRecord['failure']): string {
  if (!failure) return 'run failed'
  const message = typeof (failure as { message?: unknown }).message === 'string'
    ? (failure as { message: string }).message
    : undefined
  const code = typeof (failure as { code?: unknown }).code === 'string' ? (failure as { code: string }).code : undefined
  return message ? (code ? `${code}: ${message}` : message) : (code ?? 'run failed')
}

/** Present only when one of the two bounds sits below the ceiling — the vendored rule:
 *  a run that has never been throttled and was never given a limit has nothing to say. */
function concurrencyOf(
  record: RunRecord,
  ceiling: number | undefined,
  capsLimit: number | undefined,
  concurrencyCap: number | undefined,
  key: string | undefined,
): { concurrency?: ProjectedConcurrency } {
  const limit = capsLimit ?? record.caps?.maxConcurrency
  const cap = concurrencyCap ?? limit
  if (ceiling === undefined || cap === undefined) return {}
  const lowerLimit = limit !== undefined && limit < ceiling ? limit : undefined
  const throttled = concurrencyCap !== undefined && concurrencyCap < ceiling
  if (lowerLimit === undefined && !throttled) return {}
  return {
    concurrency: {
      ...(key ? { key } : {}),
      cap,
      ceiling,
      ...(lowerLimit !== undefined ? { limit: lowerLimit } : {}),
    },
  }
}

/** The container: bounded to the vendored `maxRuns`. The container `revision` is the
 *  consumer's to own — the panel is the one coalescing deltas, and it holds the prior
 *  state the revision is relative to. */
export function projectRuns(inputs: ProjectRunInput[]): ProjectedRun[] {
  return inputs.map((i) => projectRun(i)).slice(0, LIMITS.maxRuns)
}

export const WORKFLOW_PROJECTION_LIMITS = LIMITS
