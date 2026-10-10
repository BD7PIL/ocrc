import type {
  ActorRecord,
  NodeRecord,
  RunEvent,
  RunRecord,
  StoredEvent,
} from '../../../vendor/zcode-dwf/dist/dynamic-workflow/src/index.js'
import type { ArtifactStore } from './artifacts.js'
import { serializePreview } from './projection.js'

/**
 * P4-2: the seven read faces the panel's run pages use.
 *
 * These are *queries* in the vendored protocol (read-only, stateless, safe to re-send)
 * and every one of them is answered from the journal — the same single source the
 * projection reads. Nothing here caches: a page that asks twice gets the same answer,
 * and a page that asks after a restart gets the answer that survived.
 *
 * The shapes are the vendored wire shapes verbatim (see @zcode/shared
 * zcode-protocol-v4/{workflow-workspace,workflow-artifacts,transport}.ts), because the
 * renderer validates them: a missing required key is not "one field less", it is a page
 * that fails to load.
 */

// ── shared bounds (mirrors of the vendored limits) ──────────────────────────
const WORKSPACE_LIMITS = { maxNodes: 2_000, resultMaxBytes: 32 * 1024, maxArgs: 16, maxOpLength: 32, maxErrorMessageLength: 2_000 }
const ARTIFACT_LIMITS = { maxIdLength: 64, maxTitleLength: 120, maxDescriptionLength: 500, maxVersions: 16, maxItemsPerPage: 500, defaultItemsPerPage: 200 }
const RUNS_LIMIT_MAX = 64
const EVENT_PAYLOAD_MAX_BYTES = 8 * 1024

const nonEmpty = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)

function clampText(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max)
}

/** Byte length without pulling in Buffer for a length-only question. */
function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf-8')
}

// ── ① workflowRunEvents ─────────────────────────────────────────────────────

export interface RunEventView {
  sequence: number
  type: string
  payload: Record<string, unknown>
  truncated?: boolean
}

/**
 * One journal page. `payload` is the event minus its `type` — the vendored reader
 * interprets by kind, and the vendored contract only asks that the payload be bounded
 * (it is: the engine's own event fields are bounded, and we clamp the serialized form
 * anyway, saying so with `truncated` rather than silently dropping the event).
 */
export function projectRunEvents(page: StoredEvent[]): RunEventView[] {
  return page.map((stored) => {
    const { type, ...payload } = stored.event as RunEvent & { type: string }
    const bounded = boundPayload(payload)
    return {
      sequence: stored.sequence,
      type,
      payload: bounded.payload,
      ...(bounded.truncated ? { truncated: true } : {}),
    }
  })
}

/** Bounded, shape-preserving: oversized strings are cut, oversized containers are
 *  trimmed, and the caller is told. The audit face must never refuse to show a row. */
function boundPayload(payload: Record<string, unknown>): { payload: Record<string, unknown>; truncated: boolean } {
  let truncated = false
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload)) {
    const text = JSON.stringify(value)
    if (text !== undefined && utf8Bytes(text) > EVENT_PAYLOAD_MAX_BYTES) {
      truncated = true
      out[key] = typeof value === 'string' ? clampText(value, EVENT_PAYLOAD_MAX_BYTES) : { truncated: true, preview: clampText(text, EVENT_PAYLOAD_MAX_BYTES) }
      continue
    }
    out[key] = value
  }
  return { payload: out, truncated }
}

// ── ② workflowRuns (the enumeration face) ───────────────────────────────────

export interface RunSummaryView {
  runId: string
  toolCallId?: string
  label?: string
  updatedAt?: number
  status: RunRecord['status']
  stopReason?: RunRecord['stopReason']
  resumedFrom?: string
  supersededBy?: string
  failureCode?: string
  failureMessage?: string
  resumable: boolean
}

/** The run's display label, derived on read: name → script first line → runId. */
export function runLabel(record: RunRecord): string {
  if (nonEmpty(record.name)) return clampText(record.name!.trim(), 160)
  const firstLine = record.scriptText?.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('//'))
  return clampText(firstLine ?? record.runId, 160)
}

/** The CLI's own resume predicate — the summary and the button must not disagree. */
export function isResumable(record: RunRecord): boolean {
  return record.status === 'stopped' && record.stopReason !== 'superseded'
}

