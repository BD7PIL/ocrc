import { createHash } from 'node:crypto'
import { Bot, type Api } from 'grammy'
import { errorCodeOf, inlineKeyboard, btn } from './ui.js'
import type { AgentBackend } from '../../core/agent/backend.js'
import type { IncomingMessage, ChannelCapabilities } from '../../core/types.js'
import type { Transport, TransportStartDeps } from '../interface.js'
import type { SessionState } from '../../core/state.js'
import type { CardBus } from '../../core/card-bus.js'
import { TelegramSessionRenderer } from './renderer.js'
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

  // Plugin-mode approval state
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

  // Per-session renderers
  const renderers = new Map<string, TelegramSessionRenderer>()

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

      cardBus.subscribeAll((card) => {
        if ('sessionId' in card && card.sessionId) {
          const r = getRenderer(card.sessionId, chatId)
          log.info(`[telegram] card received: kind=${card.kind} sessionId=${card.sessionId}`)
          r.onCard(card).catch((err) => {
            log.error(`[telegram] onCard failed for ${card.kind}`, err as Error)
          })
          if (card.kind === 'assistant' || card.kind === 'error') {
            renderers.delete(card.sessionId)
          }
        }
      })

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
