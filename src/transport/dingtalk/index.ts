// dingtalk transport — 钉钉企业内部应用（机器人）over the official
// dingtalk-stream SDK's Stream Mode: an OUTBOUND WebSocket from our process,
// so no public callback URL — same local-first posture as the Lark transport.
//
// Surface (v1, honest degradation):
//  - inbound: robot messages (TOPIC_ROBOT) → IncomingMessage
//  - outbound: markdown replies via the robot oToMessages API; assistant
//    finals, errors and info cards render as markdown; NO live card patching
//    and NO buttons in v1 (DingTalk interactive cards need the AI-card
//    lifecycle — planned; capabilities say so and the UI degrades)
//
// Outbound routing: cards are keyed by the RESOLVED session id, which the
// inbound robot message doesn't know. The relay publishes the user card with
// id `user:${msg.messageId}` — that echo is how the transport binds
// sessionId → sender (mirrors how the Lark transport binds via chat_id).

import type { Transport, TransportStartDeps } from '../interface.js'
import type { IncomingMessage, ChannelCapabilities } from '../../core/types.js'
import type { StructuredCard } from '../../core/structured-card.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('dingtalk')

/** Minimal slice of the dingtalk-stream SDK (injectable for tests). */
export interface DingStreamClientLike {
  registerCallbackListener(topic: string, cb: (data: any) => Promise<any>): void
  connect(): Promise<void>
  disconnect(): void
}
/** Minimal slice of the REST side (injectable for tests). */
export interface DingRestLike {
  getAccessToken(): Promise<string>
  oToMessages(token: string, body: { robotCode: string; userIds: string[]; msgKey: string; msgParam: string }): Promise<void>
}

export interface DingTalkConfig {
  clientId: string
  clientSecret: string
  robotCode?: string // defaults to clientId (the robot's code IS the app key)
  /** Optional sender allowlist (senderStaffId values). Empty = open to
   *  anyone who can reach the app — set it in enterprise deployments. */
  allowIds?: string[]
  stream?: DingStreamClientLike
  rest?: DingRestLike
}

const CAPS: ChannelCapabilities = {
  edit: false, // no card patching in v1 — replies are final messages
  maxMessageLength: 20000,
  buttons: false,
  richText: true, // markdown
  streaming: false,
}

const ROBOT_RECEIVE = '/v1.0/im/bot/messages/get'
const MSG_KEY_MARKDOWN = 'sampleMarkdown'

function mdForCard(card: StructuredCard): string {
  switch (card.kind) {
    case 'thinking':
    case 'think-stream':
      return '💭 思考中…'
    case 'streaming':
      return '⏳ 回复生成中…（完成后推送最终回复）'
    case 'assistant': {
      const lines: string[] = []
      for (const b of card.blocks) {
        if (b.type === 'text' && b.text) lines.push(b.text)
        if (b.type === 'tool') lines.push(`${b.status === 'error' ? '❌' : b.status === 'done' ? '✅' : '⏳'} ${b.tool}${b.args ? ` · ${String(b.args).slice(0, 60)}` : ''}`)
      }
      const meta = card.meta
      const foot: string[] = []
      if (meta?.agent) foot.push(meta.agent)
      if (meta?.model) foot.push(meta.model)
      if (typeof meta?.cost === 'number') foot.push(`$${meta.cost.toFixed(3)}`)
      if (foot.length) lines.push('', `_${foot.join(' · ')}_`)
      return lines.join('\n').slice(0, 18000) || '…'
    }
    case 'error':
      return `❌ ${String(card.message).slice(0, 3000)}`
    case 'user':
      return `🙋 ${card.text}`
    case 'info':
      return [`**${card.title}**`, ...card.sections.map((s) => s.body)].join('\n')
    case 'status':
      return Object.entries(card.fields).map(([k, v]) => `**${k}**: ${v}`).join('\n')
    case 'approval':
      return [`🔐 **${card.title}**`, '请在 Web 面板处理该权限请求。'].join('\n')
    case 'question':
      return ['❓ 需要你回答', '请在 Web 面板完成该问题（钉钉 v1 不支持交互按钮）。'].join('\n')
  }
}

