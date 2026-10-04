// streaming-render.ts — bridges ocrc's card flow into the ported grinev
// render/streaming pipeline (P2b-M2).
//
// Flow per turn:
//   thinking card   → nothing (the stream message itself is the placeholder)
//   streaming cards → renderMarkdown → blocks → ResponseStreamer.enqueue
//                     (progressive throttle 1s→2s→5s→10s edits one message)
//   assistant card  → streamer.complete (flush + finalize in place)
//                     → tools footer appended as a separate message
//   error card      → plain error message
//
// Degradation is inherited from the ported layers: blocks → escaped MarkdownV2
// → plain text on parse failures, per-part and per-edit.

import type { Api } from 'grammy'
import { createLogger } from '../../utils/logger.js'
import { renderTelegramParts } from './render/pipeline.js'
import { getTelegramRenderedPartSignature } from './render/part-signature.js'
import type { TelegramRenderedPart } from './render/types.js'
import { ResponseStreamer, type StreamingMessagePayload } from './streaming/response-streamer.js'
import { getSessionStreamThrottleMs, resetStreamThrottle } from './streaming/stream-throttle.js'
import type { ContentBlock, AssistantMeta } from '../../core/structured-card.js'

const log = createLogger('tg-stream')

/** Tools/footer summary appended after the streamed answer finalizes. */
function toolsSummary(tools: Array<{ tool: string; args?: string; status?: string }>): string {
  if (tools.length === 0) return ''
  const running = tools.filter((t) => t.status === 'running')
  const shown = tools.slice(0, 7).map((t) => `• ${t.tool}${t.args ? `: ${t.args.slice(0, 60)}` : ''}`)
  if (tools.length > 7) shown.push(`… +${tools.length - 7} more`)
  return ['<b>Tools</b>', ...shown].join('\n')
}

function metaFooter(meta?: AssistantMeta): string {
  if (!meta) return ''
  const bits: string[] = []
  if (meta.agent) bits.push(meta.agent)
  if (meta.model) bits.push(meta.model)
  if (meta.tokens) bits.push(`↑${meta.tokens.input} ↓${meta.tokens.output}`)
  if (meta.cost !== undefined) bits.push(`$${meta.cost.toFixed(3)}`)
  return bits.length ? `<i>${bits.join(' · ')}</i>` : ''
}

export interface StreamingRenderDeps {
  api: Api
  chatId: string
  /** M9 回复粒度: standard hides the tool-call footer, detailed shows it. */
  granularity?: () => 'standard' | 'detailed'
}

interface TurnState {
  /** opencode assistant message id driving the stream key. */
  streamKey: string | null
  /** Telegram message ids produced by the completed stream. */
  finalMessageIds: number[]
}

