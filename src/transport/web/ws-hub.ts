import type { WebSocket } from 'ws'
import type { CardBus } from '../../core/card-bus.js'
import type { StreamDeltaFrame, StructuredCard } from '../../core/structured-card.js'
import type { SessionState } from '../../core/state.js'
import type { BackendRegistry } from '../../core/agent/registry.js'
import { fetchSessionSummaries } from './session-summary.js'

interface ClientState {
  ws: WebSocket
  user: { email: string }
  /** Multi-subscribe (0.18.8): the viewed session PLUS any right-pane live
   *  tabs (subagent transcripts). Empty set = pre-subscribe, forward all. */
  subscribed: Set<string>
}

export interface WsHub {
  attach(ws: WebSocket, user: { email: string }): void
  handleClientMessage(ws: WebSocket, msg: any): void
  detach(ws: WebSocket): void
  broadcast(card: StructuredCard): void
  /** Incremental streaming frames (0.25.0): same subscription filter as
   *  cards, but never buffered/replayed — the next snapshot card heals. */
  broadcastDelta(frame: StreamDeltaFrame): void
  /** Live busy/idle for a session (from engine session.status) — the composer
   *  shows 停止 vs 发送 from this; without it, turns started outside the
   *  panel show 发送 while running. */
  broadcastStatus(frame: { sessionId: string; busy: boolean }): void
}

export function createWsHub(opts: { cardBus: CardBus; registry: BackendRegistry; state: SessionState }): WsHub {
  const clients = new Map<WebSocket, ClientState>()

  // Proactive cards (push notifications: test-failure, session-finished) are a
  // Telegram delivery concern. The web shows the full turn live, so rendering a
  // late-arriving notification would just pile up at the feed end out of order.
  // Telegram still gets them via its own CardBus subscription.
  const isProactive = (card: StructuredCard): boolean => 'proactive' in card && card.proactive === true

  opts.cardBus.subscribeAll((card) => {
    if (isProactive(card)) return
    const sid = 'sessionId' in card ? card.sessionId : undefined
    const targets = [...clients.values()].filter(
      (state) => state.ws.readyState === 1 && (!sid || state.subscribed.size === 0 || state.subscribed.has(sid)),
    )
    if (targets.length === 0) return
    // Serialize ONCE for all clients — streaming replays stringify the full
    // card per client otherwise (O(clients × cardSize) JSON work per frame).
    const payload = JSON.stringify({ type: 'card', card })
    for (const state of targets) {
      try { state.ws.send(payload) } catch {}
    }
  })

  return {
    async attach(ws, user) {
      // Register synchronously: messages arriving while summaries load must not
      // be silently dropped, and detach() during the await must not leak a dead
      // client into the map.
      clients.set(ws, { ws, user, subscribed: new Set() })
      const sessions = await fetchSessionSummaries(opts.registry, opts.state).catch(() => [])
      if (ws.readyState !== 1) return
      try { ws.send(JSON.stringify({ type: 'hello', sessions })) } catch {}
    },
    handleClientMessage(ws, msg) {
      const state = clients.get(ws)
      if (!state) return
      if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return }
      if (msg.type === 'unsubscribe' && typeof msg.sessionId === 'string') {
        state.subscribed.delete(opts.state.normalizeSessionId(msg.sessionId))
        return
      }
      if (msg.type === 'subscribe' && typeof msg.sessionId === 'string') {
        const sid = opts.state.normalizeSessionId(msg.sessionId)
        state.subscribed.add(sid)
        // Replay buffered cards published after the client's snapshot. The
        // client sends sinceSeq = lastSeq from GET /api/session/:id; we replay
        // only cards with a higher seq, so there's no gap and no duplicate
        // (the client also dedupes by seq). Earlier code never replayed, which
        // dropped any card that landed between the REST snapshot and subscribe.
        const since = typeof msg.sinceSeq === 'number' ? msg.sinceSeq : 0
        // The ring buffer keeps only the most recent N cards. When the client's
        // snapshot predates the buffer's start (long disconnect on a busy
        // session), the replay below cannot bridge the gap — say so explicitly
        // (OC Manager's "sse-lagged" lesson) instead of leaving a torn feed
        // that looks complete. complete=false makes the client resync via REST.
        //
        // EPOCH: a host restart mints a fresh CardBus whose seq restarts at 1,
        // while the tab still holds (oldEpoch, hugeLastSeq) — replay never
        // fires and the client's seq-dedupe drops every new card (feed frozen
        // on a stale snapshot). An epoch mismatch therefore forces a resync
        // regardless of seq.
        const epochMismatch = typeof msg.epoch === 'string' && msg.epoch !== opts.cardBus.epoch()
        const oldest = opts.cardBus.oldestSeq(sid)
        const current = opts.cardBus.currentSeq(sid)
        const inverted = current !== undefined && current > 0 && since > current
        const complete = since === 0 || epochMismatch || inverted
          ? false
          : oldest === undefined ? since >= current : since >= oldest
        const batch = opts.cardBus.recent(sid).filter((card) => !isProactive(card) && (card.seq ?? 0) > since)
        if (batch.length > 0 && state.ws.readyState === 1) {
          // ONE frame for the whole replay — the client upserts as a batch
          // (256 per-card immutable map clones during reconnect replay were a
          // measurable main-thread stall).
          try { state.ws.send(JSON.stringify({ type: 'cards', cards: batch })) } catch {}
        }
        try { state.ws.send(JSON.stringify({ type: 'replayEnd', sessionId: sid, lastSeq: current, complete, epoch: opts.cardBus.epoch() })) } catch {}
      }
    },
    detach(ws) { clients.delete(ws) },
    broadcast(card) { /* cards flow via CardBus.publish */ },
    broadcastStatus(frame) {
      const targets = [...clients.values()].filter(
        (state) => state.ws.readyState === 1 && (state.subscribed.size === 0 || state.subscribed.has(frame.sessionId)),
      )
      for (const state of targets) {
        try { state.ws.send(JSON.stringify({ type: 'session.status', ...frame })) } catch {}
      }
    },
    broadcastDelta(frame) {
      const targets = [...clients.values()].filter(
        (state) => state.ws.readyState === 1 && (state.subscribed.size === 0 || state.subscribed.has(frame.sessionId)),
      )
      if (targets.length === 0) return
      const payload = JSON.stringify({ type: 'sdelta', ...frame })
      for (const state of targets) {
        try { state.ws.send(payload) } catch {}
      }
    },
  }
}
