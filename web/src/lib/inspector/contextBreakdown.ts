// src/lib/inspector/contextBreakdown.ts — client-side context category
// estimation, the same approach as opencode's own web "上下文细分": the API
// exposes only per-message token totals (input/output/cache), no categories —
// their UI buckets message parts by role/type with a chars→tokens heuristic
// and books the remainder (system prompt, tool schemas, tool outputs) as
// "其他". We do the same over our feed cards. Labeled 估算 in the UI.

export interface BreakdownSegment {
  key: string
  tokens: number
  color: string
}

export interface ContextBreakdown {
  segments: BreakdownSegment[]
  /** tokens we could attribute to feed content (excludes 其他) */
  accounted: number
  used: number
}

const COLORS = {
  user: 'var(--info)',
  assistant: 'var(--accent)',
  tool: 'var(--ok)',
  other: 'var(--border)',
}

/** Conservative chars→tokens: CJK chars carry ~0.6 tokens each, other
 *  script ~0.25 (≈4 chars/token). Deliberately undercounts — the remainder
 *  belongs to 其他, not to the visible buckets. */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    if (c >= 0x2e80) cjk++
  }
  const other = text.length - cjk
  return Math.round(cjk * 0.6 + other * 0.25)
}

export function contextBreakdown(
  cards: Array<Record<string, any>>,
  used: number,
): ContextBreakdown {
  let user = 0
  let assistant = 0
  let tool = 0
  for (const c of cards) {
    if (c.kind === 'user') {
      user += estimateTokens(String(c.text ?? ''))
    } else if (c.kind === 'assistant') {
      for (const b of (c.blocks ?? []) as Array<any>) {
        if (b.type === 'text') assistant += estimateTokens(String(b.text ?? ''))
        else if (b.type === 'tool') tool += estimateTokens(String(b.args ?? ''))
      }
    }
  }
  const accounted = user + assistant + tool
  // The residual (system prompt, tool schemas, tool outputs, chat overhead)
  // is exactly what opencode's UI books as 其他 — keep it clamped ≥ 0.
  const other = Math.max(0, used - accounted)
  const segments: BreakdownSegment[] = [
    { key: '用户', tokens: user, color: COLORS.user },
    { key: '助手', tokens: assistant, color: COLORS.assistant },
    { key: '工具调用', tokens: tool, color: COLORS.tool },
  ]
  if (other > 0) segments.push({ key: '其他', tokens: other, color: COLORS.other })
  return { segments: segments.filter((s) => s.tokens > 0), accounted, used }
}
