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
}

const emptyFeed = (): SessionFeed => ({ order: [], byId: {}, lastSeq: 0 })

export const feeds = writable<Record<string, SessionFeed>>({})

function cardId(card: StructuredCard, fallbackIndex: number): string {
  return card.id ?? `${card.kind}:${card.seq ?? fallbackIndex}`
}

function isTransient(kind: string | undefined): boolean {
  return kind === 'thinking' || kind === 'think-stream'
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
  feeds.update((map) => {
    const feed = map[sid] ?? emptyFeed()
    // Already processed up to lastSeq (history snapshot or earlier replay).
    if (card.seq != null && card.seq <= feed.lastSeq && !(id in feed.byId)) return map
    if (card.seq != null) feed.lastSeq = Math.max(feed.lastSeq, card.seq)

    const stamped = card.id ? card : { ...card, id } as StructuredCard
    if (id in feed.byId) {
      // upsert in place — streaming → final assistant, same turn id
      feed.byId = { ...feed.byId, [id]: stamped }
    } else {
      let order = feed.order
      let byId = feed.byId
      // A new turn's first streaming/assistant/error retires transient thinking.
      if (card.kind === 'streaming' || card.kind === 'assistant' || card.kind === 'error') {
        byId = { ...byId }
        order = order.filter((x) => {
          if (isTransient(byId[x]?.kind)) { delete byId[x]; return false }
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
