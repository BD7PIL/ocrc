// wecom transport — 企业微信群机器人 webhook（push-only，v1）。
//
// WeCom's self-built app REQUIRES a publicly verifiable callback URL for
// inbound messages — incompatible with ocrc's local-first/no-cloud posture
// until a relay is configured. The group-robot webhook, however, is a plain
// outbound HTTPS POST: perfect for ocrc's proactive surface (session
// finished, test failures, notifications) plus assistant finals. Inbound
// control stays on Telegram/Lark/DingTalk/the web panel for now; this
// transport exists so the 通道 panel's WeCom entry is REAL and enterprise
// users get push on a surface they already watch.

import type { Transport, TransportStartDeps } from '../interface.js'
import type { IncomingMessage, ChannelCapabilities } from '../../core/types.js'
import type { StructuredCard } from '../../core/structured-card.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('wecom')

const CAPS: ChannelCapabilities = {
  edit: false,
  maxMessageLength: 4096, // webhook markdown limit
  buttons: false,
  richText: true,
  streaming: false,
}

function mdForCard(card: StructuredCard): string {
  switch (card.kind) {
    case 'assistant': {
      const lines: string[] = []
      for (const b of card.blocks) {
        if (b.type === 'text' && b.text) lines.push(b.text)
      }
      const meta = card.meta
      const foot: string[] = []
      if (meta?.agent) foot.push(meta.agent)
      if (meta?.model) foot.push(meta.model)
      if (typeof meta?.cost === 'number') foot.push(`$${meta.cost.toFixed(3)}`)
      if (foot.length) lines.push('', `> ${foot.join(' · ')}`)
      return lines.join('\n').slice(0, 3800) || '…'
    }
    case 'error':
      return `**❌ 出错了**\n${String(card.message).slice(0, 2000)}`
    case 'info':
      return [`**${card.title}**`, ...card.sections.map((s) => s.body)].join('\n').slice(0, 3800)
    case 'status':
      return Object.entries(card.fields).map(([k, v]) => `**${k}**: ${v}`).join('\n')
    case 'approval':
      return `**🔐 ${card.title}**\n请在 Web 面板处理该权限请求。`
    case 'question':
      return '**❓ 需要你回答**\n请在 Web 面板完成该问题。'
    case 'thinking':
    case 'think-stream':
    case 'streaming':
    case 'user':
      return '' // process surfaces don't belong in a push-only webhook
  }
}

export interface WeComConfig {
  /** 群机器人 webhook，形如 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=… */
  webhookUrl: string
  /** Forward assistant finals too, not just proactive cards (default true). */
  includeAssistant?: boolean
}

export function createWeComTransport(cfg: WeComConfig): Transport {
  let connected = false
  let messageHandler: ((msg: IncomingMessage) => Promise<void>) | undefined
  const posts: Array<{ url: string; body: unknown }> = []

  async function post(markdown: string): Promise<void> {
    const res = await fetch(cfg.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content: markdown } }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`webhook HTTP ${res.status}`)
    const body = (await res.json().catch(() => ({}))) as { errcode?: number; errmsg?: string }
    if (body.errcode !== 0) throw new Error(`webhook errcode ${body.errcode}: ${body.errmsg}`)
  }

  const transport: Transport = {
    name: 'wecom',
    capabilities: CAPS,
    async start(deps: TransportStartDeps) {
      const { cardBus } = deps
      connected = true
      log.info('wecom transport started (webhook push-only)')

      cardBus.subscribeAll((card) => {
        if (!('sessionId' in card) || !card.sessionId) return
        const proactive = 'proactive' in card && card.proactive === true
        const isFinal = card.kind === 'assistant' && cfg.includeAssistant !== false
        if (!proactive && !isFinal && card.kind !== 'error') return
        const md = mdForCard(card)
        if (!md.trim()) return
        void post(md).catch((err) => log.warn(`wecom push failed: ${(err as Error).message}`))
      })
    },
    async stop() {
      connected = false
    },
    status() {
      // stateless webhook — report configured, live-checked on first push
      return { connected }
    },
    async send(_chatId, _card) {
      throw new Error('use cardBus.publish for wecom outbound')
    },
    onMessage(_h) {
      // push-only: WeCom app callbacks need a public URL (not wired in v1)
    },
    onCommand() { },
    onButtonClick() { },
  }
  void posts
  void messageHandler
  return transport
}
