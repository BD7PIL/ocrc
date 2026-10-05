import { writable } from 'svelte/store'
import type { StructuredCard, SessionSummary } from '../api/types.js'

export const sessionList = writable<SessionSummary[]>([])

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

const emptyFeed = (): SessionFeed => ({ order: [], byId: {}, lastSeq: 0 })

/** Record which CardBus epoch issued the feed's lastSeq (from replayEnd).
 *  A mismatch on the next subscribe tells the server to force a REST resync
 *  (host restart rewound the seq counter). */
export function setFeedEpoch(id: string, epoch: string): void {
  feeds.update((m) => {
    const f = m[id]
    if (!f || f.epoch === epoch) return m
    m[id] = { ...f, epoch }
    return m
  })
}

/** Server-reported busy per session (REST snapshot flag) — survives refresh
 *  where live transient cards don't. The busy derivation ORs this in. */
export const serverBusy = (() => {
  const map = writable<Record<string, boolean>>({})
  return {
    subscribe: map.subscribe,
    setKey(id: string, v: boolean) { map.update((m) => ({ ...m, [id]: v })) },
    clearKey(id: string) { map.update((m) => { const n = { ...m }; delete n[id]; return n }) },
  }
})()

export const feeds = writable<Record<string, SessionFeed>>({})

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
  feeds.update((map) => {
    const feed = map[sid] ?? emptyFeed()
    // Already processed up to lastSeq (history snapshot or earlier replay).
    if (card.seq != null && card.seq <= feed.lastSeq && !(id in feed.byId)) return map
    if (card.seq != null) feed.lastSeq = Math.max(feed.lastSeq, card.seq)

    const stamped = card.id ? card : { ...card, id } as StructuredCard
    // Consecutive identical status cards (e.g. "status: idle" from external
    // turns finishing) are noise — replace the last one instead of stacking.
    if (card.kind === 'status') {
      const lastId = feed.order[feed.order.length - 1]
      const last = lastId ? feed.byId[lastId] : undefined
      if (last?.kind === 'status' && JSON.stringify(last.fields) === JSON.stringify((card as any).fields)) {
        feed.byId = { ...feed.byId, [lastId]: stamped }
        return map
      }
    }
    if (id in feed.byId) {
      // upsert in place — streaming → final assistant, same turn id
      feed.byId = { ...feed.byId, [id]: stamped }
    } else {
      let order = feed.order
      let byId = feed.byId
      // A new turn's first streaming/assistant/error retires transient thinking.
      // An error (abort) ALSO retires streaming cards — otherwise a stale
      // streaming card would keep the session marked busy forever.
      if (card.kind === 'streaming' || card.kind === 'assistant' || card.kind === 'error') {
        byId = { ...byId }
        order = order.filter((x) => {
          if (isTransient(byId[x]?.kind)) { delete byId[x]; return false }
          if (card.kind === 'error' && byId[x]?.kind === 'streaming' && x !== id) { delete byId[x]; return false }
          return true
        })
      }
      feed.order = [...order, id]
      feed.byId = { ...byId, [id]: stamped }
    }
    return { ...map, [sid]: feed }
  })
}

/** Remove a card by id — e.g. an optimistic user card whose send failed. */
export function removeCard(id: string) {
  feeds.update((map) => {
    for (const sid of Object.keys(map)) {
      const feed = map[sid]
      if (!(id in feed.byId)) continue
      const byId = { ...feed.byId }
      delete byId[id]
      return { ...map, [sid]: { ...feed, order: feed.order.filter((x) => x !== id), byId } }
    }
    return map
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
  feeds.update((map) => {
    let next = map
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
    return next
  })
}

function clearPendingDeltas(cardId: string) {
  for (const key of pendingDeltas.keys()) {
    if (key.endsWith(`\u0000${cardId}`)) pendingDeltas.delete(key)
  }
}

/** Replace a session's feed with historical cards (REST snapshot). */export function setHistory(sessionId: string, cards: StructuredCard[], lastSeq = 0) {
  feeds.update((map) => {
    const feed = emptyFeed()
    feed.lastSeq = lastSeq
    cards.forEach((c, i) => {
      const id = cardId(c, i)
      feed.order.push(id)
      // Stamp the id onto the card: reconstructed history cards have no id, and
      // the transcript keys `{#each … (card.id)}`, so an id-less card would key
      // to undefined and collide with every other card → nothing renders.
      feed.byId[id] = c.id ? c : { ...c, id } as StructuredCard
    })
    return { ...map, [sessionId]: feed }
  })
}

/**
 * Prepend an older-history page (offset pagination from REST). Historical
 * cards carry no seq — lastSeq must not move. Each call stamps a unique page
 * tag into fallback ids: two pages could otherwise produce the same
 * `kind:index` fallback and collide (Svelte {#each} keys must be unique).
 */
let prependPage = 0
export function prependHistory(sessionId: string, cards: StructuredCard[]) {
  if (cards.length === 0) return
  prependPage += 1
  const page = prependPage
  feeds.update((map) => {
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
    if (head.length === 0) return map
    return { ...map, [sessionId]: { order: [...head.reverse(), ...feed.order], byId, lastSeq: feed.lastSeq } }
  })
}

/**
 * Drop feeds of sessions that are neither viewed nor subscribed anymore —
 * otherwise every visited session's history (up to 500 cards each) stays in
 * memory forever. Live cards for an evicted session simply recreate its feed.
 */
export function pruneFeeds(keep: string | string[] | undefined) {
  const keepSet = new Set(Array.isArray(keep) ? keep : keep ? [keep] : [])
  feeds.update((map) => {
    const next: Record<string, SessionFeed> = {}
    for (const sid of Object.keys(map)) {
      if (keepSet.has(sid)) next[sid] = map[sid]
    }
    return next
  })
}
