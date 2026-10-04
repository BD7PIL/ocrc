// question-flow.ts — M10: interactive question-tool requests on Telegram.
// The ported grinev QuestionManager stays UI-agnostic and formats answers for
// its own presentation ("* label: description"), which doesn't match opencode's
// API contract (answers: string[][] of raw labels, in question order). This
// module is the ocrc-native flow that talks to Telegram directly, mirroring
// permission-flow's posture: one interaction-mutex slot (kind 'question'),
// one message per question advancing on tap, raw-label answers.
//
// Free-text (custom) answers are web-only in v1: a text-capture interceptor on
// the relay would fight normal chat. Questions that only offer free text get a
// "answer on web" note.

import { InlineKeyboard } from 'grammy'
import type { Context } from 'grammy'
import { createHash } from 'node:crypto'
import { createLogger } from '../../utils/logger.js'
import { t } from './i18n/index.js'
import { InteractionManager } from './managers/interaction-manager.js'
import type { QuestionInfo } from '../../core/agent/backend.js'

const log = createLogger('question-flow')

// Locale-neutral option marker; all surrounding text comes from i18n.
const option = (label: string, selected: boolean) => `${selected ? '✅' : '▫️'} ${label}`

interface PendingQuestion {
  requestId: string
  sessionId: string
  questions: QuestionInfo[]
  index: number
  /** Selected option indexes per question. */
  selected: Set<number>[]
  messageId: number | undefined
  createdAt: number
}

export interface QuestionFlowDeps {
  interactionManager: InteractionManager
  /** Submit ordered answers; result carries `stale` when resolved elsewhere. */
  answer: (sessionId: string, requestId: string, answers: string[][]) =>
    Promise<{ ok: boolean; stale?: boolean } | undefined>
  /** Decline the request; same result semantics. */
  reject: (sessionId: string, requestId: string) =>
    Promise<{ ok: boolean; stale?: boolean } | undefined>
}

const tokenOf = (requestId: string) =>
  createHash('sha1').update(`question:${requestId}`).digest('base64url').slice(0, 16)

