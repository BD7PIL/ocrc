// lark transport — 飞书自建应用 over the official SDK's WebSocket 长连接
// (@larksuiteoapi/node-sdk): no public callback URL, which is what keeps it
// compatible with ocrc's local-first, no-cloud posture.
//
// Surface (v1, honest):
//  - inbound: p2p text messages (im.message.receive_v1) → IncomingMessage
//  - outbound: streaming/assistant cards live-patched in place (1s throttle);
//    approval cards with 3-button actions; single-choice question cards
//    (multi/custom → web hint); info/status as markdown
//  - interactions: card.action.trigger carries our button `value` JSON back
//
// The allowlist story differs from Telegram: Lark app visibility already
// scopes who can reach the bot, so v1 accepts p2p messages without a second
// id gate (revisit when the channels panel grows per-channel id fields).

import type { Transport, TransportStartDeps } from '../interface.js'
import type { IncomingMessage, ChannelCapabilities } from '../../core/types.js'
import type { StructuredCard } from '../../core/structured-card.js'
import type { AgentBackend } from '../../core/agent/backend.js'
import type { SessionState } from '../../core/state.js'
import { cardContent } from './cards.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('lark')

/** The slice of @larksuiteoapi/node-sdk this transport touches (injectable). */
export interface LarkClientLike {
  im: {
    message: {
      create(p: { params: { receive_id_type: string }; data: { receive_id: string; msg_type: string; content: string } }): Promise<unknown>
      patch(p: { path: { message_id: string }; data: { content: string } }): Promise<unknown>
    }
  }
}
export interface LarkWsLike {
  start(p: { eventDispatcher: unknown }): Promise<void>
  close(): void
}
export interface LarkDispatcherLike {
  register(handles: Record<string, (data: any) => Promise<void>>): unknown
}

export interface LarkConfig {
  appId: string
  appSecret: string
  domain?: string
  backend: AgentBackend
  state: SessionState
  /** Overrides for tests — the real SDK classes are used when omitted. */
  ws?: LarkWsLike
  client?: LarkClientLike
  dispatcher?: LarkDispatcherLike
  /** Card live-update throttle floor (ms); default 1s. */
  cardThrottleMs?: number
}

const CAPS: ChannelCapabilities = {
  edit: true,
  maxMessageLength: 20000,
  buttons: true,
  richText: true,
  streaming: true,
}

