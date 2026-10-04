// Visual audit over CDP — EL7-friendly variant of visual-audit.mjs.
// The stock Playwright chromium needs GLIBC 2.18+ (absent on EL7); this
// variant connects to the local EL7-built headless shell's CDP endpoint
// (~/bin/start-cdp-browser.sh, port 9222) instead of launching its own.
// Run: node tests/e2e/visual-audit-cdp.mjs [outDir]
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, extname } from 'node:path'
import { chromium } from 'playwright'

const DIST = new URL('../../dist', import.meta.url).pathname
const OUT = process.argv[2] ?? '/tmp/ocrc-visual-audit-cdp'
const PORT = 14791
const CDP = process.env.OCRC_CDP ?? 'http://localhost:9222'

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' }

const server = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
  let file = join(DIST, p)
  if (!existsSync(file) || p === '/') file = join(DIST, 'index.html')
  try {
    const body = await readFile(file)
    const type = MIME[/** @type {keyof typeof MIME} */ (extname(file))]
    res.writeHead(200, { 'content-type': type ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404); res.end('nf')
  }
})

const sessions = [
  { id: 'ses_aaa111', title: 'Fix WS reconnect avalanche', agent: 'build', model: 'kimi-for-coding', directory: '/home/u/ocrc', backendId: 'opencode', updatedAt: Date.now() - 60_000, lastActiveAt: Date.now() - 60_000 },
  { id: 'ses_bbb222', title: 'Refactor session store', agent: 'build', directory: '/home/u/ocrc', backendId: 'opencode', lastActiveAt: Date.now() - 3_600_000 },
  { id: 'ses_ccc333', title: 'Audit telegram renderer', directory: '/home/u/infra', backendId: 'opencode', lastActiveAt: Date.now() - 86_400_000 },
  { id: '8c3f1a92-4d5e-4f6a-9b7c-1a2b3c4d5e6f', title: 'Nightly dependency sweep (remote)', directory: '/work/pipeline', backendId: 'remote:build-farm', lastActiveAt: Date.now() - 7_200_000 },
  { id: '9d4e2b03-5e6f-4a7b-8c9d-2b3c4d5e6f70', title: 'Model eval harness', backendId: 'remote:build-farm', lastActiveAt: Date.now() - 500_000 },
]

const api = {
  '/api/me': { email: 'dev@local' },
  '/api/capabilities': { id: 'opencode', capabilities: { imageInput: true, sessionControls: true, commands: true, diff: true } },
  '/api/backends': { backends: [
    { id: 'opencode', capabilities: { imageInput: false, commands: true } },
    { id: 'remote:build-farm', name: 'build-farm', host: 'build-farm.corp', status: 'online', capabilities: { imageInput: false, commands: true } },
  ], activeId: 'opencode' },
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
  '/api/remotes': { remotes: [
    { id: 'build-farm', host: 'build-farm.corp', port: 22, remotePort: 4199, enabled: true, hasPassword: true,
      status: { id: 'build-farm', state: 'online', detail: 'opencode 1.18.32 via :41001', logTail: ['$ ssh -N -L 127.0.0.1:41001:127.0.0.1:4199 build-farm.corp', 'sync-config: applied', 'online'] } },
  ] },
  '/api/commands': [{ name: 'compact', description: 'Compact the session' }],
  '/api/session/ses_aaa111': { cards: [], lastSeq: 0 },
  '/api/session/ses_aaa111/context': { sessionId: 'ses_aaa111', agent: 'build', model: 'kimi-for-coding', directory: '/project', tokens: { input: 1234, output: 306 }, cost: 0.02 },
  '/api/session/ses_aaa111/todo': [],
}

await new Promise((resolve) => {
  server.listen(PORT, () => resolve(undefined))
})
const browser = await chromium.connectOverCDP(CDP)

/** @param {string} name @param {{ width?: number, height?: number, path?: string }} [opts] */
async function shot(name, { width = 1440, height = 900, path = '/' } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 })
  const page = await ctx.newPage()
  await page.addInitScript(() => localStorage.setItem('ocrc.token', 'visual-audit'))
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url())
    const body = api[/** @type {keyof typeof api} */ (url.pathname)]
    if (body) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    return route.fulfill({ contentType: 'application/json', body: '{}' })
  })
  await page.goto(`http://127.0.0.1:${PORT}${path}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(900)
  await page.screenshot({ path: `${OUT}/${name}.png` })
  console.log(`shot: ${name}`)
  return { ctx, page }
}

// 1. rail v2 project mode (desktop) — groups + cloud/folder + quick rows
await shot('01-rail-project')

// 2. time mode
{
  const { ctx, page } = await shot('02-rail-time-pre')
  await page.click('.modes button:has-text("时间")')
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${OUT}/02-rail-time.png` })
  console.log('shot: 02-rail-time')
  await ctx.close()
}

// 3. inline search
{
  const { ctx, page } = await shot('03-rail-search-pre')
  await page.fill('.searchbox input', 'remote')
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${OUT}/03-rail-search.png` })
  console.log('shot: 03-rail-search')
  await ctx.close()
}

// 4. archived section (archive one row first via its hover action)
{
  const { ctx, page } = await shot('04-rail-archive-pre')
  const row = page.locator('.session').first()
  await row.hover()
  await row.locator('.act.arch').click()
  await page.waitForTimeout(300)
  await page.click('.archbtn')
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${OUT}/04-rail-archive.png` })
  console.log('shot: 04-rail-archive')
  await ctx.close()
}

// 5. wizard: quick row -> remotes home -> + -> steps
{
  const { ctx, page } = await shot('05-wizard-pre')
  await page.locator('.quick-row', { hasText: '远程主机' }).click()
  await page.waitForTimeout(700)
  await page.screenshot({ path: `${OUT}/05-remotes-panel.png` })
  console.log('shot: 05-remotes-panel')
  await page.click('.remotes .add')
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${OUT}/06-wizard-step1.png` })
  console.log('shot: 06-wizard-step1')
  await page.click('.wiz-foot .btn.primary')
  await page.waitForTimeout(300)
  await page.fill('.form input >> nth=0', 'build-farm2.corp')
  await page.click('.proxy-toggle')
  await page.waitForTimeout(200)
  await page.fill('.proxy input >> nth=0', 'http://gw.corp:3128')
  await page.screenshot({ path: `${OUT}/07-wizard-step2.png` })
  console.log('shot: 07-wizard-step2')
  await page.click('.wiz-foot .btn.primary')
  await page.waitForTimeout(1200)
  await page.screenshot({ path: `${OUT}/08-wizard-connect.png` })
  console.log('shot: 08-wizard-connect')
  await ctx.close()
}

server.close()
console.log(`done → ${OUT}`)
process.exit(0)