export class QuestionFlow {
  /** token → pending entry (callback_data carries only the short token). */
  private readonly pending = new Map<string, PendingQuestion>()
  private sweep: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly deps: QuestionFlowDeps,
    private readonly chatId: string,
  ) {
    const TTL = 30 * 60 * 1000
    this.sweep = setInterval(() => {
      const now = Date.now()
      for (const [tok, entry] of this.pending) {
        if (now - entry.createdAt > TTL) {
          this.pending.delete(tok)
          log.warn(`question ${entry.requestId} expired (TTL), dropping`)
          this.releaseSlot(entry)
        }
      }
    }, 60_000)
    this.sweep.unref?.()
  }

  dispose() { if (this.sweep) clearInterval(this.sweep) }

  /** Present a question.asked request. Owns the mutex slot while visible. */
  async present(bot: Context['api'], request: { requestId: string; sessionId: string; questions: QuestionInfo[] }): Promise<void> {
    const answerable = request.questions.filter((q) => q.options.length > 0)
    if (answerable.length === 0) {
      await bot.sendMessage(this.chatId, t('question.flow.web_only')).catch(() => {})
      return
    }

    // Idempotence guard: the hook and the question SSE could both surface the
    // same request (or a replay after reconnect) — never double-prompt.
    if ([...this.pending.values()].some((e) => e.requestId === request.requestId)) {
      log.info('question already presented; skipping', { requestId: request.requestId })
      return
    }

    const snap = this.deps.interactionManager.getSnapshot()
    if (snap?.kind === 'permission') {
      // v1: no queueing — permissions first, questions answered on web.
      log.info('permission holds the slot; question left to web', { requestId: request.requestId })
      await bot.sendMessage(this.chatId, t('question.flow.slot_busy')).catch(() => {})
      return
    }

    const entry: PendingQuestion = {
      requestId: request.requestId,
      sessionId: request.sessionId,
      questions: answerable,
      index: 0,
      selected: answerable.map(() => new Set<number>()),
      messageId: undefined,
      createdAt: Date.now(),
    }
    const tok = tokenOf(entry.requestId)
    this.pending.set(tok, entry)

    this.deps.interactionManager.start({
      kind: 'question',
      expectedInput: 'callback',
      payload: {
        questions: [],
        currentIndex: 0,
        selectedOptions: new Map(),
        customAnswers: new Map(),
        customInputQuestionIndex: null,
        activeMessageId: null,
        messageIds: [],
        requestID: entry.requestId,
      },
    })

    const text = this.render(entry)
    try {
      const message = await bot.sendMessage(this.chatId, text.text, { reply_markup: text.keyboard })
      entry.messageId = message.message_id
      log.info(`question prompt shown id=${entry.requestId} q=${entry.questions.length}`)
    } catch (err) {
      this.pending.delete(tok)
      this.releaseSlot(entry)
      log.error('failed to present question prompt', err as Error)
    }
  }

  private render(entry: PendingQuestion): { text: string; keyboard: InlineKeyboard } {
    const q = entry.questions[entry.index]
    const total = entry.questions.length
    const kb = new InlineKeyboard()
    const selected = entry.selected[entry.index]
    for (let i = 0; i < q.options.length; i++) {
      const opt = q.options[i]
      kb.text(option(opt.label, selected.has(i)), `q:${tokenOf(entry.requestId)}:o:${i}`).row()
    }
    if (q.multiple) kb.text(t('question.flow.button.submit'), `q:${tokenOf(entry.requestId)}:ok`).row()
    kb.text(t('question.flow.button.reject'), `q:${tokenOf(entry.requestId)}:rej`)
    return {
      text: t('question.flow.header', {
        header: q.header || t('question.flow.default_header'),
        idx: entry.index + 1,
        total,
      }),
      keyboard: kb,
    }
  }

  /** Option tap: single-choice advances immediately; multiple toggles until 提交. */
  async onOption(ctx: Context, tok: string, optionIndex: number): Promise<void> {
    const entry = this.pending.get(tok)
    const q = entry?.questions[entry.index]
    if (!entry || !q || optionIndex >= q.options.length) {
      await ctx.answerCallbackQuery(t('question.flow.stale')).catch(() => {})
      return
    }
    const selected = entry.selected[entry.index]
    if (q.multiple) {
      if (selected.has(optionIndex)) selected.delete(optionIndex)
      else selected.add(optionIndex)
    } else {
      selected.clear()
      selected.add(optionIndex)
    }

    if (!q.multiple) {
      await this.advanceOrSubmit(ctx, tok, entry)
      return
    }
    const text = this.render(entry)
    await ctx.editMessageText(text.text, { reply_markup: text.keyboard }).catch(() => {})
    await ctx.answerCallbackQuery().catch(() => {})
  }

  /** 提交 (multi-choice). */
  async onSubmit(ctx: Context, tok: string): Promise<void> {
    const entry = this.pending.get(tok)
    if (!entry) {
      await ctx.answerCallbackQuery(t('question.flow.stale')).catch(() => {})
      return
    }
    await this.advanceOrSubmit(ctx, tok, entry)
  }

  private async advanceOrSubmit(ctx: Context, tok: string, entry: PendingQuestion): Promise<void> {
    if (entry.index < entry.questions.length - 1) {
      entry.index += 1
      const text = this.render(entry)
      await ctx.editMessageText(text.text, { reply_markup: text.keyboard }).catch(() => {})
      await ctx.answerCallbackQuery().catch(() => {})
      return
    }
    const answers = entry.questions.map((q, qi) => {
      const sel = entry.selected[qi]
      return [...sel].map((i) => q.options[i]?.label).filter((l): l is string => !!l)
    })
    const result = await this.deps.answer(entry.sessionId, entry.requestId, answers).catch((err) => {
      log.error('answerQuestion failed', err as Error)
      return undefined
    })
    await this.finish(ctx, tok, entry, result, t('question.flow.submitted'))
  }

  /** 取消. */
  async onReject(ctx: Context, tok: string): Promise<void> {
    const entry = this.pending.get(tok)
    if (!entry) {
      await ctx.answerCallbackQuery(t('question.flow.stale')).catch(() => {})
      return
    }
    const result = await this.deps.reject(entry.sessionId, entry.requestId).catch((err) => {
      log.error('rejectQuestion failed', err as Error)
      return undefined
    })
    await this.finish(ctx, tok, entry, result, t('question.flow.rejected'))
  }

  private async finish(
    ctx: Context,
    tok: string,
    entry: PendingQuestion,
    result: { ok: boolean; stale?: boolean } | undefined,
    okLabel: string,
  ): Promise<void> {
    if (result === undefined || (!result.ok && !result.stale)) {
      await ctx.answerCallbackQuery(t('question.flow.failed')).catch(() => {})
      return
    }
    const label = result.stale
      ? `${t('question.flow.stale')} ${t('question.flow.from_elsewhere')}`
      : okLabel
    this.pending.delete(tok)
    this.releaseSlot(entry)
    await ctx.editMessageText(label).catch((err) => log.warn('finish edit failed', (err as Error).message))
    await ctx.answerCallbackQuery(label).catch(() => {})
  }

  /** question.replied/rejected arrived from another surface (TUI/web). */
  async onExternal(bot: Context['api'], requestId: string, outcome: 'replied' | 'rejected'): Promise<void> {
    const tok = tokenOf(requestId)
    const entry = this.pending.get(tok)
    if (!entry) return
    this.pending.delete(tok)
    this.releaseSlot(entry)
    const label = outcome === 'replied'
      ? `${t('question.flow.submitted')} ${t('question.flow.from_elsewhere')}`
      : `${t('question.flow.rejected')} ${t('question.flow.from_elsewhere')}`
    if (entry.messageId) {
      await bot.editMessageText(this.chatId, entry.messageId, label).catch(() => {})
    }
  }

  private releaseSlot(entry: PendingQuestion) {
    const snap = this.deps.interactionManager.getSnapshot()
    if (snap?.kind === 'question') {
      this.deps.interactionManager.clearKind('question', 'question_answered')
    }
    void entry
  }
}
