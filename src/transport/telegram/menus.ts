// menus.ts — P2b-M4: inline selection menus (sessions paging, agent picker,
// model picker) built on grammY InlineKeyboard + callback_query editing.
// Pattern follows grinev's menus: one message, edited in place, page state
// encoded in callback_data (stateless across restarts).

import type { Api } from 'grammy'
import { InlineKeyboard } from 'grammy'
import { createLogger } from '../../utils/logger.js'
import { esc } from './esc.js'

const log = createLogger('menus')

export interface SessionRow {
  id: string
  title?: string
  directory?: string
  lastActiveAt: number
}

function fmtWhen(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** sessions menu: page N shows PAGE_SIZE rows + prev/next + a session:pick button each. */
export function renderSessionsMenu(
  sessions: SessionRow[],
  page: number,
  activeId?: string,
): { text: string; keyboard: InlineKeyboard } {
  const PAGE = 6
  const pages = Math.max(1, Math.ceil(sessions.length / PAGE))
  const p = Math.min(Math.max(0, page), pages - 1)
  const slice = sessions.slice(p * PAGE, p * PAGE + PAGE)

  const lines: string[] = [`<b>📋 会话</b> · 第 ${p + 1}/${pages} 页 · 共 ${sessions.length}`]
  const kb = new InlineKeyboard()
  for (const s of slice) {
    const mark = s.id === activeId ? '📍 ' : ''
    const when = s.lastActiveAt ? ` · ${fmtWhen(s.lastActiveAt)}` : ''
    const label = `${mark}${(s.title ?? '未命名').slice(0, 28)}${when}`
    // Web C4 parity: per-session delete — the 🗑 arms a confirm step before
    // the actual delete (handled next to the other menu: callbacks).
    kb.text(label, `menu:session:${s.id}`).text('🗑', `menu:sdel:${s.id}`).row()
  }
  if (pages > 1) {
    if (p > 0) kb.text('◀️', `menu:spage:${p - 1}`)
    kb.text(`${p + 1}/${pages}`, 'menu:noop')
    if (p < pages - 1) kb.text('▶️', `menu:spage:${p + 1}`)
  }
  return { text: lines.join('\n'), keyboard: kb }
}

export interface AgentRow {
  name: string
  model?: string
  description?: string
}

/** agents menu: one pick button per configured agent + clear. */
export function renderAgentsMenu(
  agents: AgentRow[],
  currentAgent?: string,
): { text: string; keyboard: InlineKeyboard } {
  const lines = ['<b>🤖 Agent 选择</b>']
  const kb = new InlineKeyboard()
  for (const a of agents) {
    const mark = a.name === currentAgent ? '📍 ' : ''
    kb.text(`${mark}${a.name}`, `menu:agent:${a.name}`).row()
  }
  kb.text('✕ 清除覆盖', 'menu:agentclear')
  return { text: lines.join('\n'), keyboard: kb }
}

export interface ModelRow {
  providerID: string
  modelID: string
  name?: string
}

/** models menu: grouped by provider, one page per provider, pick per model. */
export function renderModelsMenu(
  providers: Array<{ id: string; models: Array<{ id: string; name?: string }> }>,
  current?: string,
): { text: string; keyboard: InlineKeyboard } {
  const lines = ['<b>🧠 模型选择</b>']
  const kb = new InlineKeyboard()
  for (const p of providers) {
    kb.text(`📂 ${p.id}`, 'menu:noop').row()
    for (const m of p.models.slice(0, 6)) {
      const label = `${m.id === current ? '📍 ' : ''}${p.id}/${m.id}`
      kb.text(label, `menu:model:${p.id}:${m.id}`).row()
    }
  }
  return { text: lines.join('\n'), keyboard: kb }
}

/** Edit a menu message in place; swallow the benign not-modified failure. */
export async function editMenu(
  api: Api,
  chatId: number | string,
  messageId: number,
  text: string,
  keyboard: InlineKeyboard,
): Promise<void> {
  try {
    await api.editMessageText(chatId, messageId, text, { parse_mode: 'HTML', reply_markup: keyboard })
  } catch (err) {
    const m = (err as Error).message ?? ''
    if (!m.includes('message is not modified')) log.warn('editMenu failed', m)
  }
}

/** Escape helper re-exported for menu callers (HTML mode). */
export { esc }
