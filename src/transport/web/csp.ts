// src/transport/web/csp.ts — B4 CSP（批次 3，2026-10-12）
//
// 背景（best-of B4 裁决）：内网受控环境把 CSP 头当合规门槛，不是自选加固。
// 落地路径按标准两步走：先 Content-Security-Policy-Report-Only 收集违规，
// 清零后再转强制（OCRC_CSP=enforce）。
//
// 为什么在 host 运行时算哈希、而不是构建期产：
//   · index.html 的内联脚本（首绘主题脚本）由 web 构建产出，host 已按 mtime
//     缓存读取它（web/index.ts 的 readIndexHtml）——同一处取 HTML 顺手抽哈希，
//     重建后自动跟随，不需要构建链与 host 之间传哈希清单。
//   · CSP 由 host 以 **HTTP 头**下发（非 <meta>）：<meta> 无法覆盖 frame-ancestors，
//     也不作用于响应头级策略。
import { createHash, randomBytes } from 'node:crypto'

export type CspMode = 'off' | 'report' | 'enforce'

/** 模式来源：OCRC_CSP=off|report|enforce。
 *  默认 **enforce**——2026-10-12 在隔离栈走完「Report-Only 收集（25 条，全部归因）→
 *  补 nonce 注入 + 放行 vendor 的 eval/wasm 面 → 强制」两步，实测 0 违规（/z/ 壳 +
 *  设置页 5 分区 + 会话时间线 + 分享只读页）。report 留作排障/新部署的退路：
 *  先 report 看有没有未覆盖的路径，再切回 enforce。 */
export function cspModeFromEnv(raw: string | undefined = process.env.OCRC_CSP): CspMode {
  const v = (raw ?? '').trim().toLowerCase()
  if (v === 'off' || v === '0' || v === 'false') return 'off'
  if (v === 'report' || v === 'report-only') return 'report'
  return 'enforce'
}

/** 抽内联 <script>（无 src）的内容并算 sha256——CSP script hash 的取法。 */
export function inlineScriptHashes(html: string): string[] {
  const out: string[] = []
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] ?? ''
    if (/\bsrc\s*=/i.test(attrs)) continue
    const body = m[2] ?? ''
    if (!body.trim()) continue
    out.push(`'sha256-${createHash('sha256').update(body, 'utf-8').digest('base64')}'`)
  }
  return out
}

/** 每响应一个 nonce（base64，16 字节）。 */
export function makeNonce(): string {
  return randomBytes(16).toString('base64')
}

/** 给文档里所有 <script> 打上 nonce（含外链入口脚本——'strict-dynamic' 下
 *  主机白名单被忽略，HTML 里的外链入口脚本必须靠 nonce 放行）。 */
export function injectNonce(html: string, nonce: string): string {
  return html.replace(/<script\b(?![^>]*\bnonce=)/gi, `<script nonce="${nonce}"`)
}

/**
 * 构造策略。取舍（如实登记，2026-10-12 隔离栈 Report-Only 实测清单）：
 *  - script-src：nonce（入口脚本 + 内联脚本）+ 内联脚本哈希（CSP2 兜底）+
 *    'strict-dynamic'（Vite 的 chunk 图由已放行脚本动态加载，故不列主机白名单）。
 *  - 'unsafe-eval' / 'wasm-unsafe-eval'：**vendor 包实测需要**——mermaid 走 eval，
 *    wasm 模块（预览引擎）需要 wasm 求值；去掉会当场破坏图表/预览。如实记录：
 *    这一条削弱了 eval 类注入面的防护，是既有前端栈的代价，不是本策略的疏漏。
 *  - style-src 需 'unsafe-inline'：markdown 高亮（shiki）/ KaTeX / mermaid 把
 *    style **属性**写进 innerHTML，属 style-src 管辖。
 *  - connect-src 放 ws/wss：/z/ 的实时面走 WebSocket。
 */
export function buildCspPolicy(html: string, nonce?: string): string {
  const hashes = inlineScriptHashes(html)
  const scriptSrc = [
    ...(nonce ? [`'nonce-${nonce}'`] : []),
    `'self'`,
    ...hashes,
    "'strict-dynamic'",
    "'wasm-unsafe-eval'",
    "'unsafe-eval'",
  ].join(' ')
  const directives = [
    `default-src 'self'`,
    `script-src ${scriptSrc}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `font-src 'self' data:`,
    `media-src 'self' blob: data:`,
    `connect-src 'self' ws: wss: blob:`,
    `worker-src 'self' blob:`,
    `frame-src 'self' blob:`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'self'`,
  ]
  return directives.join('; ')
}

export function cspHeaderName(mode: CspMode): 'Content-Security-Policy' | 'Content-Security-Policy-Report-Only' | null {
  if (mode === 'enforce') return 'Content-Security-Policy'
  if (mode === 'report') return 'Content-Security-Policy-Report-Only'
  return null
}
