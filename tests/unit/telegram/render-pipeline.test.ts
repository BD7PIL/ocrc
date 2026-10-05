import { describe, it, expect } from 'vitest'
import { renderTelegramParts } from '../../../src/transport/telegram/render/pipeline.js'

// Contract reconciliation between the render pipeline's output and the
// Telegram Bot API rich-message types (grammy @grammyjs/types rich.d.ts):
// every emitted block must be a valid InputRichBlock — the API rejects the
// whole message otherwise and the stream would silently degrade to plain.
const SAMPLE = [
  '# 修复总结',
  '',
  '问题在 `reconnect()` 被**双重触发**，[文档](https://example.com)有说明。',
  '',
  '```ts',
  'function onPongTimeout() {',
  '  ws?.close()',
  '}',
  '```',
  '',
  '| 文件 | 状态 |',
  '| --- | --- |',
  '| a.ts | done |',
  '',
  '- 第一项',
  '- 第二项',
  '',
  '> 引用一行',
  '',
  '---',
  '',
  Array.from({ length: 600 }, (_, i) => `para ${i}`).join('\n\n'),
].join('\n\n')
// NOTE: the table's three lines must stay contiguous (single '\n'), so splice
// them in after the join — a GFM table breaks apart across blank lines.
const SAMPLE_DOC = SAMPLE.replace(
  '| 文件 | 状态 |\n\n| --- | --- |\n\n| a.ts | done |',
  '| 文件 | 状态 |\n| --- | --- |\n| a.ts | done |',
)

describe('render pipeline ↔ Bot API rich-message contract', () => {
  const parts = renderTelegramParts(SAMPLE_DOC)

  it('produces parts with native blocks AND a non-empty plain fallback each', () => {
    expect(parts.length).toBeGreaterThan(1) // 600 paras exceed the 480-block budget
    for (const p of parts) {
      if (p.source === 'blocks') expect(p.blocks.length).toBeGreaterThan(0)
      expect(p.fallbackText.length).toBeGreaterThan(0)
    }
  })

  it('heading → {type:"heading", size 1-6} (InputRichBlockSectionHeading)', () => {
    const all = parts.flatMap((p) => p.blocks)
    const h = all.find((b) => b.type === 'heading') as any
    expect(h.text).toContain('修复总结')
    expect(h.size).toBeGreaterThanOrEqual(1)
    expect(h.size).toBeLessThanOrEqual(6)
  })

  it('inline bold/code/link → RichText variants', () => {
    const all = parts.flatMap((p) => p.blocks)
    const para = all.find((b) => b.type === 'paragraph' && JSON.stringify(b.text).includes('双重触发')) as any
    const segs = para.text.filter((s: any) => typeof s === 'object')
    expect(segs.some((s: any) => s.type === 'bold' && s.text === '双重触发')).toBe(true)
    expect(segs.some((s: any) => s.type === 'code' && s.text === 'reconnect()')).toBe(true)
    expect(segs.some((s: any) => s.type === 'url' && s.url === 'https://example.com')).toBe(true)
  })

  it('fenced code → {type:"pre", language:"ts"} with verbatim text', () => {
    const all = parts.flatMap((p) => p.blocks)
    const pre = all.find((b) => b.type === 'pre') as any
    expect(pre.language).toBe('ts')
    expect(pre.text).toContain('onPongTimeout')
  })

  it('table → {type:"table", cells, is_bordered:true} with header row', () => {
    const all = parts.flatMap((p) => p.blocks)
    const t = all.find((b) => b.type === 'table') as any
    expect(t.is_bordered).toBe(true)
    expect(t.cells[0][0].is_header).toBe(true)
    expect(t.cells[1][1].text).toContain('done')
  })

  it('list → {type:"list", items:[{blocks}]}; quote → blockquote; rule → divider', () => {
    const all = parts.flatMap((p) => p.blocks)
    const list = all.find((b) => b.type === 'list') as any
    expect(list.items).toHaveLength(2)
    expect(list.items[0].blocks[0].type).toBe('paragraph')
    const q = all.find((b) => b.type === 'blockquote') as any
    expect(q.blocks.length).toBeGreaterThan(0)
    expect(all.some((b) => b.type === 'divider')).toBe(true)
  })

  it('fallback text is the plain projection of the same content', () => {
    const first = parts[0]
    expect(first.fallbackText).toContain('修复总结')
    expect(first.fallbackText).toContain('onPongTimeout')
  })
})
