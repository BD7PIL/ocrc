import { describe, it, expect } from 'vitest'
import { contextBreakdown, estimateTokens } from './contextBreakdown.js'

describe('contextBreakdown', () => {
  it('estimates CJK heavier than latin', () => {
    const cjk = estimateTokens('上下文细分测试') // 7 CJK chars
    const latin = estimateTokens('abcdefghij') // 10 latin chars
    expect(cjk).toBeGreaterThan(3)
    expect(latin).toBeLessThanOrEqual(3)
  })

  it('buckets cards by role/type and books the residual as 其他', () => {
    const cards = [
      { kind: 'user', text: 'hello' },
      { kind: 'assistant', blocks: [{ type: 'text', text: 'world' }, { type: 'tool', args: 'ls -la' }] },
    ]
    const r = contextBreakdown(cards, 100_000)
    const keys = r.segments.map((s) => s.key)
    expect(keys).toContain('用户')
    expect(keys).toContain('助手')
    expect(keys).toContain('工具调用')
    expect(keys).toContain('其他')
    // residual = used - accounted, and it dominates (accounted ≈ a few tokens)
    const other = r.segments.find((s) => s.key === '其他')!
    expect(other.tokens).toBeGreaterThan(99_000)
    expect(r.accounted).toBe(r.segments.filter((s) => s.key !== '其他').reduce((a, s) => a + s.tokens, 0))
  })

  it('omits zero buckets and clamps negative residual', () => {
    const cards = [{ kind: 'user', text: 'hi' }]
    const r = contextBreakdown(cards, 1) // used < accounted → clamp ≥ 0
    expect(r.segments.map((s) => s.key)).toEqual(['用户'])
    expect(r.segments.some((s) => s.key === '其他')).toBe(false)
  })

  it('returns no segments for an empty feed', () => {
    const r = contextBreakdown([], 0)
    expect(r.segments).toEqual([])
    expect(r.accounted).toBe(0)
  })
})
