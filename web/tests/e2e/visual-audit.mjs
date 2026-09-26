// Visual audit: serve the built app (web/dist) with mocked /api routes and
// screenshot key surfaces. Run: node tests/e2e/visual-audit.mjs [outDir]
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, extname } from 'node:path'
import { chromium } from 'playwright'

const DIST = new URL('../../dist', import.meta.url).pathname
const OUT = process.argv[2] ?? '/tmp/ocrc-visual-audit'
const PORT = 14789

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' }

const server = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  let file = join(DIST, p)
  if (!existsSync(file) || p === '/') file = join(DIST, 'index.html')
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404); res.end('nf')
  }
})

const sessions = [
  { id: 'ses_aaa111', title: 'Fix WS reconnect avalanche', agent: 'build', model: 'kimi-for-coding', updatedAt: Date.now() - 60_000 },
  { id: 'ses_bbb222', title: 'Refactor session store', agent: 'build', updatedAt: Date.now() - 3_600_000 },
  { id: 'ses_ccc333', title: 'Audit telegram renderer', updatedAt: Date.now() - 86_400_000 },
]

const cards = [
  { kind: 'user', sessionId: 'ses_aaa111', id: 'u1', seq: 1, text: '修一下 reconnect 风暴，顺便看看这个报错' },
  { kind: 'assistant', sessionId: 'ses_aaa111', id: 'a1', seq: 2, meta: { agent: 'build', model: 'kimi-for-coding' }, blocks: [
    { type: 'tool', tool: 'read', args: 'src/lib/ws/client.ts', status: 'done' },
    { type: 'tool', tool: 'bash', args: '$ npm test\n\n ✓ ws/client.test.ts (3 tests)\n\x1b[32m✓\x1b[0m reconnect backoff capped\n\x1b[31m✗\x1b[0m flake in pong timer\n\nTests 52 passed, \x1b[1m1 failed\x1b[0m\n' + Array.from({ length: 24 }, (_, i) => `log line ${i + 1} verbose runner output`).join('\n'), status: 'error' },
    { type: 'tool', tool: 'edit', args: 'src/lib/ws/client.ts', status: 'done' },
    { type: 'text', text: '问题在 `reconnect()` 被 `onclose` 和 pong 超时**双重触发**。修复：\n\n```ts\nfunction onPongTimeout() {\n  ws?.close() // let onclose drive reconnect\n}\n```\n\n- backoff 已封顶 30s\n- 补了单元测试' },
  ] },
  { kind: 'error', sessionId: 'ses_aaa111', id: 'e1', seq: 3, message: 'submit failed: session busy — queued behind running turn' },
  { kind: 'approval', sessionId: 'ses_aaa111', id: 'ap1', seq: 4, title: 'bash: rm -rf dist && npm run build', args: { command: 'rm -rf dist' }, requestId: 'perm_1' },
]

const api = {
  '/api/me': { email: 'dev@local' },
  '/api/capabilities': { id: 'opencode', capabilities: { imageInput: true, sessionControls: true, commands: true, diff: true } },
  '/api/backends': { backends: [{ id: 'opencode', capabilities: { imageInput: false, commands: true } }], activeId: 'opencode' },
  '/api/sessions': sessions,
  '/api/workspaces': [{ directory: '/project', name: 'project', sessionCount: 3, lastActiveAt: Date.now() }],
  '/api/agents': [{ name: 'build', model: 'kimi-for-coding', description: 'Build agent' }],
  '/api/models': [{ id: 'kimi', name: 'Kimi', models: [{ id: 'kimi-for-coding', name: 'kimi-for-coding' }] }],
  '/api/overrides': { agent: null, model: null },
  '/api/mcp': [{ name: 'pact', status: 'configured' }, { name: 'shadcn', status: 'disabled' }],
  '/api/schedules': { schedules: [
    { id: 'sc1', name: '', prompt: 'nightly dependency sweep', spec: { kind: 'every', minutes: 15 }, enabled: true, createdAt: 1 },
    { id: 'sc2', name: 'standup', prompt: 'write the standup summary', spec: { kind: 'daily', time: '09:00' }, enabled: false, createdAt: 2 },
  ] },
  '/api/commands': [{ name: 'compact', description: 'Compact the session' }],
  '/api/session/ses_aaa111': { cards, lastSeq: 4 },
  '/api/session/ses_aaa111/context': { sessionId: 'ses_aaa111', agent: 'build', model: 'kimi-for-coding', directory: '/project', tokens: { input: 1234, output: 306 }, cost: 0.02 },
  '/api/session/ses_aaa111/diff': [{ path: 'src/lib/ws/client.ts', additions: 4, deletions: 2, lines: [
    { kind: 'ctx', text: 'function onPongTimeout() {' },
    { kind: 'del', text: '  ws?.close(); reconnect()' },
    { kind: 'add', text: '  ws?.close() // let onclose drive reconnect' },
    { kind: 'ctx', text: '}' },
  ] }],
  '/api/session/ses_aaa111/todo': [
    { content: 'Fix double reconnect', status: 'completed' },
    { content: 'Write regression test', status: 'in_progress' },
    { content: 'Harden backoff jitter', status: 'pending' },
    { content: 'Document reconnect policy', status: 'pending' },
    { content: 'Ship v2.1', status: 'pending' },
  ],
  '/api/session/ses_aaa111/controls': { mode: { current: 'build', options: [{ id: 'build', name: 'build' }, { id: 'plan', name: 'plan' }] }, model: { current: 'kimi-for-coding', options: [{ id: 'kimi-for-coding', name: 'kimi-for-coding' }] } },
}

await new Promise((r) => server.listen(PORT, r))
const browser = await chromium.launch()

async function shot(name, { width = 1440, height = 900, path = '/ses_aaa111/', mobile = false, expandHud = false, hudMenu = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile })
  const page = await ctx.newPage()
  await page.addInitScript(() => localStorage.setItem('ocrc.token', 'visual-audit'))
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url())
    const body = api[url.pathname]
    if (body) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    return route.fulfill({ contentType: 'application/json', body: '{}' })
  })
  await page.goto(`http://127.0.0.1:${PORT}${path}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(800)
  if (expandHud) { await page.click('.plan-hud .hd'); await page.waitForTimeout(400) }
  if (hudMenu) { await page.click('.plan-hud .dots'); await page.waitForTimeout(300) }
  await page.screenshot({ path: `${OUT}/${name}.png` })
  await ctx.close()
  console.log(`shot: ${name}`)
}

await shot('desktop-session')
await shot('desktop-sessions-list', { path: '/' })
await shot('mobile-session', { width: 390, height: 844, mobile: true })
await shot('mobile-sessions', { width: 390, height: 844, path: '/', mobile: true })
// PlanHud floating plan card — collapsed / expanded / ⋯ menu (mobile only).
await shot('mobile-plan-collapsed', { width: 390, height: 844, mobile: true })
await shot('mobile-plan-expanded', { width: 390, height: 844, mobile: true, expandHud: true })
await shot('mobile-plan-menu', { width: 390, height: 844, mobile: true, hudMenu: true })

await browser.close()
server.close()
console.log(`done → ${OUT}`)