export function projectRunSummary(record: RunRecord, opts: { updatedAt?: number } = {}): RunSummaryView {
  const failure = record.failure as { code?: unknown; message?: unknown } | undefined
  const code = nonEmpty(failure?.code)
  const message = nonEmpty(failure?.message)
  return {
    runId: record.runId,
    ...(nonEmpty(record.toolCallId) ? { toolCallId: record.toolCallId } : {}),
    label: runLabel(record),
    ...(opts.updatedAt !== undefined ? { updatedAt: opts.updatedAt } : {}),
    status: record.status,
    ...(record.stopReason ? { stopReason: record.stopReason } : {}),
    ...(nonEmpty(record.resumedFrom) ? { resumedFrom: record.resumedFrom } : {}),
    ...(nonEmpty(record.supersededBy) ? { supersededBy: record.supersededBy } : {}),
    ...(code ? { failureCode: clampText(code, 64) } : {}),
    ...(message ? { failureMessage: clampText(message, 2048) } : {}),
    resumable: isResumable(record),
  }
}

export function clampRunsLimit(limit: number | undefined): number {
  if (limit === undefined) return RUNS_LIMIT_MAX
  return Math.max(1, Math.min(Math.floor(limit), RUNS_LIMIT_MAX))
}

// ── ③④⑤ artifacts ─────────────────────────────────────────────────────────

export interface ArtifactVersionView {
  version: number
  title?: string
  description?: string
  contentType?: string
  bytes?: number
  uri?: string
  sourcePath?: string
  spec?: unknown
  publishedAt: number
  primary?: true
}

export interface ArtifactDetailView {
  id: string
  kind: string
  title?: string
  description?: string
  contentType?: string
  sourcePath?: string
  spec?: unknown
  version: number
  versions: ArtifactVersionView[]
  itemCount: number
  primary?: true
}

/** Journal `artifact-published` rows → the full artifact metadata (every version). */
export function projectArtifacts(events: StoredEvent[], now = 0): ArtifactDetailView[] {
  const byId = new Map<string, ArtifactVersionView[]>()
  const tagged = new Map<string, number>()
  for (const stored of events) {
    const ev = stored.event
    if (ev.type === 'artifact-published') {
      const a = ev.artifact
      const list = byId.get(a.id) ?? []
      list.push({
        version: a.version,
        ...(nonEmpty(a.title) ? { title: clampText(a.title!, ARTIFACT_LIMITS.maxTitleLength) } : {}),
        ...(nonEmpty(a.description) ? { description: clampText(a.description!, ARTIFACT_LIMITS.maxDescriptionLength) } : {}),
        ...(nonEmpty(a.contentType) ? { contentType: a.contentType! } : {}),
        ...(typeof a.bytes === 'number' ? { bytes: a.bytes } : {}),
        ...(nonEmpty(a.uri) ? { uri: a.uri! } : {}),
        ...(nonEmpty(a.sourcePath) ? { sourcePath: a.sourcePath! } : {}),
        ...(a.spec !== undefined ? { spec: a.spec } : {}),
        publishedAt: typeof a.publishedAt === 'number' ? a.publishedAt : now,
        ...(a.primary ? { primary: true as const } : {}),
      })
      byId.set(a.id, list)
    } else if (ev.type === 'report' && nonEmpty(ev.artifactId)) {
      tagged.set(ev.artifactId!, (tagged.get(ev.artifactId!) ?? 0) + 1)
    }
  }
  const out: ArtifactDetailView[] = []
  for (const [id, versions] of byId) {
    versions.sort((a, b) => a.version - b.version)
    const latest = versions[versions.length - 1]!
    const primary = versions.some((v) => v.primary)
    out.push({
      id,
      // The journal only carries content kinds + preset kinds; anything else is a
      // wiring error and the strict schema would reject the whole page, so it is
      // filtered by the caller (kindOf) rather than guessed here.
      kind: kindOfArtifact(events, id) ?? 'file',
      ...(latest.title ? { title: latest.title } : {}),
      ...(latest.description ? { description: latest.description } : {}),
      ...(latest.contentType ? { contentType: latest.contentType } : {}),
      ...(latest.sourcePath ? { sourcePath: latest.sourcePath } : {}),
      ...(latest.spec !== undefined ? { spec: latest.spec } : {}),
      version: latest.version,
      versions: versions.slice(-ARTIFACT_LIMITS.maxVersions),
      itemCount: tagged.get(id) ?? 0,
      ...(primary ? { primary: true as const } : {}),
    })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

const ARTIFACT_KINDS = new Set(['file', 'markdown', 'chart', 'table', 'metrics', 'board'])
function kindOfArtifact(events: StoredEvent[], id: string): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!.event
    if (ev.type === 'artifact-published' && ev.artifact.id === id && ARTIFACT_KINDS.has(ev.artifact.kind)) return ev.artifact.kind
  }
  return undefined
}

