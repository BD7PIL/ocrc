import type { Hono } from 'hono'
import type { BackendRegistry } from '../../../core/agent/registry.js'
import type { CardBus } from '../../../core/card-bus.js'
import type { SessionState } from '../../../core/state.js'
import type { StructuredCard } from '../../../core/structured-card.js'
import { DEFAULT_HISTORY_LIMIT } from '../../../core/history.js'

export function registerSession(app: Hono, reg: BackendRegistry, cardBus: CardBus, state: SessionState) {
  app.get('/api/session/:id', async (c) => {
    const rawId = c.req.param('id')
    const id = state.normalizeSessionId(rawId)
    const raw = c.req.query('limit')
    const limit = raw ? Math.max(0, Math.min(500, parseInt(raw, 10) || 0)) : undefined
    const rawOffset = c.req.query('offset')
    const offset = rawOffset ? Math.max(0, Math.min(2000, parseInt(rawOffset, 10) || 0)) : 0
    const effectiveLimit = limit ?? DEFAULT_HISTORY_LIMIT
    // Engine reads can fail (busy adopted engine, v1→v2 migration gaps) — never
    // swallow the error into a lying empty transcript: surface historyError so
    // the client can retry instead of showing「空会话」.
    let cards: StructuredCard[]
    let historyError: string | undefined
    try {
      cards = await reg.forSession(id).getHistory(id, limit, offset)
    } catch (e) {
      cards = []
      historyError = (e as Error).message ?? 'history read failed'
    }
    // Interaction cards (approval/question) live only in the card bus — the
    // engine never sees them as messages. The /z/ bridge projects its dock from
    // THIS response, so append the resident cards (latest per id; resolved
    // republishes overwrite their pending twin in place).
    cards = [...cards, ...cardBus.interactionCards(id)]
    // Heuristic: a full page means older messages may exist. Card count can
    // fall below message count (roles without cards), so this errs toward an
    // extra empty page — the client hides the button when a page comes back
    // short, never loses history.
    const hasMore = cards.length >= effectiveLimit
    // Server-side busy flag: the REST snapshot never contains live transient
    // cards (thinking/streaming), so a refresh mid-turn would derive
    // busy=false and show 空闲 while the engine is still running.
    const busy = state.hasActiveGeneration(id)
    return c.json({ cards, lastSeq: cardBus.currentSeq(id), hasMore, busy, historyError })
  })
}
