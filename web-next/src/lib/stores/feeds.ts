// $lib/stores/feeds.ts — zustand port of the Svelte shell's sessions.ts feed
// store. The upsert/dedupe/sdelta-coalescing/resync semantics are preserved
// line-for-line; only the store surface changed (feeds.update(fn) →
// useFeeds.setState((s) => ({ feeds: fn(s.feeds) }))). Pinned by the ported
// sessions.test.ts — do not "simplify" the immutable-clone dance.
import { create } from 'zustand'
import type { StructuredCard, SessionSummary } from '../api/types.js'

/**
 * Normalized per-session feed. Cards are keyed by their stable `id` (stamped by
 * the backend CardBus): streaming updates and the final assistant card of one
 * turn share an id, so they upsert in place instead of appending. `lastSeq` is
 * the highest per-session sequence applied — used to dedupe replayed cards on
 * reconnect (see B3 / sequence cursor).
 */
export interface SessionFeed {
  order: string[]
  byId: Record<string, StructuredCard>
  lastSeq: number
  /** Identity of the CardBus that issued lastSeq — a mismatch on subscribe
   *  tells the server the client's seq belongs to a dead bus (host restart). */
  epoch?: string
}

interface FeedsState {
  feeds: Record<string, SessionFeed>
}

export const useFeeds = create<FeedsState>(() => ({ feeds: {} }))

const emptyFeed = (): SessionFeed => ({ order: [], byId: {}, lastSeq: 0 })

/** Record which CardBus epoch issued the feed's lastSeq (from replayEnd).
 *  A mismatch on the next subscribe tells the server to force a REST resync
 *  (host restart rewound the seq counter). */
export function setFeedEpoch(id: string, epoch: string): void {
  useFeeds.setState((s) => {
    const m = s.feeds
    const f = m[id]
    if (!f || f.epoch === epoch) return s
    return { feeds: { ...m, [id]: { ...f, epoch } } }
  })
}

export function feedOf(id: string): SessionFeed | undefined {
  return useFeeds.getState().feeds[id]
}

function cardId(card: StructuredCard, fallbackIndex: number): string {
  return card.id ?? `${card.kind}:${card.seq ?? fallbackIndex}`
}

function isTransient(kind: string | undefined): boolean {
  return kind === 'thinking' || kind === 'think-stream'
}

/** Live cards that mean "this session is working": thinking/streaming. A
 *  queued USER card appended while running must not flip this — busy is
 *  "any live card exists", not "the last card is live" (user report:
 *  header showed 空闲 while a queued turn's bash was still streaming). */
export function isRunningCard(kind: string | undefined): boolean {
  return kind === 'thinking' || kind === 'streaming' || kind === 'think-stream'
}

/** Materialize a feed into an ordered card array (for rendering). */
export function cardsOf(feed: SessionFeed | undefined): StructuredCard[] {
  if (!feed) return []
  return feed.order.map((id) => feed.byId[id]).filter(Boolean)
}

/**
 * True when a live card skips ahead of our cursor (`lastSeq + 1`). A live ws
 * socket is lossless and in-order, so a skipped seq means we missed frames
 * (e.g. a replay that raced a snapshot) — the caller must resync via REST
 * rather than keep a torn feed. `lastSeq === 0` means no snapshot yet (history
 * is still loading), which is not a gap.
 */
export function isSeqGap(lastSeq: number, card: StructuredCard): boolean {
  return typeof card.seq === 'number' && lastSeq > 0 && card.seq > lastSeq + 1
}