export function createDingTalkTransport(cfg: DingTalkConfig): Transport {
  let messageHandler: ((msg: IncomingMessage) => Promise<void>) | undefined
  let connected = false
  let stream: DingStreamClientLike | undefined
  let restClient: unknown
  const robotCode = cfg.robotCode ?? cfg.clientId

  /** messageId (inbound) → sender id; the user-card echo binds it to a session. */
  const senderByMessageId = new Map<string, string>()
  /** sessionId → sender id (learned from user-card echoes). */
  const senderBySession = new Map<string, string>()

  async function rest(): Promise<DingRestLike> {
    if (cfg.rest) return cfg.rest
    // one cached DWClient — a fresh client per call defeated the SDK's
    // per-instance token cache (OCR review) and hammered the token endpoint.
    if (!restClient) {
      const mod = await import('dingtalk-stream')
      restClient = new mod.DWClient({ clientId: cfg.clientId, clientSecret: cfg.clientSecret })
    }
    const client = restClient
    return {
      async getAccessToken() {
        return String(await (client as any).getAccessToken())
      },
      async oToMessages(token, body) {
        const res = await fetch('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
          method: 'POST',
          headers: { 'x-acs-dingtalk-access-token': token, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        })
        if (!res.ok) throw new Error(`oToMessages HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
      },
    }
  }

  return {
    name: 'dingtalk',
    capabilities: CAPS,
    async start(deps: TransportStartDeps) {
      const { cardBus } = deps
      stream = cfg.stream ?? (await (async () => {
        const mod = await import('dingtalk-stream')
        return new mod.DWClient({ clientId: cfg.clientId, clientSecret: cfg.clientSecret }) as unknown as DingStreamClientLike
      })())

      stream.registerCallbackListener(ROBOT_RECEIVE, async (data: any) => {
        try {
          const body = typeof data?.data === 'string' ? JSON.parse(data.data) : data?.data ?? data
          const text = String(body?.text?.content ?? '').replace(/^@\S+\s*/, '').trim()
          if (!text || !messageHandler) return
          const sender = String(body?.senderStaffId ?? body?.senderNick ?? '')
          // optional per-channel allow gate (credentials.allow_ids, CSV) —
          // empty/absent = any coworker who can reach the app may drive it
          const allowRaw = cfg.allowIds ?? []
          if (allowRaw.length > 0 && !allowRaw.includes(sender)) {
            log.warn(`dingtalk message from non-allowlisted sender dropped`)
            return { status: 'SUCCESS' }
          }
          const messageId = String(body?.msgId ?? `ding_${Date.now()}`)
          // bounded map (OCR review: it grew without bound on enterprise bots)
          if (senderByMessageId.size > 2000) senderByMessageId.clear()
          senderByMessageId.set(messageId, sender)
          await messageHandler({
            userId: sender,
            chatId: sender, // 1:1 robot chats route by sender
            text,
            messageId,
            origin: 'dingtalk',
          })
        } catch (err) {
          log.error(`robot message failed: ${(err as Error).message}`)
        }
        return { status: 'SUCCESS' }
      })

      // Stream Mode reconnects internally; wrap for the same posture anyway.
      let attempt = 0
      for (;;) {
        try {
          await stream.connect()
          connected = true
          log.info('dingtalk transport started (Stream Mode)')
          break
        } catch (err) {
          if (cfg.stream) throw err
          const delay = Math.min(1000 * 2 ** attempt, 30_000)
          attempt++
          log.warn(`dingtalk connect failed (retry ${attempt} in ${delay}ms): ${(err as Error).message}`)
          await new Promise((r) => setTimeout(r, delay))
        }
      }

      cardBus.subscribeAll((card) => {
        if (!('sessionId' in card) || !card.sessionId) return
        // bind session → sender from the relay's user-card echo
        if (card.kind === 'user' && typeof card.id === 'string' && card.id.startsWith('user:')) {
          const sender = senderByMessageId.get(card.id.slice('user:'.length))
          if (sender) senderBySession.set(card.sessionId, sender)
          return
        }
        if (card.kind === 'streaming' || card.kind === 'thinking' || card.kind === 'think-stream') return
        // No bound sender for this session → don't guess: sending to
        // lastSender would leak one user's session output to another
        // coworker (OCR review finding).
        const userId = senderBySession.get(card.sessionId)
        if (!userId) return
        if (card.kind === 'assistant' || card.kind === 'error' || card.kind === 'info' || card.kind === 'status' || card.kind === 'approval' || card.kind === 'question') {
          void rest().then((r) => sendMarkdownWith(r, userId, mdForCard(card)))
            .catch((err) => log.error(`send failed: ${(err as Error).message}`))
        }
      })
    },
    async stop() {
      connected = false
      try { stream?.disconnect() } catch { /* already gone */ }
    },
    status() {
      return { connected, username: cfg.clientId }
    },
    async send(_chatId, _card) {
      throw new Error('use cardBus.publish for dingtalk outbound')
    },
    onMessage(h) { messageHandler = h },
    onCommand() { },
    onButtonClick() { },
  }

  async function sendMarkdownWith(r: DingRestLike, userId: string, markdown: string): Promise<void> {
    const token = await r.getAccessToken()
    await r.oToMessages(token, {
      robotCode,
      userIds: [userId],
      msgKey: MSG_KEY_MARKDOWN,
      msgParam: JSON.stringify({ content: markdown, title: markdown.replace(/[#*_[\]()~`>+\-=|{}.!\\]/g, '').slice(0, 20) || 'ocrc' }),
    })
  }
}
