import type {
  ActorRecord,
  ImportedActorCandidate,
  ImportedAskEntry,
  ImportedRunCache,
  ImportedWorldEntry,
  NodeRecord,
  RunRecord,
} from '../../../vendor/zcode-dwf/dist/dynamic-workflow/src/index.js'
import type { WorkflowJournal } from './journal.js'

/**
 * P4b: the amend-resume import cache, built from a predecessor's journal.
 *
 * Amend is a **supersede**: the new run gets a new id and the predecessor's rows are
 * untouched, so the only link between them is the `resumedFrom` pointer. The cache is what
 * makes the revision cheap — it lets the engine settle a predecessor's finished ask from
 * the record instead of paying for the same model turn again. It is *not* a source of
 * truth: every hit still writes a real node row, and losing the cache only costs tokens.
 *
 * Upstream builds this in its run service (it is host code, not engine code); this is the
 * same projection from the same journal facts. Two deliberate, documented degradations:
 *
 *  1. **Results-level reuse only.** The vendored cache can also seed a diverging actor's
 *     *session* with the predecessor's transcript prefix (`ActorSessionSeed` +
 *     `NodeRecord.messageBoundary`). Our transcript store is card-based and our driver
 *     does not copy a transcript into a fresh session, so a diverging actor starts with an
 *     empty session and no predecessor context. What survives is the expensive half: a
 *     completed ask is not re-run.
 *  2. **No in-flight entry.** Upstream can hand over the half-finished transcript of an ask
 *     that was live when the predecessor stopped, so the revision continues that
 *     conversation. That needs the same transcript copy, so it is omitted — an ask that was
 *     in flight simply runs again.
 *
 * The preflight rule is the vendored one and it is all-or-nothing: if any *importable*
 * completed ask lacks a `messageBoundary`, the whole cache is refused
 * (`missing_boundaries`). A partial cache would silently mix imported and re-run results
 * in a way nobody could see.
 */

export interface ImportedCacheStats {
  actors: number
  askEntries: number
  worldEntries: number
}

export type ImportedCacheBuild =
  | { ok: true; cache: ImportedRunCache; stats: ImportedCacheStats }
  | { ok: false; reason: 'missing_boundaries' | 'no_entries'; stats: ImportedCacheStats }

/** The read face the builder needs — `WorkflowJournal` satisfies it. */
export interface ImportedCacheSource {
  getRun(runId: string): RunRecord | undefined
  listActors(runId: string): ActorRecord[]
  listNodes(runId: string): NodeRecord[]
}

/** Actors whose name is empty are not addressable: the cache is keyed by effective name,
 *  and an anonymous actor cannot be matched to a candidate in the revision. */
function namedActors(actors: ActorRecord[]): ActorRecord[] {
  return actors.filter((a) => typeof a.name === 'string' && a.name.trim() !== '')
}

/**
 * Build the cache for `runId`.
 *
 * Ask entries are indexed by `actorSeq`, which in the journal is the order the actor's asks
 * were admitted — so the prefix is taken in that order and stops at the first ask that did
 * not complete. A hole in the middle would make "the n-th ask" mean two different things.
 */
export function buildImportedCache(source: ImportedCacheSource, runId: string): ImportedCacheBuild {
  const stats: ImportedCacheStats = { actors: 0, askEntries: 0, worldEntries: 0 }
  const record = source.getRun(runId)
  if (!record) return { ok: false, reason: 'no_entries', stats }

  const nodes = source.listNodes(runId)
  const actors = namedActors(source.listActors(runId))

  // ── ask prefixes, per named actor ──────────────────────────────────────────
  const candidates = new Map<string, ImportedActorCandidate>()
  for (const actor of actors) {
    // No session id means no transcript to point at. Upstream drops such a candidate on
    // the service side rather than inventing a source, and so do we.
    if (!actor.sessionId) continue
    const own = nodes
      .filter((n) => n.kind === 'ask' && n.actorSiteId === actor.siteId && n.actorOrdinal === actor.ordinal)
      .sort((a, b) => (a.actorSeq ?? a.ordinal) - (b.actorSeq ?? b.ordinal))
    const entries: ImportedAskEntry[] = []
    for (const node of own) {
      if (node.status !== 'completed') break // the prefix stops at the first unfinished ask
      if (node.messageBoundary === undefined) {
        // The vendored gate: a completed ask with no boundary cannot be truncated to, so
        // the whole cache is refused rather than half-built.
        return { ok: false, reason: 'missing_boundaries', stats }
      }
      entries.push({
        inputHash: node.inputHash,
        result: node.result,
        ...(node.stats ? { stats: node.stats } : {}),
        messageBoundary: node.messageBoundary,
      })
    }
    if (entries.length === 0) continue
    candidates.set(actor.name!.trim(), {
      persona: actor.persona ?? {},
      entries,
      transcriptSourceSessionId: actor.sessionId,
      ...(actor.resolvedModel ? { resolvedModel: actor.resolvedModel } : {}),
    })
    stats.actors += 1
    stats.askEntries += entries.length
  }

  // ── world reads, queued by input hash ─────────────────────────────────────
  // The key is the engine's own `inputHash` on the row (it is computed over the bounded
  // `{op, args}` input at admission), so the queue is keyed exactly the way the engine
  // looks it up.
  const world = new Map<string, ImportedWorldEntry[]>()
  for (const node of nodes) {
    if (node.kind !== 'world-read' && node.kind !== 'world-run') continue
    if (node.status !== 'completed') continue
    const queue = world.get(node.inputHash) ?? []
    queue.push({ inputHash: node.inputHash, kind: node.kind, result: node.result })
    world.set(node.inputHash, queue)
    stats.worldEntries += 1
  }

  if (candidates.size === 0 && world.size === 0) return { ok: false, reason: 'no_entries', stats }
  return { ok: true, cache: { actors: candidates, world }, stats }
}

/**
 * The cache for a resume: rebuild it from the run's own predecessor.
 *
 * Upstream walks the whole `resumed_from` chain so a second revision can still reach the
 * first one's transcripts; we rebuild from the immediate predecessor only, which is
 * sufficient for results-level reuse (the finished asks of the immediate predecessor are
 * exactly the ones a revision of it would repeat). Documented, not hidden: a chain of two
 * revisions loses the grandparent's entries.
 */
export function buildResumeCache(journal: WorkflowJournal, record: RunRecord): ImportedCacheBuild {
  const predecessor = record.resumedFrom ? journal.getRun(record.resumedFrom) : undefined
  if (!predecessor) return { ok: false, reason: 'no_entries', stats: { actors: 0, askEntries: 0, worldEntries: 0 } }
  return buildImportedCache(journal, predecessor.runId)
}
