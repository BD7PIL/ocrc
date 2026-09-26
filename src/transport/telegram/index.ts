import { createHash } from 'node:crypto'
import { Bot, InlineKeyboard, type Api } from 'grammy'
import { errorCodeOf, inlineKeyboard, btn } from './ui.js'
import { isEphemeralSession } from '../../opencode/submit.js'
import type { AgentBackend } from '../../core/agent/backend.js'
import type { IncomingMessage, ChannelCapabilities } from '../../core/types.js'
import type { Transport, TransportStartDeps } from '../interface.js'
import type { SessionState } from '../../core/state.js'
import type { CardBus } from '../../core/card-bus.js'
import { TelegramSessionRenderer } from './renderer.js'
import { StreamingRenderer } from './streaming-render.js'
import { PermissionFlow } from './permission-flow.js'
import { renderSessionsMenu, renderAgentsMenu, renderModelsMenu, editMenu } from './menus.js'
import { InteractionManager } from './managers/interaction-manager.js'
import { PermissionManager } from './managers/permission-manager.js'
import type { PermissionRequest } from './types/permission.js'
import {
  buildMainKeyboard,
  agentButtonLabel,
  modelButtonLabel,
  contextButtonLabel,
  fmtK,
  AGENT_BUTTON_TEXT_PATTERN,
  MODEL_BUTTON_TEXT_PATTERN,
  CONTEXT_BUTTON_TEXT_PATTERN,
} from './main-keyboard.js'
import { registerHandlers } from './handlers.js'
import type { PendingApproval, ApprovalResponse } from './handlers.js'
import { esc } from './esc.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('telegram')

export interface TelegramConfig {
  token: string
  allowedUserIds: number[]
  backend: AgentBackend
  state: SessionState
  /** opencode server base URL (in-process plugin server). */
  baseUrl?: string
  /** Project directory where opencode.json lives. */
  opencodeProject?: string
  /** Telegram chunk soft limit for message pagination (default 3500). */
  tgChunkSoftLimit?: number
}

const CAPS: ChannelCapabilities = {
  edit: true,
  maxMessageLength: 4000,
  buttons: true,
  richText: true,
  streaming: false,
}

/** Extended transport interface with Plugin mode helpers. */
export interface TelegramTransport extends Transport {
  /** Handle a permission event from the Plugin event hook (Plugin mode). */
  handlePluginPermissionEvent(event: { type: string; properties: any }): Promise<void>
}