/** Reject after ms — TG API calls must never hang the stream/task chain. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} timeout (${ms}ms)`)), ms)),
  ])
}

function isNotModified(err: unknown): boolean {
  const m = (err as Error)?.message ?? ''
  return m.includes('message is not modified')
}

export class StreamingRenderer {
  private readonly api: Api
  private readonly chatId: string
  private readonly granularity?: () => 'standard' | 'detailed'
  private readonly streamer: ResponseStreamer
  private readonly turns = new Map<string, TurnState>()

  constructor(deps: StreamingRenderDeps) {
    this.api = deps.api
    this.chatId = deps.chatId
    this.granularity = deps.granularity
    this.streamer = new ResponseStreamer({
      // Progressive: 1s for the first minute, then 2s/5s/10s — protects the
      // edit budget on long generations (ported as-is from grinev).
      throttleMs: (sessionId) => getSessionStreamThrottleMs(sessionId),
      sendPart: async (part, _options, sessionId) => {
        const messageId = await this.deliverPart(part)
        log.info(`[${sessionId}] stream part sent: msg=${messageId} source=${part.source}`)
        // The signature MUST describe what was actually delivered — a native
        // part delivers its blocks, a plain part its fallbackText. Returning
        // anything else makes the streamer's unchanged-edit skip dead.
        return { messageId, deliveredSignature: getTelegramRenderedPartSignature(part) }
      },
      editPart: async (messageId, part, _options, sessionId) => {
        try {
          await this.redeliverPart(messageId, part)
        } catch (err) {
          // "message is not modified" = identical content — a success by
          // definition, NOT a broken stream (grinev treats it the same).
          if (isNotModified(err)) return { deliveredSignature: getTelegramRenderedPartSignature(part) }
          throw err
        }
        return { deliveredSignature: getTelegramRenderedPartSignature(part) }
      },
      deleteText: async (messageId) => {
        await this.api.deleteMessage(this.chatId, messageId).catch(() => {})
      },
    })
  }

  /**
   * Send one rendered part: native rich blocks via sendRichMessage when the
   * part carries them (the ported pipeline's primary output), else plain text
   * with optional entities. A native failure THROWS — the streamer's
   * plainOnly degradation then re-chunks the whole payload as plain text and
   * continues (single failure degrades one message, not the transport).
   */
  private async deliverPart(part: TelegramRenderedPart): Promise<number> {
    if (part.blocks.length > 0) {
      const res = await withTimeout(
        this.api.sendRichMessage(this.chatId, { blocks: part.blocks } as any),
        15000,
        'sendRichMessage',
      )
      return res.message_id
    }
    const plainOptions: Record<string, unknown> = {
      parse_mode: undefined,
      link_preview_options: { is_disabled: true },
    }
    if (part.entities?.length) plainOptions.entities = part.entities
    const sent = await withTimeout(
      this.api.sendMessage(this.chatId, part.fallbackText, plainOptions as any),
      15000,
      'sendMessage',
    )
    return sent.message_id
  }

  private async redeliverPart(messageId: number, part: TelegramRenderedPart): Promise<void> {
    if (part.blocks.length > 0) {
      await withTimeout(
        this.api.editMessageText(this.chatId, messageId, { blocks: part.blocks } as any, {
          link_preview_options: { is_disabled: true },
        } as any),
        15000,
        'editMessageRich',
      )
      return
    }
    const plainOptions: Record<string, unknown> = {
      parse_mode: undefined,
      link_preview_options: { is_disabled: true },
    }
    if (part.entities?.length) plainOptions.entities = part.entities
    await withTimeout(
      this.api.editMessageText(this.chatId, messageId, part.fallbackText, plainOptions as any),
      15000,
      'editMessageText',
    )
  }

  /** Build a StreamingMessagePayload from accumulated assistant text. */
  private payloadFor(text: string): StreamingMessagePayload {
    const parts: TelegramRenderedPart[] = renderTelegramParts(text)
    return { parts }
  }

  /** A streaming delta batch arrived (already coalesced upstream). */
  onStreaming(sessionId: string, messageId: string | undefined, text: string): void {
    if (!text.trim()) return
    const key = messageId ?? `${sessionId}-live`
    let turn = this.turns.get(sessionId)
    if (!turn) {
      turn = { streamKey: key, finalMessageIds: [] }
      this.turns.set(sessionId, turn)
    }
    turn.streamKey = key
    // NOTE: do NOT reset the throttle per card — cards arrive continuously;
    // resetting here would pin the interval at 1s forever. The stream starts
    // at 1s and progresses via getSessionStreamThrottleMs.
    const parts = this.payloadFor(text).parts
    log.info(`[stream] enqueue sid=${sessionId.slice(-8)} key=${key} textLen=${text.length} parts=${parts.length} part0len=${parts[0]?.fallbackText.length ?? 0}`)
    this.streamer.enqueue(sessionId, key, { parts })
  }

  /** The turn finalized: flush the stream in place, then append tools/meta.
      `actions` (optional) is attached as the inline keyboard on the final
      message — the regenerate/suggestion action bar (P2c parity). */
  async onFinalize(
    sessionId: string,
    blocks: ContentBlock[],
    meta?: AssistantMeta,
    actions?: { text: string; keyboard: unknown },
  ): Promise<void> {
    const turn = this.turns.get(sessionId)
    const text = blocks
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text?: string }).text ?? '')
      .join('\n')

    let streamedIds: number[] = []
    if (turn?.streamKey) {
      log.info(`[${sessionId.slice(-8)}] complete: key=${turn.streamKey} textLen=${text.length}`)
      try {
        const res = await this.streamer.complete(sessionId, turn.streamKey, this.payloadFor(text))
        streamedIds = res.telegramMessageIds
        log.info(`[${sessionId.slice(-8)}] complete result: streamed=${res.streamed} ids=${streamedIds.length}`)
      } catch (err) {
        log.warn(`[${sessionId}] stream complete failed, falling back to final send`, (err as Error).message)
      }
    } else {
      log.info(`[${sessionId.slice(-8)}] finalize with no stream state (turn=${!!turn})`)
    }

    // No visible partials (short answer, or stream broken) → send the final
    // text directly with the classic chunking path — ALL parts, or long
    // finals would lose everything past the first chunk.
    if (streamedIds.length === 0 && text.trim()) {
      const parts = renderTelegramParts(text)
      for (const part of parts) {
        streamedIds.push(await this.deliverPart(part))
      }
    }

    // Tools + meta footer as a separate small message (grinev uses a footer line).
    // M9 granularity: 'standard' hides the tool-call process (ZCode 标准回复).
    const tools = this.granularity?.() === 'standard'
      ? []
      : blocks.filter((b) => b.type === 'tool') as Array<{ tool?: string; args?: string; status?: string }>
    const footer = [toolsSummary(tools as any), metaFooter(meta)].filter(Boolean).join('\n')
    if (footer.trim()) {
      await this.api.sendMessage(this.chatId, footer, { parse_mode: 'HTML' }).catch((err) => {
        log.warn(`[${sessionId}] footer send failed`, (err as Error).message)
      })
    }

    // Action bar on the final message (regenerate etc.).
    if (actions && streamedIds.length > 0) {
      await this.api
        .editMessageReplyMarkup(this.chatId, streamedIds[streamedIds.length - 1], { reply_markup: actions.keyboard } as any)
        .catch((err: Error) => log.warn(`[${sessionId}] action bar failed`, err.message))
    }

    this.turns.delete(sessionId)
    resetStreamThrottle(sessionId)
  }

  /** Error card: stop any stream, surface the error plainly. */
  async onError(sessionId: string, message: string): Promise<void> {
    const turn = this.turns.get(sessionId)
    if (turn?.streamKey) {
      await this.streamer.complete(sessionId, turn.streamKey).catch(() => {})
    }
    this.turns.delete(sessionId)
    resetStreamThrottle(sessionId)
    await this.api.sendMessage(this.chatId, `❌ ${message.slice(0, 500)}`).catch(() => {})
  }
}
