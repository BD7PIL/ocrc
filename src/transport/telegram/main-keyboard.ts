// main-keyboard.ts — P2b-M4: grinev's persistent reply keyboard on ocrc's
// data sources. Layout: [agent][context] / [model] rows, resized+persistent.
// Button presses are matched by regex in the message router (bot.hears).
// Context numbers come from SessionState/inspector data refreshed by callers.

import { InlineKeyboard, Keyboard } from 'grammy'
import { t } from './i18n/index.js'

export interface MainKeyboardData {
  agentName: string
  modelLabel: string
  /** Token usage: used / limit. Optional — hides the context line when unknown. */
  context?: { used: number; limit: number } | undefined
}

export function agentButtonLabel(name: string): string {
  return `🤖 ${name}`
}

export function modelButtonLabel(modelLabel: string): string {
  return `🧠 ${modelLabel}`
}

/** Auto-scale token counts: 13526 → 13.5K, 1000000 → 1.0M. */
export function fmtK(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return String(n)
}

export function contextButtonLabel(used: number, limit: number): string {
  const pct = limit > 0 ? Math.round((used / limit) * 100) : 0
  return `📊 ${fmtK(used)} / ${fmtK(limit)} (${pct}%)`
}

/** i18n label of the sessions reply-keyboard button. Call per use so the
 *  router's `text === sessionsButtonLabel()` match stays in sync with what
 *  buildMainKeyboard() renders for the active locale. */
export function sessionsButtonLabel(): string {
  return t('keyboard.sessions_button')
}

export function buildMainKeyboard(data: MainKeyboardData): Keyboard {
  const kb = new Keyboard()
  kb.text(agentButtonLabel(data.agentName)).text(
    data.context ? contextButtonLabel(data.context.used, data.context.limit) : '📊 context',
  ).row()
  kb.text(modelButtonLabel(data.modelLabel)).text(sessionsButtonLabel()).resized().persistent()
  return kb
}

// zh-label anchor kept for exact-match consumers of the default locale; the
// live router matches against sessionsButtonLabel() so other locales work too.
export const SESSIONS_BUTTON_TEXT_PATTERN = /^📋 会话$/

/** Button-press patterns for bot.hears routing (grinev message-patterns). */
export const AGENT_BUTTON_TEXT_PATTERN = /^🤖 (.+)$/
export const MODEL_BUTTON_TEXT_PATTERN = /^🧠 (.+)$/
export const CONTEXT_BUTTON_TEXT_PATTERN = /^📊/