export interface ArtifactItemView {
  sequence: number
  siteId: string
  ordinal: number
  item: unknown
}

/** The board's data face: every tagged `report` row for one artifact id, cursor =
 *  journal sequence (strictly greater than `afterSequence`, same as the event log). */
export function projectArtifactItems(events: StoredEvent[], artifactId: string, opts: { afterSequence?: number; limit?: number }): { items: ArtifactItemView[]; hasMore: boolean } {
  const limit = Math.max(1, Math.min(opts.limit ?? ARTIFACT_LIMITS.defaultItemsPerPage, ARTIFACT_LIMITS.maxItemsPerPage))
  const items: ArtifactItemView[] = []
  let hasMore = false
  for (const stored of events) {
    if (opts.afterSequence !== undefined && stored.sequence <= opts.afterSequence) continue
    const ev = stored.event
    if (ev.type !== 'report' || ev.artifactId !== artifactId) continue
    if (items.length === limit) { hasMore = true; break }
    items.push({ sequence: stored.sequence, siteId: ev.instance.siteId, ordinal: ev.instance.ordinal, item: ev.item })
  }
  return { items, hasMore }
}

export interface ArtifactChunkView {
  dataBase64: string
  mediaType: string
  totalBytes: number
  nextOffset: number | null
}

/** One byte block of a content artifact. The ids never become paths: the store
 *  resolves them against its own index and refuses anything outside it. */
export function readArtifactChunk(
  store: ArtifactStore,
  runId: string,
  artifactId: string,
  version: number,
  offset: number,
  limit: number,
): ArtifactChunkView | undefined {
  // The store refuses an unsafe id by throwing (`DriverError`) — for a read face that is
  // the same answer as "no such artifact": 404, never a 500 and never an oracle that
  // tells the caller which of the two it was.
  let found: ReturnType<ArtifactStore['readVersion']>
  try { found = store.readVersion(runId, artifactId, version) } catch { return undefined }
  if (!found) return undefined
  const start = Math.max(0, Math.min(offset, found.bytes.byteLength))
  const end = Math.min(found.bytes.byteLength, start + Math.max(1, limit))
  const slice = found.bytes.subarray(start, end)
  return {
    dataBase64: slice.toString('base64'),
    mediaType: found.contentType,
    totalBytes: found.bytes.byteLength,
    nextOffset: end < found.bytes.byteLength ? end : null,
  }
}

// ── ⑥ workspace transcript ─────────────────────────────────────────────────

export interface WorkspaceNodeView {
  siteId: string
  ordinal: number
  kind: 'world-read' | 'world-run'
  op?: string
  args?: unknown[]
  inputTruncated?: true
  status: 'running' | 'completed' | 'failed'
  error?: { code: string; message: string }
  summary?: { resultBytes: number; resultCount?: number; exitCode?: number; stdoutBytes?: number; stderrBytes?: number }
  createdAt: number
  updatedAt: number
}

/**
 * The run's world calls as a transcript.
 *
 * `createdAt` / `updatedAt` come from the journal *events* (the node table itself has no
 * timestamps): the first `node-*` event for the instance is the row's creation, the last
 * one its update. A node with no events at all reports the run's own creation time —
 * "we do not know when" is not something this schema can say, and 0 would read as 1970.
 */
