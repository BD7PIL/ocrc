import { createRequire } from 'node:module'
import { browserClick, browserNavigate, browserScroll, browserState, browserType } from '../core/browser.js'
const require = createRequire(import.meta.url)

/**
 * 0.27 M7 — minimal MCP stdio server exposing the sidecar browser as engine
 * tools. Newline-delimited JSON-RPC 2.0 over stdio (MCP 2024-11-05): no new
 * dependency. Wire it into opencode config:
 *
 *   "mcp": { "ocrc-browser": { "type": "local",
 *     "command": ["node", "<ocrc>/dist/cli/index.js", "mcp-browser"],
 *     "enabled": true } }
 */

interface Tool { name: string; description: string; inputSchema: Record<string, unknown> }

const TOOLS: Tool[] = [
  { name: 'browser_navigate', description: 'Navigate the sidecar browser to a URL', inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'URL to open' } }, required: ['url'] } },
  { name: 'browser_click', description: 'Click at percentage coordinates of the viewport', inputSchema: { type: 'object', properties: { xPct: { type: 'number' }, yPct: { type: 'number' } }, required: ['xPct', 'yPct'] } },
  { name: 'browser_type', description: 'Type text into the focused element', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'browser_scroll', description: 'Scroll by a percentage of the viewport', inputSchema: { type: 'object', properties: { dyPct: { type: 'number' } } } },
  { name: 'browser_state', description: 'Current URL + title + text summary of the page', inputSchema: { type: 'object', properties: {} } },
]

async function runTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'browser_navigate': {
      const url = String(args.url ?? '')
      const r = await browserNavigate(/^https?:\/\//.test(url) ? url : `https://${url}`)
      return `navigated: ${r.url} — ${r.title}`
    }
    case 'browser_click':
      await browserClick(Number(args.xPct ?? 50), Number(args.yPct ?? 50))
      return 'clicked'
    case 'browser_type':
      await browserType(String(args.text ?? ''))
      return 'typed'
    case 'browser_scroll':
      await browserScroll(Number(args.dyPct ?? 25))
      return 'scrolled'
    case 'browser_state': {
      const st = await browserState()
      return `url: ${st.url}\ntitle: ${st.title}\n(screenshot available via the ocrc panel browser tab)`
    }
    default:
      throw new Error(`unknown tool: ${name}`)
  }
}

export async function runMcpBrowser(): Promise<void> {
  const read = require_readline()

  for await (const line of read) {
    if (!line.trim()) continue
    let msg: Record<string, unknown>
    try { msg = JSON.parse(line) } catch { continue }
    const id = msg.id as number | string | undefined
    const method = msg.method as string | undefined
    if (!method) continue // notification

    try {
      if (method === 'initialize') {
        send(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'ocrc-browser', version: '0.27.0' } })
      } else if (method === 'tools/list') {
        send(id, { tools: TOOLS })
      } else if (method === 'tools/call') {
        const params = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> }
        const text = await runTool(params.name ?? '', params.arguments ?? {})
        send(id, { content: [{ type: 'text', text }] })
      } else if (id !== undefined) {
        send(id, {}, { code: -32601, message: `unknown method ${method}` })
      }
    } catch (err) {
      if (id !== undefined) send(id, {}, { code: -32000, message: (err as Error).message })
    }
  }
}

function send(id: number | string | undefined, result: unknown, error?: { code: number; message: string }): void {
  const frame = JSON.stringify(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result })
  process.stdout.write(`${frame}\n`)
}

function require_readline(): AsyncIterable<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const rl = (require('node:readline') as typeof import('node:readline')).createInterface({ input: process.stdin })
  const lines: string[] = []
  const waiters: Array<(v: IteratorResult<string>) => void> = []
  let done = false
  rl.on('line', (l) => {
    const w = waiters.shift()
    if (w) w({ value: l, done: false })
    else lines.push(l)
  })
  rl.on('close', () => { done = true; for (const w of waiters) w({ value: undefined as never, done: true }) })
  return {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<string>> {
          const l = lines.shift()
          if (l !== undefined) return Promise.resolve({ value: l, done: false })
          if (done) return Promise.resolve({ value: undefined as never, done: true })
          return new Promise((res) => waiters.push(res))
        },
      }
    },
  }
}
