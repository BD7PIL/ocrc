// $lib/ws/boot.ts — REST boot + WS connection + per-session feed wiring.
// Port of the Svelte layout's bootConnection()/resyncViaRest()/view flow:
//  - hello/sessions      → session list
//  - card                → upsertCard; seq gap → latched REST resync (500ms)
//  - cards               → batch upsert (replay burst)
//  - sdelta              → 45ms coalesced appends (feeds store)
//  - session.status      → live busy
//  - replayEnd.epoch     → recorded; complete:false → REST resync (host restart)
//  - reconnect           → re-subscribe the viewed session from its lastSeq+epoch
import { api } from '$lib/api/client.js'
import { createWsClient, type WsClient } from './client.js'
import { useSessions } from '$lib/stores/sessions.js'
import {
  upsertCard, upsertCards, applyStreamDelta, setHistory, setFeedEpoch,
  pruneFeeds, isSeqGap, feedOf,
} from '$lib/stores/feeds.js'

let client: WsClient | null = null
let booted = false
let viewedId: string | null = null
// Resync latch: concurrent triggers (replayEnd + gap timer) collapse into one
// fetch; 2s floor between attempts.
let resyncInFlight = false
let lastResyncAt = 0
let gapTimer: ReturnType<typeof setTimeout> | undefined
const loadedSessions = new Set<string>()

export async function resyncViaRest(id: string): Promise<void> {
  if (resyncInFlight || Date.now() - lastResyncAt < 2000) return
  resyncInFlight = true
  lastResyncAt = Date.now()
  try {
    const { cards, lastSeq, busy } = await api.history(id)
    useSessions.getState().setServerBusyKey(id, !!busy)
    setHistory(id, cards, lastSeq)
    client?.send({ type: 'subscribe', sessionId: id, sinceSeq: lastSeq, epoch: feedOf(id)?.epoch })
  } catch (err) {
    console.warn('[boot] resync failed', err)
  } finally {
    resyncInFlight = false
  }
}

/** View a session: load history if unseen, subscribe from the feed cursor,
 *  prune every other feed (only the viewed session is subscribed). */
export async function viewSession(id: string, opts: { force?: boolean } = {}): Promise<void> {
  viewedId = id
  if (opts.force) loadedSessions.delete(id)
  if (!loadedSessions.has(id)) {
    loadedSessions.add(id)
    // Adopted engines can fail a read transiently (busy engine, v1→v2 engine
    // migration 404s). Retry once before surfacing the error banner.
    type HistoryResult = { cards: any[]; lastSeq: number; busy?: boolean; hasMore?: boolean; historyError?: string }
    let res: HistoryResult = await api.history(id).catch((err: Error) => ({ cards: [], lastSeq: 0, historyError: `历史加载失败：${err.message ?? '网络错误'}` }))
    if (res.historyError) {
      await new Promise((r) => setTimeout(r, 800))
      const second: HistoryResult | { historyError: string } = await api.history(id).catch((err: Error) => ({ historyError: res.historyError ?? err.message }))
      res = { ...res, ...(second as HistoryResult) }
    }
    const { cards, lastSeq, busy, historyError } = res
    useSessions.getState().setServerBusyKey(id, !!busy)
    setHistory(id, cards ?? [], lastSeq ?? 0, historyError)
    if (historyError) {
      console.warn('[boot] history load failed:', historyError)
      loadedSessions.delete(id) // a later view/retry re-fetches
    }
  }
  const feed = feedOf(id)
  client?.send({ type: 'subscribe', sessionId: id, sinceSeq: feed?.lastSeq ?? 0, epoch: feed?.epoch })
  // Only the viewed session is subscribed, so evict every other feed — live
  // cards for an evicted session simply recreate its feed.
  pruneFeeds(id)
}

/** Peek a session WITHOUT making it the viewed one (subagent session tabs):
 *  load history once, subscribe from the cursor, never prune. */
export async function peekSession(id: string): Promise<void> {
  if (!feedOf(id)) {
    try {
      const { cards, lastSeq } = await api.history(id)
      setHistory(id, cards, lastSeq)
    } catch (err) {
      console.warn('[boot] peek history failed', err)
    }
  }
  const feed = feedOf(id)
  client?.send({ type: 'subscribe', sessionId: id, sinceSeq: feed?.lastSeq ?? 0, epoch: feed?.epoch })
}

export function bootConnection(): void {
  if (booted) return
  booted = true

  // REST first — first paint must not wait for the WS handshake.
  void api.sessions().then((list) => useSessions.getState().setList(list)).catch(() => {})

  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  client = createWsClient({
    url: `${proto}://${location.host}/ws`,
    onMessage: (msg) => {
      if (msg.type === 'hello' && Array.isArray(msg.sessions)) {
        useSessions.getState().setList(msg.sessions)
      } else if (msg.type === 'sessions' && Array.isArray(msg.sessions)) {
        useSessions.getState().setList(msg.sessions)
      } else if (msg.type === 'session.status' && typeof msg.sessionId === 'string') {
        useSessions.getState().setBusy(msg.sessionId, !!msg.busy)
      } else if (msg.type === 'card' && msg.card) {
        upsertCard(msg.card)
        const sid = (msg.card as { sessionId?: string }).sessionId
        if (sid) {
          const feed = feedOf(sid)
          if (feed && isSeqGap(feed.lastSeq, msg.card)) {
            clearTimeout(gapTimer)
            gapTimer = setTimeout(() => { void resyncViaRest(sid) }, 500)
          }
        }
      } else if ((msg as any).type === 'cards' && Array.isArray((msg as any).cards)) {
        upsertCards((msg as any).cards)
      } else if (msg.type === 'sdelta' && msg.sessionId && msg.cardId) {
        applyStreamDelta(msg)
      } else if (msg.type === 'replayEnd' && typeof msg.sessionId === 'string' && typeof msg.epoch === 'string') {
        // Record the epoch FIRST — the next subscribe (including the resync's)
        // carries it, and a mismatch on the server side is the host-restart
        // resync signal.
        setFeedEpoch(msg.sessionId, msg.epoch)
      }
      if (msg.type === 'replayEnd' && msg.complete === false && typeof msg.sessionId === 'string') {
        // complete:false = the ring buffer may predate our snapshot → REST
        // resync. BUT a feed whose cursor is still 0 (reconstructed history —
        // seq-less cards) can never raise it: resyncing would re-fetch the
        // same data forever (the server answers since===0 with complete:false
        // by definition → 2s refetch loop). Resync only with a real cursor.
        const f = feedOf(msg.sessionId)
        if (f && f.lastSeq > 0) void resyncViaRest(msg.sessionId)
      }
    },
    onReconnect: () => {
      // Re-subscribe from the feed's current lastSeq so the WS replay fills
      // exactly the gap (epoch mismatch forces the server-side full resync).
      if (!viewedId) return
      const feed = feedOf(viewedId)
      client?.send({ type: 'subscribe', sessionId: viewedId, sinceSeq: feed?.lastSeq ?? 0, epoch: feed?.epoch })
    },
  })
}

export function forceReconnect(): void {
  client?.forceReconnect()
}
