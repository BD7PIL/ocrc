import type { WebSocket } from 'ws'
import type { CardBus } from '../../core/card-bus.js'
import type { StructuredCard } from '../../core/structured-card.js'
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
    for (const state of clients.values()) {
      if (state.ws.readyState !== 1) continue
      if (sid && state.subscribed.size > 0 && !state.subscribed.has(sid)) continue
      try { state.ws.send(JSON.stringify({ type: 'card', card })) } catch {}
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
        const oldest = opts.cardBus.oldestSeq(sid)
        const current = opts.cardBus.currentSeq(sid)
        const complete = since === 0 || (oldest === undefined ? since >= current : since >= oldest)
        for (const card of opts.cardBus.recent(sid)) {
          if (isProactive(card)) continue
          if ((card.seq ?? 0) > since && state.ws.readyState === 1) {
            try { state.ws.send(JSON.stringify({ type: 'card', card })) } catch {}
          }
        }
        try { state.ws.send(JSON.stringify({ type: 'replayEnd', sessionId: sid, lastSeq: current, complete })) } catch {}
      }
    },
    detach(ws) { clients.delete(ws) },
    broadcast(card) { /* cards flow via CardBus.publish */ },
  }
}
