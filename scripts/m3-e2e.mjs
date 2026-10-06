// M3-3 E2E — TurnNavigator against the ISOLATED stack (mock 4098 + host
// 4199): three UI sends → three turns → tick spread / jump / busy pulse.
// The user's real engine is never touched.
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(new URL('../web/', import.meta.url))
const { chromium } = require('playwright')

const ISO_PORT = 4199
const ISO_BASE = `http://127.0.0.1:${ISO_PORT}`
const ISO_TOKEN = 'ocrc-e2e-token'
const MOCK_PORT = 4098
const failures = []
const cleanup = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(name)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function spawnDetached(cmd, args, env) {
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  cleanup.push(() => { try { child.kill('SIGTERM') } catch { /* gone */ } })
  return child
}
async function waitReady(url, tries = 30) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url, { headers: { Authorization: `Bearer ${ISO_TOKEN}` } }); if (r.ok) return true } catch { /* not up */ }
    await sleep(1000)
  }
  return false
}

const statePath = join(tmpdir(), `ocrc-e2e-state-${Date.now()}.json`)
cleanup.push(() => { try { rmSync(statePath, { force: true }) } catch { /* gone */ } })

spawnDetached('node', [new URL('./mock-opencode.mjs', import.meta.url).pathname, String(MOCK_PORT)])
spawnDetached(process.execPath, [new URL('../dist/cli/index.js', import.meta.url).pathname, 'host'], {
  OCRC_BACKENDS: 'opencode',
  OCRC_SERVER_URL: `http://127.0.0.1:${MOCK_PORT}`,
  OCRC_WEB_ENABLED: 'true',
  OCRC_WEB_PORT: String(ISO_PORT),
  OCRC_WEB_TOKEN: ISO_TOKEN,
  OCRC_STATE_PATH: statePath,
  LOG_LEVEL: 'warn',
})
check('isolated: stack up', await waitReady(`${ISO_BASE}/api/version`))
const created = await fetch(`${ISO_BASE}/api/session`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${ISO_TOKEN}`, 'content-type': 'application/json' },
  body: JSON.stringify({ directory: tmpdir() }),
}).then((r) => r.json())
check('isolated: session created', !!created.id, created.id)

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = await browser.newContext({ viewport: { width: 1440, height: 360 } })
await ctx.addInitScript((t) => localStorage.setItem('ocrc.token', t), ISO_TOKEN)
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.emulateMedia({ colorScheme: 'dark' })
await page.goto(`${ISO_BASE}/next/session/${created.id}`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1200)

// three turns through the real composer
for (let i = 1; i <= 3; i++) {
  const ta = page.locator('textarea')
  await ta.fill(`回合 ${i} — TurnNavigator E2E`)
  await page.locator('button[aria-label="发送"]').click()
  await sleep(4200) // mock echo ≈3s + margin
}

const ticks = await page.locator('.turn-tick').count()
check('navigator: one tick per turn', ticks >= 3, `${ticks} ticks`)
const tops = await page.evaluate(() => [...document.querySelectorAll('.turn-tick')].map((t) => Math.round(t.getBoundingClientRect().top)))
const spread = tops.length ? Math.max(...tops) - Math.min(...tops) : 0
check('navigator: ticks spread vertically', spread > 40, `spread ${spread}px`)

// jump check: force to top, click the LAST tick (bottom-most turn) → scrolls DOWN
const scroller = () => page.evaluate(() => document.querySelector('main .h-full.overflow-y-auto')?.scrollTop ?? 0)
await page.evaluate(() => { const el = document.querySelector('main .h-full.overflow-y-auto'); if (el) el.scrollTop = 0 })
await sleep(200)
const diag = await page.evaluate(() => {
  const els = [...document.querySelectorAll('main .overflow-y-auto')]
  return els.map((el) => ({ sh: el.scrollHeight, ch: el.clientHeight, st: el.scrollTop, cls: el.className.slice(0, 40) }))
})
console.log('  [diag]', JSON.stringify(diag))
const before = await scroller()
await page.locator('.turn-tick').last().click()
await sleep(900)
const after = await scroller()
check('navigator: last-tick click jumps toward the turn', after > before, `${before} → ${after}`)

// busy pulse: while a turn streams, its tick carries the busy class
const ta = page.locator('textarea')
await ta.fill('回合 4 — busy pulse')
await page.locator('button[aria-label="发送"]').click()
await sleep(1200)
const busyTicks = await page.locator('.turn-tick-busy').count()
check('navigator: running turn pulses busy', busyTicks >= 1, `${busyTicks}`)
await sleep(3500)

check('console: zero pageerrors', errors.length === 0, errors.slice(0, 2).join(' | '))
await page.screenshot({ path: '/tmp/ocrc-rebuild/m3d-navigator-e2e.png' })
await ctx.close()

for (const fn of cleanup.reverse()) fn()
console.log(`\n${12 - failures.length}/12 checks passed${failures.length ? ' — ' + failures.join(', ') : ''}`)
process.exit(failures.length ? 1 : 0)
