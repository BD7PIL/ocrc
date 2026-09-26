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
import { InteractionManager } from './managers/interaction-manager.js'
import { PermissionManager } from './managers/permission-manager.js'
import type { PermissionRequest } from './types/permission.js'

const log = createLogger('perm-flow')

// zh strings (M5 will move these into the i18n dictionary)
const T = {
  header: (emoji: string, name: string) => `🔐 权限请求：${emoji} ${name}`,
  groupedCount: (count: number) => `\n（另有 ${count - 1} 个相同请求将一并处理）`,
  allowedCommands: {
    bash: '⚡', edit: '✏️', write: '📝', read: '📖', webfetch: '🌐',
    websearch: '🔍', glob: '📁', grep: '🔎', list: '📂', task: '⚙️',
    lsp: '🔧', external_directory: '📁',
  } as Record<string, string>,
  buttons: { once: '✅ 允许一次', always: '🔓 永远允许', reject: '❌ 拒绝' },
  resolved: {
    once: '✅ 已允许（一次）',
    always: '🔓 已永远允许',
    reject: '❌ 已拒绝',
  } as Record<string, string>,
  fromTui: '（由其他界面处理）',
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
  const emoji = T.allowedCommands[request.permission] ?? '🔐'
  let text = T.header(emoji, request.permission)
  for (const pattern of request.patterns) {
    text += `\n• ${pattern}`
  }
  if (groupedCount > 1) {
    text += T.groupedCount(groupedCount)
  }
  return text
}

function buildPermissionKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard()
  kb.text(T.buttons.once, 'permission:once').row()
  kb.text(T.buttons.always, 'permission:always').row()
  kb.text(T.buttons.reject, 'permission:reject')
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
      await ctx.answerCallbackQuery('该请求已被处理')
      return
    }

    try {
      await resolve(requestIds, decision)
    } catch (err) {
      log.error('resolvePermission fan-out failed', err as Error)
      await ctx.answerCallbackQuery('处理失败，请重试').catch(() => {})
      return
    }

    // Mark every grouped request resolved (drops waiting-room entries + state).
    for (const id of requestIds) permissionManager.resolveRequest(id)

    const label = T.resolved[decision]
    const extra = requestIds.length > 1 ? `（${requestIds.length} 个请求）` : ''
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
    const label = T.resolved[response ?? ''] ?? '已处理'
    for (const messageId of removed) {
      await bot.editMessageText(this.chatId, messageId, `${label} ${T.fromTui}`).catch(() => {})
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
