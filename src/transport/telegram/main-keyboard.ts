// main-keyboard.ts — P2b-M4: grinev's persistent reply keyboard on ocrc's
// data sources. Layout: [agent][context] / [model] rows, resized+persistent.
// Button presses are matched by regex in the message router (bot.hears).
// Context numbers come from SessionState/inspector data refreshed by callers.

import { InlineKeyboard, Keyboard } from 'grammy'

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

export function contextButtonLabel(used: number, limit: number): string {
  const pct = limit > 0 ? Math.round((used / limit) * 100) : 0
  return `📊 ${used} / ${limit} (${pct}%)`
}

export function buildMainKeyboard(data: MainKeyboardData): Keyboard {
  const kb = new Keyboard()
  kb.text(agentButtonLabel(data.agentName)).text(
    data.context ? contextButtonLabel(data.context.used, data.context.limit) : '📊 context',
  ).row()
  kb.text(modelButtonLabel(data.modelLabel)).resized().persistent()
  return kb
}

/** Button-press patterns for bot.hears routing (grinev message-patterns). */
export const AGENT_BUTTON_TEXT_PATTERN = /^🤖 (.+)$/
export const MODEL_BUTTON_TEXT_PATTERN = /^🧠 (.+)$/
export const CONTEXT_BUTTON_TEXT_PATTERN = /^📊 [\d,.]+ \/ ([\d,.]+) \((\d+)%\)$/


