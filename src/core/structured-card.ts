export interface ToolCall {
  tool: string
  args: string
  status: 'running' | 'done' | 'error'
  /** Present when known — lets the web transcript open the full output page. */
  partId?: string
  messageId?: string
}

export interface AssistantMeta {
  agent?: string
  model?: string
  cost?: number
  tokens?: { input: number; output: number; cache?: number }
}

export interface InfoSection {
  heading?: string
  body: string
  code?: { language?: string; content: string }
}

export interface Button {
  label: string
  data: string
}

/** A single block in a streaming or final assistant message. Order matters.
 *  `reasoning` blocks ride ONLY on streaming cards (live thinking); the final
 *  assistant card carries the turn's reasoning as `thinkingText` instead.
 *  Blocks carry partId when known — the web transcript keys renders by it and
 *  applies `sdelta` frames (below) to the matching block; tool blocks also
 *  carry messageId to open full-output pages (GET /api/session/:id/message/:msgId). */
export type ContentBlock =
  | { type: 'text'; text: string; partId?: string }
  | { type: 'tool'; tool: string; args: string; status: 'running' | 'done' | 'error'; partId?: string; messageId?: string }
  | { type: 'reasoning'; text: string; partId?: string }

/**
 * Incremental streaming frame (0.25.0): the raw text increment from
 * message.part.delta, relayed to WS clients WITHOUT the CardBus (never
 * buffered, no seq, replay never carries it). A throttled full `streaming`
 * card remains the authoritative snapshot — it wholesale-replaces whatever
 * deltas applied, so ordering or drop concerns reduce to "the next snapshot
 * heals the feed". Single TCP stream ⇒ deltas arrive in emit order.
 */
export interface StreamDeltaFrame {
  sessionId: string
  /** The streaming card these deltas belong to (ctx.cardId). */
  cardId: string
  partId: string
  text: string
}

/**
 * Identity stamped by CardBus.publish (callers don't set these):
 * - `id`: stable per logical card. Streaming updates and the final assistant
 *   card of one turn share an id, so the UI upserts in place instead of
 *   appending. CardBus fills `kind:seq` for cards that don't carry one.
 * - `seq`: monotonic per session — used for ordering, dedupe, and replay-since.
 */
export interface CardMeta {
  id?: string
  seq?: number
}

export type StructuredCard = CardMeta & (
  | { kind: 'thinking';     sessionId: string;  showStop: boolean }
  | { kind: 'think-stream'; sessionId: string;  thinkingText: string }
  | { kind: 'streaming';    sessionId: string;  blocks: ContentBlock[] }
  | { kind: 'assistant';    sessionId: string;  blocks: ContentBlock[]; meta: AssistantMeta; thinkingText?: string; /** opencode message id — revert target. */ messageId?: string }
  | { kind: 'user';         sessionId: string;  text: string;  ts: number;  origin?: 'telegram' | 'web' | 'scheduler' }
  | { kind: 'error';        sessionId: string;  message: string }
  | { kind: 'status';       sessionId: string;  fields: Record<string, string>; buttons?: Button[][] }
  | { kind: 'info';         title: string;      sections: InfoSection[]; sessionId?: string;  proactive?: boolean }
  | { kind: 'approval';     sessionId: string;  title: string;  args: unknown;  requestId: string }
  | {
      kind: 'question'
      sessionId: string
      requestId: string
      questions: Array<{ question: string; header?: string; options: Array<{ label: string; description?: string }>; multiple?: boolean; custom?: boolean }>
      /** Set once answered/declined (same card id republished → upsert in place). */
      resolved?: 'replied' | 'rejected'
      answers?: string[][]
    }
)