export function projectWorkspace(nodes: NodeRecord[], events: StoredEvent[], runCreatedAt: number): { nodes: WorkspaceNodeView[]; truncated?: true } {
  const stamps = new Map<string, { created: number; updated: number }>()
  for (const stored of events) {
    const ev = stored.event
    if (!ev.type.startsWith('node-')) continue
    const instance = (ev as { instance?: { siteId?: string; ordinal?: number } }).instance
    if (!instance?.siteId || instance.ordinal === undefined) continue
    const key = `${instance.siteId}#${instance.ordinal}`
    const at = stored.timeCreated ?? runCreatedAt
    const prev = stamps.get(key)
    stamps.set(key, { created: prev?.created ?? at, updated: at })
  }
  const rows = nodes
    .filter((n) => n.kind === 'world-read' || n.kind === 'world-run')
    .sort((a, b) => a.ordinal - b.ordinal || a.siteId.localeCompare(b.siteId))
  const truncated = rows.length > WORKSPACE_LIMITS.maxNodes
  const out: WorkspaceNodeView[] = rows.slice(0, WORKSPACE_LIMITS.maxNodes).map((n) => {
    const stamp = stamps.get(`${n.siteId}#${n.ordinal}`) ?? { created: runCreatedAt, updated: runCreatedAt }
    const input = n.input as { op?: unknown; args?: unknown[] } | undefined
    const op = nonEmpty(input?.op)
    const summary = summarizeResult(n)
    return {
      siteId: n.siteId,
      ordinal: n.ordinal,
      kind: n.kind === 'world-run' ? 'world-run' : 'world-read',
      ...(op ? { op: clampText(op!, WORKSPACE_LIMITS.maxOpLength) } : {}),
      ...(Array.isArray(input?.args) ? { args: input!.args!.slice(0, WORKSPACE_LIMITS.maxArgs) } : {}),
      status: n.status,
      ...(n.error ? { error: { code: clampText(String((n.error as { code?: unknown }).code ?? 'DriverError'), 64), message: clampText(String((n.error as { message?: unknown }).message ?? ''), WORKSPACE_LIMITS.maxErrorMessageLength) } } : {}),
      ...(summary ? { summary } : {}),
      createdAt: stamp.created,
      updatedAt: stamp.updated,
    }
  })
  return { nodes: out, ...(truncated ? { truncated: true as const } : {}) }
}

function summarizeResult(n: NodeRecord): WorkspaceNodeView['summary'] | undefined {
  if (n.result === undefined) return undefined
  const text = serializePreview(n.result) ?? ''
  const bytes = utf8Bytes(text)
  const summary: NonNullable<WorkspaceNodeView['summary']> = { resultBytes: bytes }
  if (Array.isArray(n.result)) summary.resultCount = n.result.length
  const record = n.result as { exitCode?: unknown; stdout?: unknown; stderr?: unknown }
  if (typeof record?.exitCode === 'number') summary.exitCode = record.exitCode
  if (typeof record?.stdout === 'string') summary.stdoutBytes = utf8Bytes(record.stdout)
  if (typeof record?.stderr === 'string') summary.stderrBytes = utf8Bytes(record.stderr)
  return summary
}

// ── ⑦ node result ─────────────────────────────────────────────────────────

export interface NodeResultView {
  status: NodeRecord['status']
  result?: unknown
  error?: { code: string; message: string }
  truncated: boolean
  totalBytes: number
}

/**
 * One node's body, bounded *shape-preservingly*: strings are cut, arrays are trimmed,
 * and the caller is told both that it was truncated and how big it was. A card wants
 * "what ran, and the first few hundred lines", not all-or-nothing.
 */
export function projectNodeResult(node: NodeRecord, maxBytes = WORKSPACE_LIMITS.resultMaxBytes): NodeResultView {
  const text = node.result === undefined ? undefined : (serializePreview(node.result) ?? '')
  const totalBytes = text === undefined ? 0 : utf8Bytes(text)
  const error = node.error
    ? {
        code: clampText(String((node.error as { code?: unknown }).code ?? 'DriverError'), 64),
        message: clampText(String((node.error as { message?: unknown }).message ?? ''), WORKSPACE_LIMITS.maxErrorMessageLength),
      }
    : undefined
  if (text === undefined) {
    return { status: node.status, ...(error ? { error } : {}), truncated: false, totalBytes: 0 }
  }
  if (totalBytes <= maxBytes) {
    return { status: node.status, result: node.result, ...(error ? { error } : {}), truncated: false, totalBytes }
  }
  return {
    status: node.status,
    result: boundValue(node.result, maxBytes),
    ...(error ? { error } : {}),
    truncated: true,
    totalBytes,
  }
}

/** Shape-preserving bound: arrays keep a prefix, strings keep a prefix, objects keep
 *  their keys (so a card's field access still finds them). */
function boundValue(value: unknown, budget: number): unknown {
  if (typeof value === 'string') return clampText(value, budget)
  if (Array.isArray(value)) {
    const out: unknown[] = []
    let used = 0
    for (const item of value) {
      const text = JSON.stringify(item) ?? ''
      const bytes = utf8Bytes(text)
      if (used + bytes > budget) break
      used += bytes
      out.push(item)
    }
    return out
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    const keys = Object.keys(record)
    const perKey = Math.max(64, Math.floor(budget / Math.max(1, keys.length)))
    for (const key of keys) out[key] = boundValue(record[key], perKey)
    return out
  }
  return value
}

export const WORKFLOW_QUERY_LIMITS = { WORKSPACE_LIMITS, ARTIFACT_LIMITS, RUNS_LIMIT_MAX, EVENT_PAYLOAD_MAX_BYTES }
