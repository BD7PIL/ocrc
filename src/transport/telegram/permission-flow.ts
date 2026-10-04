// permission-flow.ts — P2b-M3: the grinev interaction-mutex permission flow
// on ocrc's plugin event feed. Managers are the ported grinev classes (kept
// UI-agnostic); this module is the only place that touches Telegram.
//
// Semantics ported (grinev UX 对照表 items 1+2):
//  - equivalent requests merge behind ONE message (signature = sessionID +
//    permission + sorted patterns); the visible prompt re-renders with the
//    grouped count and one reply fans out to every grouped requestID
//  - interaction mutex: permission/question/rename share one slot; a second
//    kind parks in the waiting room and is released when the slot clears
//  - generation counter invalidates stale prompts (代数失效)
//  - permission.replied from another surface (TUI/web) cleans up the visible
//    prompt (外部已答清理)

import type { Context } from 'grammy'
import { InlineKeyboard } from 'grammy'
import { createLogger } from '../../utils/logger.js'
import { t } from './i18n/index.js'
import { InteractionManager } from './managers/interaction-manager.js'
import { PermissionManager } from './managers/permission-manager.js'
import type { PermissionRequest } from './types/permission.js'

const log = createLogger('perm-flow')

// Locale-independent tool emoji; the surrounding text comes from i18n.
const ALLOWED_COMMAND_EMOJI: Record<string, string> = {
  bash: '⚡', edit: '✏️', write: '📝', read: '📖', webfetch: '🌐',
  websearch: '🔍', glob: '📁', grep: '🔎', list: '📂', task: '⚙️',
  lsp: '🔧', external_directory: '📁',
}

function resolvedLabel(decision?: string): string {
  if (decision === 'once') return t('permission.reply.once')
  if (decision === 'always') return t('permission.reply.always')
  if (decision === 'reject') return t('permission.reply.reject')
  return t('permission.flow.resolved_default')
}

export interface PermissionFlowDeps {
  interactionManager: InteractionManager
  permissionManager: PermissionManager
  /** Reply a decision to opencode (fan-out handled by the caller mapping). */
  resolve: (requestIds: string[], decision: 'once' | 'always' | 'reject') => Promise<void>
  /** Look up the full sessionID for a permission request (ocrc normalizes ids). */
  sessionIdOf: (request: PermissionRequest) => string
}

function formatPermissionText(request: PermissionRequest, groupedCount = 1): string {
  const emoji = ALLOWED_COMMAND_EMOJI[request.permission] ?? '🔐'
  let text = t('permission.flow.header', { emoji, name: request.permission })
  for (const pattern of request.patterns) {
    text += `\n• ${pattern}`
  }
  if (groupedCount > 1) {
    text += t('permission.flow.grouped_count', { count: groupedCount - 1 })
  }
  return text
}

function buildPermissionKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard()
  kb.text(t('permission.button.allow'), 'permission:once').row()
  kb.text(t('permission.button.always'), 'permission:always').row()
  kb.text(t('permission.button.reject'), 'permission:reject')
  return kb
}

export class PermissionFlow {
  constructor(
    private readonly deps: PermissionFlowDeps,
    private readonly chatId: string,
  ) {}

  /**
   * Present (or merge) a permission request from the plugin event feed.
   * `request` must already carry the FULL (normalized) session id.
   */
  async present(bot: Context['api'], request: PermissionRequest): Promise<void> {
    const { interactionManager, permissionManager } = this.deps
    const generation = permissionManager.getGeneration()

    // Merge behind an existing visible prompt when the signature matches.
    const grouped = permissionManager.addEquivalentRequest(request, generation)
    if (grouped) {
      await bot
        .editMessageText(
          this.chatId,
          grouped.messageId,
          formatPermissionText(grouped.request, grouped.count),
          { reply_markup: buildPermissionKeyboard() },
        )
        .catch((err) => log.warn('grouped re-render failed', (err as Error).message))
      this.syncInteractionState({ requestID: request.id, messageId: grouped.messageId, groupedCount: grouped.count })
      return
    }

    const text = formatPermissionText(request)
    try {
      const message = await bot.sendMessage(this.chatId, text, { reply_markup: buildPermissionKeyboard() })
      const result = permissionManager.startPermission(request, message.message_id, generation)
      if (result !== 'started') {
        // A question held the slot while this was sending: park it and remove
        // the just-sent message (grinev: waitPermission + cleanup).
        if (result === 'question_active') interactionManager.waitPermission(request)
        await bot.deleteMessage(this.chatId, message.message_id).catch(() => {})
        return
      }
      this.syncInteractionState({ requestID: request.id, messageId: message.message_id })
      log.info(`permission prompt shown id=${request.id} perm=${request.permission}`)
    } catch (err) {
      log.error('failed to present permission prompt', err as Error)
    }
  }

  /**
   * Handle a permission button press (permission:once|always|reject). Fan-out:
   * every opencode requestID grouped behind this message gets the decision.
   */
  async onDecision(ctx: Context, decision: 'once' | 'always' | 'reject'): Promise<void> {
    log.info(`permission decision received: ${decision}`)
    const { interactionManager, permissionManager, resolve } = this.deps
    const msg = ctx.callbackQuery?.message
    const messageId = msg?.message_id ?? null
    const requestIds = permissionManager.getRequestIDs(messageId)
    if (requestIds.length === 0) {
      await ctx.answerCallbackQuery(t('permission.flow.already_handled'))
      return
    }

    try {
      await resolve(requestIds, decision)
    } catch (err) {
      log.error('resolvePermission fan-out failed', err as Error)
      await ctx.answerCallbackQuery(t('permission.flow.processing_failed')).catch(() => {})
      return
    }

    // Mark every grouped request resolved (drops waiting-room entries + state).
    for (const id of requestIds) permissionManager.resolveRequest(id)

    const label = resolvedLabel(decision)
    const extra = requestIds.length > 1 ? t('permission.flow.multi_count', { count: requestIds.length }) : ''
    await ctx.editMessageText(`${label}${extra}`).catch((err) => log.warn('decision edit failed', (err as Error).message))
    await ctx.answerCallbackQuery(label)

    this.syncInteractionState({ lastDecision: decision })
    void interactionManager
  }

  /** permission.replied arrived from another surface — clean up the prompt. */
  async onExternalReply(bot: Context['api'], permissionId: string, response?: string): Promise<void> {
    const { permissionManager } = this.deps
    // resolveRequest removes every message tracking this request and returns
    // the removed message ids (grinev 外部已答清理).
    const removed = permissionManager.resolveRequest(permissionId)
    if (removed.length === 0) return
    const label = resolvedLabel(response)
    for (const messageId of removed) {
      await bot.editMessageText(this.chatId, messageId, `${label} ${t('permission.flow.from_tui')}`).catch(() => {})
    }
    this.syncInteractionState({ externalReply: permissionId })
  }

  /** Reset on session switch / startup (grinev: resetInteractions). */
  reset(reason: string): void {
    this.deps.interactionManager.reset(reason)
  }

  private syncInteractionState(metadata: Record<string, unknown>): void {
    const { interactionManager, permissionManager } = this.deps
    const pendingCount = permissionManager.getPendingCount()
    if (pendingCount === 0) {
      if (interactionManager.getSnapshot()?.kind === 'permission') {
        interactionManager.clear('permission_no_pending_requests')
      }
      return
    }
    interactionManager.transition({ expectedInput: 'callback', metadata: { pendingCount, ...metadata } })
  }
}