/** Apply a live card: upsert by id, dedupe by seq, clear transient thinking. */
export function upsertCard(card: StructuredCard) {
  if (!('sessionId' in card) || !card.sessionId) return
  const sid = card.sessionId
  const id = cardId(card, 0)
  // A full card frame is authoritative and newer than any buffered delta: the
  // server emits sdelta frames BEFORE the snapshot containing them, so dropping
  // pending deltas here can never lose text — but applying them after would
  // double-append (see applyStreamDelta below).
  clearPendingDeltas(id)
  useFeeds.setState((s) => {
    const map = s.feeds
    const feed = { ...emptyFeed(), ...map[sid] }
    // Already processed up to lastSeq (history snapshot or earlier replay).
    if (card.seq != null && card.seq <= feed.lastSeq && !(id in feed.byId)) return s
    if (card.seq != null) feed.lastSeq = Math.max(feed.lastSeq, card.seq)

    const stamped = card.id ? card : { ...card, id } as StructuredCard
    // Consecutive identical status cards (e.g. "status: idle" from external
    // turns finishing) are noise — replace the last one instead of stacking.
    if (card.kind === 'status') {
      const lastId = feed.order[feed.order.length - 1]
      const last = lastId ? feed.byId[lastId] : undefined
      if (last?.kind === 'status' && JSON.stringify(last.fields) === JSON.stringify((card as any).fields)) {
        return { feeds: { ...map, [sid]: { ...feed, byId: { ...feed.byId, [lastId]: stamped } } } }
      }
    }
    if (id in feed.byId) {
      // upsert in place — streaming → final assistant, same turn id
      return { feeds: { ...map, [sid]: { ...feed, byId: { ...feed.byId, [id]: stamped } } } }
    }
    let order = feed.order
    let byId = { ...feed.byId }
    // A new turn's first streaming/assistant/error retires transient thinking.
    // An error (abort) ALSO retires streaming cards — otherwise a stale
    // streaming card would keep the session marked busy forever.
    if (card.kind === 'streaming' || card.kind === 'assistant' || card.kind === 'error') {
      order = order.filter((x) => {
        if (isTransient(byId[x]?.kind)) { delete byId[x]; return false }
        if (card.kind === 'error' && byId[x]?.kind === 'streaming' && x !== id) { delete byId[x]; return false }
        return true
      })
    }
    return {
      feeds: {
        ...map,
        [sid]: { order: [...order, id], byId: { ...byId, [id]: stamped }, lastSeq: feed.lastSeq, epoch: feed.epoch },
      },
    }
  })
}

/** Batch upsert: N cards land in ONE store write. Replay bursts (WS reconnect
 *  replays up to 256 cards) used to issue 256 independent immutable copies —
 *  each one re-cloning the whole byId map and re-triggering every derivation. */
export function upsertCards(cards: StructuredCard[]) {
  if (cards.length === 0) return
  useFeeds.setState((s) => {
    let next = s.feeds
    for (const card of cards) {
      if (!('sessionId' in card) || !card.sessionId) continue
      const sid = card.sessionId
      const feed = { ...emptyFeed(), ...next[sid] }
      const id = cardId(card, 0)
      if (card.seq != null) feed.lastSeq = Math.max(feed.lastSeq, card.seq)
      const stamped = card.id ? card : { ...card, id } as StructuredCard
      if (id in feed.byId) {
        feed.byId = { ...feed.byId, [id]: stamped }
      } else {
        let order = feed.order
        let byId = { ...feed.byId }
        if (card.kind === 'streaming' || card.kind === 'assistant' || card.kind === 'error') {
          order = order.filter((x) => {
            const k = byId[x]?.kind
            if (isTransient(k)) { delete byId[x]; return false }
            if (card.kind === 'error' && k === 'streaming' && x !== id) { delete byId[x]; return false }
            return true
          })
        }
        feed.order = [...order, id]
        feed.byId = { ...byId, [id]: stamped }
      }
      next = { ...next, [sid]: feed }
    }
    return { feeds: next }
  })
}

/** Remove a card by id — e.g. an optimistic user card whose send failed. */
export function removeCard(id: string) {
  useFeeds.setState((s) => {
    const map = s.feeds
    for (const sid of Object.keys(map)) {
      const feed = map[sid]
      if (!(id in feed.byId)) continue
      const byId = { ...feed.byId }
      delete byId[id]
      return { feeds: { ...map, [sid]: { ...feed, order: feed.order.filter((x) => x !== id), byId } } }
    }
    return s
  })
}

// --- sdelta: incremental streaming appends (0.25.0) ---
// Wire frames carry only the text increment (relay forwards message.part.delta
// past the CardBus). Full snapshot cards stay authoritative: upsertCard clears
// pending deltas (wire order is delta-before-snapshot, so the snapshot already
// includes their text), and a delta that lands on a finalized/unknown card is
// dropped — the final assistant card carries the complete text.

/** `${sessionId}\0${cardId}` → partId → coalesced text. */
const pendingDeltas = new Map<string, Map<string, string>>()
let deltaFlushTimer: ReturnType<typeof setTimeout> | undefined

export function applyStreamDelta(frame: { sessionId: string; cardId: string; partId: string; text: string }) {
  if (!frame.text || !frame.cardId || !frame.sessionId) return
  const key = `${frame.sessionId}\u0000${frame.cardId}`
  let parts = pendingDeltas.get(key)
  if (!parts) { parts = new Map(); pendingDeltas.set(key, parts) }
  parts.set(frame.partId, (parts.get(frame.partId) ?? '') + frame.text)
  // Coalesce token bursts into one store update per markdown parse gap.
  if (deltaFlushTimer) return
  deltaFlushTimer = setTimeout(flushStreamDeltas, 45)
}

