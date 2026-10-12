// B4 CSP 单测（批次 3）：内联脚本哈希抽取、策略组装、模式解析。
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { buildCspPolicy, cspHeaderName, cspModeFromEnv, injectNonce, inlineScriptHashes, makeNonce } from '../../../src/transport/web/csp.js'

const HTML = `<!DOCTYPE html><html><head>
<script>
  var t = localStorage.getItem('ocrc-theme')
</script>
<script type="module" src="/assets/index-abc.js"></script>
</head><body><div id="root"></div></body></html>`

describe('inlineScriptHashes', () => {
  it('只取无 src 的内联脚本，哈希 = 脚本体内容的 sha256', () => {
    const hashes = inlineScriptHashes(HTML)
    expect(hashes).toHaveLength(1)
    const body = `\n  var t = localStorage.getItem('ocrc-theme')\n`
    expect(hashes[0]).toBe(`'sha256-${createHash('sha256').update(body, 'utf-8').digest('base64')}'`)
  })

  it('空内联脚本不算（避免发一个无用哈希）', () => {
    expect(inlineScriptHashes('<script></script><script>  </script>')).toHaveLength(0)
  })
})

describe('buildCspPolicy', () => {
  const policy = buildCspPolicy(HTML)

  it('脚本面：哈希 + strict-dynamic（Vite chunk 图由已放行脚本动态加载）', () => {
    expect(policy).toContain("'strict-dynamic'")
    expect(policy).toMatch(/script-src 'self' 'sha256-[^']+' 'strict-dynamic'/)
  })

  it('硬化面：object-src none / base-uri self / frame-ancestors self', () => {
    expect(policy).toContain("object-src 'none'")
    expect(policy).toContain("base-uri 'self'")
    expect(policy).toContain("frame-ancestors 'self'")
  })

  it('如实取舍：style-src 需 unsafe-inline（shiki/KaTeX/mermaid 的 style 属性），connect-src 放 ws', () => {
    expect(policy).toContain("style-src 'self' 'unsafe-inline'")
    expect(policy).toContain('ws:')
    expect(policy).toContain('wss:')
  })
})

describe('nonce 注入（enforce 必需）', () => {
  it('给所有 <script> 打 nonce（含外链入口脚本），幂等', () => {
    const nonce = 'abc123'
    const once = injectNonce(HTML, nonce)
    expect(once.match(/nonce="abc123"/g)?.length).toBe(2) // 内联 + 外链入口
    expect(injectNonce(once, nonce).match(/nonce="abc123"/g)?.length).toBe(2) // 不重复注入
  })

  it('策略带 nonce 时放行入口脚本所需的 eval/wasm 面', () => {
    const policy = buildCspPolicy(HTML, 'abc123')
    expect(policy).toContain("'nonce-abc123'")
    expect(policy).toContain("'strict-dynamic'")
    expect(policy).toContain("'unsafe-eval'")
    expect(policy).toContain("'wasm-unsafe-eval'")
  })

  it('nonce 每次生成都不同（每响应一枚）', () => {
    expect(makeNonce()).not.toBe(makeNonce())
    expect(makeNonce().length).toBeGreaterThan(10)
  })
})

describe('模式解析与头名', () => {
  it('默认 enforce（两步走完：Report-Only 收集 → 补 nonce/eval → 强制实测 0 违规）', () => {
    expect(cspModeFromEnv(undefined)).toBe('enforce')
    expect(cspModeFromEnv('')).toBe('enforce')
    expect(cspModeFromEnv('whatever')).toBe('enforce')
    expect(cspModeFromEnv('report')).toBe('report')
  })

  it('显式三态', () => {
    expect(cspModeFromEnv('off')).toBe('off')
    expect(cspModeFromEnv('0')).toBe('off')
    expect(cspModeFromEnv('enforce')).toBe('enforce')
    expect(cspModeFromEnv('ON')).toBe('enforce')
  })

  it('头名映射：off 不发头', () => {
    expect(cspHeaderName('report')).toBe('Content-Security-Policy-Report-Only')
    expect(cspHeaderName('enforce')).toBe('Content-Security-Policy')
    expect(cspHeaderName('off')).toBeNull()
  })
})