export function createTelegramTransport(cfg: TelegramConfig, injected?: { bot?: Bot }): TelegramTransport {
  // DI seam for tests: a recording bot object can be injected instead of a
  // real Bot (whose Api has no spy-able prototype in grammY 1.46+).
  const bot = injected?.bot ?? new Bot(cfg.token)

  // Whitelist middleware — silently drop strangers. Replying "Unauthorized"
  // would confirm to anyone that this bot exists and is access-controlled.
  bot.use(async (ctx, next) => {
    if (!cfg.allowedUserIds.includes(ctx.from?.id ?? -1)) {
      if (ctx.from) log.warn(`rejected from ${ctx.from.id}`)
      return
    }
    await next()
  })

  let messageHandler: ((msg: IncomingMessage) => Promise<void>) | undefined
  // "Generating" is derived from the relay's per-session abort registry, not a
  // local flag. The relay returns immediately (the response arrives via the
  // event hook), so a local flag would clear before generation finishes. The
  // registry is set when a run starts and cleared on session.idle/error/abort.
  // The gate is per-session: a busy session must not block input targeted at
  // another (idle) session.
  const fmtK = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n))

  const targetSessionId = (): string | undefined => {
    const raw = cfg.state.getPinnedSessionId() ?? cfg.state.getLastSessionId()
    return raw ? cfg.state.normalizeSessionId(raw) : undefined
  }
  const isGenerating = () => {
    const sid = targetSessionId()
    return sid ? cfg.state.hasActiveGeneration(sid) : false
  }

  /** Abort the in-flight generation for the bot's target session (normalized pinned ?? last). Returns the resolved session id. */
  function abortGeneration(): string | undefined {
    const raw = cfg.state.getPinnedSessionId() ?? cfg.state.getLastSessionId()
    if (!raw) return undefined
    const sid = cfg.state.normalizeSessionId(raw)
    cfg.state.getActiveAbort(sid)?.abort()
    return sid
  }

  // Wire text handler
  bot.use(async (ctx, next) => {
    if (ctx.callbackQuery) return next()
    const m = ctx.message
    if (!m) return next()
    // grammY's Message union keeps `text` optional even after narrowing.
    const text = 'text' in m ? m.text : undefined
    if (!text) return next()
    if (text.startsWith('/')) return next()

    // M4 reply-keyboard presses arrive as plain text — route them HERE, before
    // the relay gate (grinev message-router pattern). Otherwise the button text
    // would be forwarded to the model as if the user had typed it.
    if (AGENT_BUTTON_TEXT_PATTERN.test(text)) {
      await openAgentsMenu(String(ctx.chat?.id ?? ctx.from?.id ?? ''))
      return
    }
    if (MODEL_BUTTON_TEXT_PATTERN.test(text)) {
      await openModelsMenu(String(ctx.chat?.id ?? ctx.from?.id ?? ''))
      return
    }
    if (CONTEXT_BUTTON_TEXT_PATTERN.test(text)) {
      try {
        // Same data source as the Inspector's CONTEXT panel (backend.getContext):
        // used = last turn's input+output+reasoning+cache; max = model context window.
        const target = targetSessionId()
        if (!target) { await ctx.reply('📊 没有活动会话'); return }
        const meta = await cfg.backend.getContext(target)
        const tokens = (meta.tokens ?? {}) as any
        const used = tokens.used ?? 0
        const max = tokens.max ?? 0
        const pct = max > 0 ? Math.round((used / max) * 100) : 0
        let msg = `📊 上下文用量：${fmtK(used)} / ${fmtK(max)} tokens（${pct}%）`
        // Prompt-cache line, same semantics as the web Inspector: hit rate =
        // cache.read / (input + cache.read) for the latest turn.
        const cacheRead = tokens.cache?.read
        const cacheWrite = tokens.cache?.write
        const uncached = tokens.input
        if (typeof cacheRead === 'number' && typeof uncached === 'number' && uncached + cacheRead > 0) {
          const hit = Math.round((cacheRead / (uncached + cacheRead)) * 100)
          msg += `\n💾 缓存命中 ${hit}% · ${fmtK(cacheRead)} read / ${fmtK(cacheWrite ?? 0)} write`
        }
        await ctx.reply(msg)
      } catch {
        await ctx.reply('📊 上下文用量暂不可用')
      }
      return
    }
    if (!messageHandler) return next()

    if (isGenerating()) {
      void ctx.reply('Session is already generating. Wait for it or /abort.').catch((err) => {
        log.warn('failed to send busy notice', (err as Error).message)
      })
      return
    }

    const msg: IncomingMessage = {
      userId: String(ctx.from?.id ?? ''),
      chatId: String(ctx.chat?.id ?? ctx.from?.id ?? ''),
      text,
      messageId: String(m.message_id),
      origin: 'telegram',
    }

    void messageHandler(msg)
  })

  // ── P2b-M3: grinev interaction mutex + permission flow ──
  const interactionManager = new InteractionManager()
  const permissionManager = new PermissionManager(interactionManager)
  let permissionFlow: PermissionFlow | undefined
  /** Latest reply-keyboard payload, refreshed by whoever has fresh data. */
  let keyboardData: { agentName: string; modelLabel: string; context?: { used: number; limit: number } } = {
    agentName: 'opencode',
    modelLabel: 'default',
  }
  // Legacy approval state (fallback path + TTL sweep kept from M1).
  const pendingApprovals = new Map<string, PendingApproval>()
  // Short token → permissionId, so approve:* callback_data stays under
  // Telegram's 64-byte limit (same sha1 pattern as the workspace tokens).
  const approvalTokens = new Map<string, string>()
  const approvalToken = (permId: string) => {
    const t = createHash('sha1').update(`approve:${permId}`).digest('base64url').slice(0, 16)
    approvalTokens.set(t, permId)
    return t
  }

  // Entries are normally removed on click or on the permission.replied event;
  // if that event is lost the entry would leak forever. Sweep expired ones.
  const APPROVAL_TTL_MS = 30 * 60 * 1000
  const approvalSweep = setInterval(() => {
    const now = Date.now()
    for (const [permId, p] of pendingApprovals) {
      if (now - p.createdAt > APPROVAL_TTL_MS) {
        pendingApprovals.delete(permId)
        log.warn(`pending approval ${permId} expired (TTL), dropping`)
      }
    }
    // Tokens whose approval is gone (clicked, replied, expired) are dead weight.
    for (const [t, permId] of approvalTokens) {
      if (!pendingApprovals.has(permId)) approvalTokens.delete(t)
    }
  }, 60_000)
  approvalSweep.unref?.()

  // P2b-M3: grinev permission:* callbacks — the mutex flow owns these.
  bot.callbackQuery(/^permission:(once|always|reject)$/, async (ctx) => {
    const decision = (ctx.match as RegExpMatchArray)[1] as 'once' | 'always' | 'reject'
    if (!permissionFlow) { await ctx.answerCallbackQuery('尚未就绪').catch(() => {}); return }
    await permissionFlow.onDecision(ctx, decision).catch((err) => {
      log.error('permission decision failed', err as Error)
      ctx.answerCallbackQuery('处理失败').catch(() => {})
    })
  })

  // ── M4: inline menus (sessions paging / agents / models) ──
  let sessionsCache: Array<{ id: string; title?: string; directory?: string; lastActiveAt: number }> = []
  let activeMenuMessageId: number | undefined

  bot.callbackQuery(/^menu:spage:(\d+)$/, async (ctx) => {
    const p = Number(ctx.match![1])
    const { text, keyboard } = renderSessionsMenu(sessionsCache, p)
    await editMenu(bot.api, ctx.chat?.id ?? chatIdOf(), (ctx.callbackQuery.message as any)?.message_id, text, keyboard)
    await ctx.answerCallbackQuery()
  })

  bot.callbackQuery(/^menu:session:(.+)$/, async (ctx) => {
    const sid = ctx.match![1]
    cfg.state.setPinnedSessionId(sid)
    await ctx.answerCallbackQuery(`已切换：…${sid.slice(-8)}`)
    try { await ctx.editMessageText(`📍 已切换会话 <code>…${sid.slice(-8)}</code>`, { parse_mode: 'HTML' }) } catch { }
  })

  bot.callbackQuery(/^menu:agent:(.+)$/, async (ctx) => {
    const name = ctx.match![1]
    cfg.state.setNextAgent(name)
    await ctx.answerCallbackQuery(`Agent → ${name}`)
    try { await ctx.editMessageText(`🤖 Agent 覆盖：<b>${name}</b>`, { parse_mode: 'HTML' }) } catch { }
  })

  bot.callbackQuery(/^menu:model:([^:]+):(.+)$/, async (ctx) => {
    const providerID = ctx.match![1]
    const modelID = ctx.match![2]
    cfg.state.setNextModel({ providerID, modelID })
    await ctx.answerCallbackQuery(`模型 → ${providerID}/${modelID}`)
    try { await ctx.editMessageText(`🧠 模型覆盖：<b>${providerID}/${modelID}</b>`, { parse_mode: 'HTML' }) } catch { }
  })

  bot.callbackQuery('menu:agentclear', async (ctx) => {
    cfg.state.setNextAgent(undefined)
    await ctx.answerCallbackQuery('已清除 agent 覆盖')
    try { await ctx.editMessageText('Agent 覆盖已清除', { parse_mode: 'HTML' }) } catch { }
  })

  bot.callbackQuery('menu:noop', async (ctx) => { await ctx.answerCallbackQuery() })

  /** Open the agents menu as an editable message. */
  async function openAgentsMenu(chatId: string): Promise<void> {
    try {
      const agents = await cfg.backend.getAgents(cfg.opencodeProject)
      const current = cfg.state.getNextAgent()
      const { text, keyboard } = renderAgentsMenu(agents.map(a => ({ name: a.name, model: (a as any).model })), current)
      const sent = await bot.api.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard })
      activeMenuMessageId = sent.message_id
    } catch (err) {
      log.warn('openAgentsMenu failed', (err as Error).message)
    }
  }

  /** Open the models menu as an editable message. */
  async function openModelsMenu(chatId: string): Promise<void> {
    try {
      const providers = await cfg.backend.getModels(cfg.opencodeProject)
      const { text, keyboard } = renderModelsMenu(providers)
      const sent = await bot.api.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard })
      activeMenuMessageId = sent.message_id
    } catch (err) {
      log.warn('openModelsMenu failed', (err as Error).message)
    }
  }

  /** Open the paginated sessions menu. */
  async function openSessionsMenu(chatId: string, page: number): Promise<void> {
    try {
      sessionsCache = (await cfg.backend.listSessionSummaries()).map(s => ({
        id: s.id, title: s.title, directory: s.directory, lastActiveAt: s.lastActiveAt,
      }))
      const active = cfg.state.getPinnedSessionId() ?? cfg.state.getLastSessionId()
      const { text, keyboard } = renderSessionsMenu(sessionsCache, page, active)
      const sent = await bot.api.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard })
      activeMenuMessageId = sent.message_id
    } catch (err) {
      log.warn('openSessionsMenu failed', (err as Error).message)
    }
  }

  const chatIdOf = (): string => String(cfg.allowedUserIds[0])

  // ── M4: reply keyboard + hears routers (grinev signature UX) ──
  const sendMainKeyboard = async (ctx: { reply: Function }) => {
    await ctx.reply('键盘已更新', { reply_markup: buildMainKeyboard(keyboardData) }).catch((err: Error) => {
      log.warn('send keyboard failed', (err as Error).message)
    })
  }
  const refreshKeyboardData = async (): Promise<void> => {
    try {
      const target = targetSessionId()
      const meta = target ? await cfg.backend.getContext(target) : undefined
      const agents = cfg.backend.capabilities.catalog ? await cfg.backend.getAgents(cfg.opencodeProject).catch(() => []) : []
      keyboardData = {
        agentName: meta?.agent ?? keyboardData.agentName,
        modelLabel: meta?.model ?? keyboardData.modelLabel,
        context: (meta?.tokens as any)?.used != null && (meta?.tokens as any)?.max
          ? { used: (meta?.tokens as any).used, limit: (meta?.tokens as any).max }
          : keyboardData.context,
      }
      void agents
    } catch { /* keep previous */ }
  }

  // Button presses arrive as ordinary text messages — match by pattern.
  // Register commands + callbacks
  registerHandlers({
    bot,
    backend: cfg.backend,
    baseUrl: cfg.baseUrl ?? '',
    state: cfg.state,
    isGenerating,
    abortGeneration,
    pendingApprovals,
    approvalTokens,
    opencodeProject: cfg.opencodeProject,
  })

  // Error catch-all — grammY wraps handler errors in BotError (err.error).
  bot.catch((err) => {
    const e = (err as { error?: Error }).error ?? (err as unknown as Error)
    log.error('grammY catch-all', e)
    bot.api.sendMessage(String(cfg.allowedUserIds[0]), `Internal error: ${e.message}`).catch(() => {})
  })

  // Per-session renderers. The StreamingRenderer owns thinking/streaming/
  // assistant/error cards (grinev pipeline: live-edited stream message with
  // progressive throttling); the legacy renderer stays for user/info echoes.
  const renderers = new Map<string, TelegramSessionRenderer>()
  let streamingRenderer: StreamingRenderer | undefined

  function getRenderer(sessionId: string, chatId: string): TelegramSessionRenderer {
    let r = renderers.get(sessionId)
    if (!r) {
      r = new TelegramSessionRenderer({ chatId, sessionId, bot: bot.api, chunkSoftLimit: cfg.tgChunkSoftLimit })
      renderers.set(sessionId, r)
    }
    return r
  }

  function labelFor(response?: string): string {
    switch (response) {
      case 'once':   return 'Allowed (once)'
      case 'always': return 'Always Allowed'
      case 'reject': return 'Rejected'
      default:       return response ?? 'Handled'
    }
  }

  let cardBusRef: CardBus | undefined

  return {
    name: 'telegram',
    capabilities: CAPS,
    async start(deps: TransportStartDeps) {
      const { cardBus } = deps
      cardBusRef = cardBus
      const chatId = String(cfg.allowedUserIds[0])
      streamingRenderer = new StreamingRenderer({ api: bot.api, chatId })
      permissionFlow = new PermissionFlow(
        {
          interactionManager,
          permissionManager,
          resolve: async (requestIds, decision) => {
            // All grouped requests share one signature → one session; take the
            // session from the pressed message's request when available.
            for (const requestId of requestIds) {
              const sid = targetSessionId()
              if (!sid) continue
              await cfg.backend.resolvePermission(sid, requestId, decision).catch((err) => {
                log.warn(`resolvePermission failed for ${requestId}`, (err as Error).message)
              })
            }
          },
          sessionIdOf: (r: PermissionRequest) => r.sessionID,
        },
        chatId,
      )

      cardBus.subscribeAll((card) => {
        if (!('sessionId' in card) || !card.sessionId) return
        log.info(`[telegram] card received: kind=${card.kind} sessionId=${card.sessionId}`)
        const sr = streamingRenderer
        if (sr && (card.kind === 'streaming' || card.kind === 'thinking' || card.kind === 'assistant' || card.kind === 'error')) {
          // P2b-M2: grinev streaming pipeline owns the turn lifecycle.
          void (async () => {
            try {
              if (card.kind === 'thinking') return // the stream message is the placeholder
              if (card.kind === 'streaming') {
                const text = card.blocks.filter((b) => b.type === 'text').map((b) => (b as any).text ?? '').join('')
                sr.onStreaming(card.sessionId, (card as any).messageId, text)
                return
              }
              if (card.kind === 'assistant') { await sr.onFinalize(card.sessionId, card.blocks, card.meta); return }
              if (card.kind === 'error') { await sr.onError(card.sessionId, (card as any).message ?? 'error'); return }
            } catch (err) {
              log.error(`[telegram] streaming onCard failed for ${card.kind}`, err as Error)
            }
          })()
          if (card.kind === 'assistant' || card.kind === 'error') renderers.delete(card.sessionId)

          // grinev UX 对照表：后台会话完成通知 —— a turn finished in a session
          // other than the TG-target one gets a heads-up with a switch button.
          if (card.kind === 'assistant' && permissionFlow) {
            const target = targetSessionId()
            if (target && card.sessionId !== target && !isEphemeralSession(card.sessionId)) {
              const bsid = card.sessionId
              const bk = new InlineKeyboard().text('📥 打开该会话', `menu:session:${bsid}`)
              void bot.api
                .sendMessage(chatId, `ℹ️ 后台会话已完成：…${bsid.slice(-8)}`, { reply_markup: bk })
                .catch((err: Error) => log.warn('background notice failed', err.message))
            }
          }
          return
        }
        const r = getRenderer(card.sessionId, chatId)
        r.onCard(card).catch((err) => {
          log.error(`[telegram] onCard failed for ${card.kind}`, err as Error)
        })
        if (card.kind === 'assistant' || card.kind === 'error') {
          renderers.delete(card.sessionId)
        }
      })

      // Deliver the persistent reply keyboard once per boot.
      await refreshKeyboardData().catch(() => {})
      await bot.api
        .sendMessage(chatId, 'ocrc 已就绪', { reply_markup: buildMainKeyboard(keyboardData) })
        .catch((err) => log.warn('boot keyboard send failed', (err as Error).message))

      const MAX_CONFLICT = 8
      const MAX_RETRIES = 10
      while (true) {
        let attempt = 0
        let conflictCount = 0
        for (let retryCount = 0; retryCount < MAX_RETRIES; retryCount++) {
          try {
            await bot.start({ onStart: (me) => log.info(`bot polling as @${me.username}`) })
            log.info('bot polling ended cleanly')
            return
          } catch (err) {
            const code = errorCodeOf(err)
            if (code === 409) {
              if (++conflictCount >= MAX_CONFLICT) {
                log.error('FATAL: Telegram 409 conflict persisted — another instance is polling this bot token; transport stopped')
                throw new Error('Telegram 409 persisted')
              }
              log.warn(`409 #${conflictCount}, releasing stale lock and retrying`)
              try { await bot.stop() } catch { /* bot may not have fully started */ }
              try {
                await bot.api.raw.getUpdates({ offset: -1, timeout: 0, limit: 1 })
              } catch { /* ignore — if this fails the next launch will tell us */ }
              await new Promise((r) => setTimeout(r, 5000))
            } else if (code === 401) {
              log.error('FATAL: bot token invalid or revoked (401) — Telegram transport stopped; fix the token and restart')
              return
            } else {
              attempt += 1
              const delay = Math.min(1000 * 2 ** attempt, 30000)
              log.error(`bot.start failed (attempt ${attempt}/${MAX_RETRIES})`, (err as Error)?.message ?? err)
              await new Promise((r) => setTimeout(r, delay))
            }
          }
        }
        log.warn(`bot.start: exhausted ${MAX_RETRIES} retries, restarting in 60s`)
        await new Promise((r) => setTimeout(r, 60_000))
      }
    },
    async stop() {
      await bot.stop()
      clearInterval(approvalSweep)
    },
    async send(_chatId, _card) {
      throw new Error('Transport.send not implemented for Telegram in v0.5.0')
    },
    onMessage(h) { messageHandler = h },
    onCommand(_name, _h) { /* commands registered via registerHandlers */ },
    onButtonClick(_h) { /* callbacks registered via registerHandlers */ },

    /** Plugin mode: handle permission events from the opencode event hook. */
    async handlePluginPermissionEvent(event: { type: string; properties: any }) {
      const props = event.properties ?? {}

      if (event.type === 'permission.updated' || event.type === 'permission.asked') {
        const permId = props.id as string | undefined
        const title = (props.title as string) ?? (props.permission as string) ?? 'Unknown operation'
        const sessionId = props.sessionID as string | undefined
        if (!permId || !sessionId) {
          log.warn(`Plugin permission: missing id or sessionID`, props)
          return
        }

        // P2b-M3: grinev mutex flow (merge + slot + generation) replaces the
        // plain three-button card. The legacy pendingApprovals/token maps stay
        // wired for the legacy approve:* callbacks (kept for fallback).
        const fullSid = cfg.state.normalizeSessionId(sessionId)
        const request: PermissionRequest = {
          id: permId,
          sessionID: fullSid,
          permission: (props.permission as string) ?? title,
          patterns: (props.patterns as string[]) ?? [],
          metadata: (props.args as Record<string, unknown>) ?? {},
          always: [],
        }
        if (permissionFlow) {
          await permissionFlow.present(bot.api, request)
        } else {
          const escaped = title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          const text = `⚠️  <b>Permission Required</b>\n\n<code>${escaped}</code>`
          const token = approvalToken(permId)
          const keyboard = {
            ...inlineKeyboard([
              [
                btn('✅ Once', `approve:once:${token}`),
                btn('🔓 Always', `approve:always:${token}`),
                btn('❌ Reject', `approve:reject:${token}`),
              ],
            ]),
            parse_mode: 'HTML' as const,
          }
          try {
            const msg = await bot.api.sendMessage(String(cfg.allowedUserIds[0]), text, keyboard)
            pendingApprovals.set(permId, {
              sessionId,
              permissionId: permId,
              messageId: msg.message_id,
              title,
              createdAt: Date.now(),
            })
            log.info(`[plugin] approval card sent permId=${permId}`)
          } catch (err) {
            log.error('[plugin] failed to send approval card', err as Error)
          }
        }

        // Publish to CardBus so Web UI can also show the approval modal
        try {
          cardBusRef?.publish({
            kind: 'approval',
            sessionId: cfg.state.normalizeSessionId(sessionId),
            title,
            args: props.args ?? props.permission ?? {},
            requestId: permId,
          })
        } catch (err) {
          log.warn('[plugin] failed to publish approval card', err as Error)
        }
      }

      if (event.type === 'permission.replied') {
        const permId = (props.permissionID as string) ?? (props.requestID as string)
        const response = (props.response as string) ?? (props.reply as string)
        if (!permId) return

        // P2b-M3: 外部已答清理 via the mutex flow when it owns the prompt.
        if (permissionFlow) {
          await permissionFlow.onExternalReply(bot.api, permId, response).catch((err) => {
            log.warn('external permission cleanup failed', (err as Error).message)
          })
        }

        const p = pendingApprovals.get(permId)
        if (!p) return

        pendingApprovals.delete(permId)
        try {
          const display = labelFor(response)
          await bot.api.editMessageText(
            String(cfg.allowedUserIds[0]),
            p.messageId,
            `${display} (from TUI)\n\n${esc(p.title)}`,
            { parse_mode: 'HTML' },
          )
        } catch (err) {
          log.warn(`[plugin] couldn't update card after TUI reply: ${(err as Error).message}`)
        }
      }
    },
  }
}