export function createLarkTransport(cfg: LarkConfig): Transport & { handleCardAction(a: { value?: Record<string, unknown>; open_id?: string; chat_id?: string }): Promise<void> } {
  let messageHandler: ((msg: IncomingMessage) => Promise<void>) | undefined
  let connected = false
  let client: LarkClientLike | undefined
  let ws: LarkWsLike | undefined
  /** sessionId → live turn card (streaming patches land on the same message). */
  const turnCards = new Map<string, { messageId: string; lastPatchAt: number }>()

  async function getClient(): Promise<LarkClientLike> {
    if (cfg.client) return cfg.client
    const sdk = await import('@larksuiteoapi/node-sdk')
    return new sdk.Client({ appId: cfg.appId, appSecret: cfg.appSecret, ...(cfg.domain ? { domain: cfg.domain } : {}) }) as unknown as LarkClientLike
  }

  async function sendCard(chatId: string, card: StructuredCard): Promise<string> {
    const c = client ?? (await getClient())
    const res = (await c.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'interactive', content: cardContent(card) },
    })) as { data?: { message_id?: string } }
    return res?.data?.message_id ?? ''
  }

  async function patchCard(messageId: string, card: StructuredCard): Promise<void> {
    try {
      const c = client ?? (await getClient())
      await c.im.message.patch({ path: { message_id: messageId }, data: { content: cardContent(card) } })
    } catch (err) {
      // A failed cosmetic patch must never break the stream — the next tick
      // re-patches and finalize always lands a fresh card.
      log.debug(`card patch failed: ${(err as Error).message}`)
    }
  }

  function handleIncoming(event: { sender?: { sender_id?: { open_id?: string } }; message?: { message_id?: string; chat_id?: string; chat_type?: string; message_type?: string; content?: string; session_id?: string } }): void {
    const msg = event.message
    if (!msg || msg.chat_type !== 'p2p' || msg.message_type !== 'text') return
    let text = ''
    try {
      text = String(JSON.parse(msg.content ?? '{}').text ?? '')
    } catch { return }
    text = text.replace(/^@\S+\s*/, '').trim() // strip the @bot prefix
    if (!text || !messageHandler) return
    void messageHandler({
      userId: event.sender?.sender_id?.open_id ?? '',
      chatId: msg.chat_id ?? '',
      text,
      messageId: msg.message_id ?? `lark_${Date.now()}`,
      origin: 'lark',
    })
  }

  async function handleCardAction(action: { value?: Record<string, unknown>; open_id?: string; chat_id?: string }): Promise<void> {
    const value = action.value
    if (!value || typeof value.t !== 'string') return
    const chatId = typeof action.chat_id === 'string' ? action.chat_id : ''
    try {
      if (value.t === 'perm' && typeof value.sid === 'string' && typeof value.rid === 'string') {
        const decision = value.d === 'once' || value.d === 'always' || value.d === 'reject' ? value.d : 'once'
        await cfg.backend.resolvePermission(value.sid, value.rid, decision)
        if (chatId) {
          await sendCard(chatId, {
            kind: 'info', sessionId: value.sid, proactive: false,
            title: decision === 'reject' ? '❌ 已拒绝' : '🔓 已允许', sections: [{ body: '处理完成。' }],
          })
        }
        return
      }
      if (value.t === 'q' && typeof value.sid === 'string' && typeof value.rid === 'string') {
        if (value.rej) {
          await cfg.backend.rejectQuestion?.(value.sid, value.rid)
          return
        }
        if (typeof value.oi === 'number') {
          const pending = (await cfg.backend.listQuestions?.(undefined)) ?? []
          const req = pending.find((r) => r.id === value.rid)
          const label = req?.questions[0]?.options[value.oi]?.label
          if (label) await cfg.backend.answerQuestion?.(value.sid, value.rid, [[label]])
        }
      }
    } catch (err) {
      log.warn(`card action failed: ${(err as Error).message}`)
    }
  }

  async function onCard(card: StructuredCard, chatIdOf: (sid: string) => string | undefined): Promise<void> {
    if (!('sessionId' in card) || !card.sessionId) return
    const chatId = chatIdOf(card.sessionId)
    if (!chatId) return

    if (card.kind === 'thinking') return // the streaming card replaces it within a tick
    if (card.kind === 'streaming') {
      const now = Date.now()
      const existing = turnCards.get(card.sessionId)
      const throttle = cfg.cardThrottleMs ?? 1000
      if (existing) {
        if (!existing.messageId) return // create still in flight — drop, next snapshot heals
        if (now - existing.lastPatchAt < throttle) return
        existing.lastPatchAt = now
        await patchCard(existing.messageId, card)
        return
      }
      // Claim the slot SYNCHRONOUSLY: two publishes racing before create
      // resolves must not spawn two messages.
      const slot = { messageId: '', lastPatchAt: now }
      turnCards.set(card.sessionId, slot)
      slot.messageId = await sendCard(chatId, card)
      return
    }
    if (card.kind === 'assistant') {
      const existing = turnCards.get(card.sessionId)
      turnCards.delete(card.sessionId)
      if (existing) {
        await patchCard(existing.messageId, card)
        return
      }
      await sendCard(chatId, card)
      return
    }
    if (card.kind === 'error') {
      turnCards.delete(card.sessionId)
      await sendCard(chatId, card)
      return
    }
    // user cards are never mirrored: Lark already shows the user their own
    // message, and the echo card's ONLY job is the session→chat binding above
    if (card.kind === 'approval' || card.kind === 'question' || card.kind === 'info' || card.kind === 'status') {
      await sendCard(chatId, card)
    }
  }

  return {
    name: 'lark',
    capabilities: CAPS,
    async start(deps: TransportStartDeps) {
      const { cardBus } = deps
      client = await getClient()

      // chatId resolution: cards are keyed by the RESOLVED agent sessionId,
      // which Lark events don't carry — so bind via the relay's user-card
      // echo, exactly like the dingtalk transport: the relay publishes the
      // user card with id `user:${msg.messageId}` (core/relay.ts), and every
      // inbound Lark message knows its own message_id → chat_id. Without the
      // echo binding, a second user's chat would steal delivery (cross-user
      // leakage found by the OCR review).
      const chatByMessageId = new Map<string, string>()
      const chatBySession = new Map<string, string>()

      const dispatcher: LarkDispatcherLike = cfg.dispatcher ?? (await (async () => {
        const sdk = await import('@larksuiteoapi/node-sdk')
        return new sdk.EventDispatcher({}) as unknown as LarkDispatcherLike
      })())

      dispatcher.register({
        'im.message.receive_v1': async (data: any) => {
          const ev = data?.event ?? data
          const chatId = ev?.message?.chat_id
          if (chatId && typeof ev?.message?.message_id === 'string') {
            chatByMessageId.set(ev.message.message_id, chatId)
          }
          handleIncoming(ev)
        },
        'card.action.trigger': async (data: any) => {
          const a = data?.event?.action ?? data?.action
          await handleCardAction({
            value: a?.value,
            open_id: data?.event?.operator?.open_id ?? data?.operator?.open_id,
            chat_id: a?.context?.open_chat_id ?? data?.event?.context?.open_chat_id,
          })
        },
      })

      if (cfg.ws) {
        ws = cfg.ws
        await ws.start({ eventDispatcher: dispatcher })
      } else {
        const sdk = await import('@larksuiteoapi/node-sdk')
        ws = new sdk.WSClient({ appId: cfg.appId, appSecret: cfg.appSecret, ...(cfg.domain ? { domain: cfg.domain } : {}) }) as unknown as LarkWsLike
        await ws.start({ eventDispatcher: dispatcher })
      }
      connected = true
      log.info('lark transport started (WS long connection)')

      cardBus.subscribeAll((card) => {
        // user-card echo binds session → chat (no fallback: guessing delivers
        // one user's session output into another user's chat)
        if (card.kind === 'user' && typeof card.id === 'string' && card.id.startsWith('user:')) {
          const chat = chatByMessageId.get(card.id.slice('user:'.length))
          if (chat) chatBySession.set(card.sessionId, chat)
        }
        const chat = chatBySession.get((card as { sessionId?: string }).sessionId ?? '')
        void onCard(card, () => chat).catch((err) => log.error(`onCard failed: ${(err as Error).message}`))
      })
    },
    async stop() {
      connected = false
      try { ws?.close() } catch { /* already gone */ }
    },
    status() {
      return { connected, username: cfg.appId }
    },
    async send(_chatId, _card) {
      throw new Error('use cardBus.publish for lark outbound')
    },
    onMessage(h) { messageHandler = h },
    onCommand() { },
    onButtonClick() { },
    handleCardAction,
  }
}
