// cards.ts — StructuredCard → Lark interactive-card JSON (pure).
//
// Lark card v1 schema: { config, header:{title, template_color}, elements }.
// The markdown element speaks lark_md (bold/italic/code/links/lists — the
// subset our assistant output uses survives mapping directly). Buttons carry
// a JSON `value` that comes back on `card.action.trigger` — that is the whole
// approval/question interaction channel.

import type { StructuredCard, ContentBlock } from '../../core/structured-card.js'

interface LarkElement {
  tag: string
  [k: string]: unknown
}
export interface LarkCard {
  config?: { wide_screen_mode?: boolean; enable_forward?: boolean }
  header?: { title: { tag: 'plain_text'; content: string }; template_color?: string }
  elements: LarkElement[]
}

function md(content: string): LarkElement {
  return { tag: 'markdown', content }
}
function header(content: string, color?: string): LarkCard['header'] {
  return { title: { tag: 'plain_text', content }, ...(color ? { template_color: color } : {}) }
}
function button(text: string, value: Record<string, unknown>, type: 'primary' | 'default' | 'danger' = 'default'): LarkElement {
  return { tag: 'button', text: { tag: 'plain_text', content: text }, type, value }
}

const TOOL_ICON: Record<string, string> = { running: '⏳', done: '✅', error: '❌' }

/** Render tool blocks into compact markdown lines (the streaming card's tail). */
function toolLines(blocks: Array<{ type: string; tool?: string; args?: string; status?: string }>): string {
  return blocks
    .filter((b) => b.type === 'tool')
    .map((b) => `${TOOL_ICON[b.status ?? 'running'] ?? '⏳'} ${b.tool ?? 'tool'}${b.args ? ` · ${String(b.args).slice(0, 60)}` : ''}`)
    .join('\n')
}

/** One turn's text: text blocks joined; tool state appended as a compact list. */
function turnMarkdown(blocks: ContentBlock[]): string {
  const out: string[] = []
  for (const b of blocks) {
    if (b.type === 'text' && b.text) out.push(b.text)
  }
  const tools = toolLines(blocks)
  if (tools) out.push('', tools)
  return out.join('\n')
}

export function cardToLark(card: StructuredCard): LarkCard {
  switch (card.kind) {
    case 'thinking':
      return { header: header('💭 思考中…', 'blue'), elements: [md('正在准备回复…')] }
    case 'think-stream':
      return { header: header('💭 思考中…', 'blue'), elements: [md(card.thinkingText || '…')] }
    case 'streaming':
    case 'assistant': {
      const live = card.kind === 'streaming'
      const meta = (card as { meta?: { agent?: string; model?: string; cost?: number } }).meta
      const footer: string[] = []
      if (meta?.agent) footer.push(meta.agent)
      if (meta?.model) footer.push(meta.model)
      if (typeof meta?.cost === 'number') footer.push(`$${meta.cost.toFixed(3)}`)
      const elements = [md(turnMarkdown(card.blocks) || '…')]
      if (footer.length) elements.push({ tag: 'hr' }, md(`<font color="grey">${footer.join(' · ')}</font>`))
      return {
        header: header(live ? '⏳ 回复中…' : '✅ 回复', live ? 'blue' : 'green'),
        elements,
      }
    }
    case 'error':
      return { header: header('❌ 出错了', 'red'), elements: [md(String(card.message).slice(0, 4000))] }
    case 'user':
      return { header: header('🙋 你说', 'grey' as never), elements: [md(card.text)] }
    case 'approval': {
      const value = { t: 'perm', sid: card.sessionId, rid: card.requestId }
      return {
        header: header(`🔐 ${card.title}`.slice(0, 60), 'orange'),
        elements: [
          md('```json\n' + JSON.stringify(card.args, null, 2).slice(0, 2000) + '\n```'),
          {
            tag: 'action',
            actions: [
              button('✅ 允许一次', { ...value, d: 'once' }, 'primary'),
              button('🔓 永远允许', { ...value, d: 'always' }),
              button('❌ 拒绝', { ...value, d: 'reject' }, 'danger'),
            ],
          },
        ],
      }
    }
    case 'question': {
      if (card.resolved) {
        return { header: header(card.resolved === 'replied' ? '✅ 已回答' : '❌ 已取消', 'green'), elements: [md('该问题已在其他界面处理。')] }
      }
      const q = card.questions[0]
      if (!q || q.options.length === 0 || q.multiple || q.custom) {
        return { header: header('❓ 需要你回答', 'blue'), elements: [md('该问题需要多选/自定义回答——请在 Web 面板完成。')] }
      }
      const base = { t: 'q', sid: card.sessionId, rid: card.requestId }
      const elements: LarkElement[] = [md(`**${q.question}**`), {
        tag: 'action',
        actions: q.options.slice(0, 8).map((o, i) =>
          button(o.label.slice(0, 20), { ...base, oi: i }, 'default')),
      }]
      elements.push({
        tag: 'action',
        actions: [button('❌ 取消', { ...base, rej: 1 }, 'danger')],
      })
      return { header: header('❓ 需要你确认', 'blue'), elements }
    }
    case 'info':
      return { header: header(card.title, 'turquoise'), elements: card.sections.map((s) => md(s.body)) }
    case 'status':
      return { elements: [md(Object.entries(card.fields).map(([k, v]) => `**${k}**: ${v}`).join('\n'))] }
  }
}

/** Lark message content payload for create/patch — cards travel as JSON strings. */
export function cardContent(card: StructuredCard): string {
  return JSON.stringify(cardToLark(card))
}