function flushStreamDeltas() {
  deltaFlushTimer = undefined
  if (pendingDeltas.size === 0) return
  const batches = [...pendingDeltas.entries()]
  pendingDeltas.clear()
  useFeeds.setState((s) => {
    let next = s.feeds
    for (const [key, parts] of batches) {
      const sep = key.indexOf('\u0000')
      const feed = next[key.slice(0, sep)]
      const cardId = key.slice(sep + 1)
      const card = feed?.byId[cardId]
      // Not a live streaming card (turn finalized, feed resynced, unknown):
      // the snapshot/final card carries this text — dropping is correct.
      if (!feed || card?.kind !== 'streaming') continue
      const blocks = [...card.blocks]
      let changed = false
      for (const [partId, text] of parts) {
        const i = blocks.findIndex((b) => b.type !== 'tool' && (b as { partId?: string }).partId === partId)
        if (i >= 0 && (blocks[i].type === 'text' || blocks[i].type === 'reasoning')) {
          blocks[i] = { ...blocks[i], text: (blocks[i] as { text: string }).text + text }
          changed = true
        } else if (i < 0) {
          // Block not yet seen in a snapshot (first deltas raced it): a text
          // block at the feed end; the next checkpoint restores true order.
          blocks.push({ type: 'text', text, partId })
          changed = true
        }
      }
      if (!changed) continue
      next = { ...next, [key.slice(0, sep)]: { ...feed, byId: { ...feed.byId, [cardId]: { ...card, blocks } } } }
    }
    return { feeds: next }
  })
}

function clearPendingDeltas(cardId: string) {
  for (const key of pendingDeltas.keys()) {
    if (key.endsWith(`\u0000${cardId}`)) pendingDeltas.delete(key)
  }
}

/** Replace a session's feed with historical cards (REST snapshot). */
export function setHistory(sessionId: string, cards: StructuredCard[], lastSeq = 0) {
  useFeeds.setState((s) => {
    const feed = emptyFeed()
    feed.lastSeq = lastSeq
    cards.forEach((c, i) => {
      const id = cardId(c, i)
      feed.order.push(id)
      // Stamp the id onto the card: reconstructed history cards have no id, and
      // the transcript keys by card.id — an id-less card would key to undefined
      // and collide with every other card → nothing renders.
      feed.byId[id] = c.id ? c : { ...c, id } as StructuredCard
    })
    return { feeds: { ...s.feeds, [sessionId]: feed } }
  })
}

/**
 * Prepend an older-history page (offset pagination from REST). Historical
 * cards carry no seq — lastSeq must not move. Each call stamps a unique page
 * tag into fallback ids: two pages could otherwise produce the same
 * `kind:index` fallback and collide (render keys must be unique).
 */
let prependPage = 0
export function prependHistory(sessionId: string, cards: StructuredCard[]) {
  if (cards.length === 0) return
  prependPage += 1
  const page = prependPage
  useFeeds.setState((s) => {
    const map = s.feeds
    const feed = map[sessionId] ?? emptyFeed()
    const byId = { ...feed.byId }
    const head: string[] = []
    for (let i = cards.length - 1; i >= 0; i--) {
      const c = cards[i]
      const id = c.id ?? `${c.kind}:h${page}:${i}`
      if (id in byId) continue
      head.push(id)
      byId[id] = c.id ? c : { ...c, id } as StructuredCard
    }
    if (head.length === 0) return s
    return { feeds: { ...map, [sessionId]: { order: [...head.reverse(), ...feed.order], byId, lastSeq: feed.lastSeq, epoch: feed.epoch } } }
  })
}

/**
 * Drop feeds of sessions that are neither viewed nor subscribed anymore —
 * otherwise every visited session's history (up to 500 cards each) stays in
 * memory forever. Live cards for an evicted session simply recreate its feed.
 */
export function pruneFeeds(keep: string | string[] | undefined) {
  const keepSet = new Set(Array.isArray(keep) ? keep : keep ? [keep] : [])
  useFeeds.setState((s) => {
    const next: Record<string, SessionFeed> = {}
    for (const sid of Object.keys(s.feeds)) {
      if (keepSet.has(sid)) next[sid] = s.feeds[sid]
    }
    return { feeds: next }
  })
}

// Re-export the list type for consumers of the light store.
export type { SessionSummary }
