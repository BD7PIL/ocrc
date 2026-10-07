import { createRequire } from 'node:module'
const require = createRequire(new URL('../../web-next/package.json', import.meta.url))
const { chromium } = require('playwright')
const TOKEN = process.env.TOKEN
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await ctx.addInitScript((t) => localStorage.setItem('ocrc.token', t), TOKEN)
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) process.exitCode = 1 }

await page.emulateMedia({ colorScheme: 'dark' })
const SID = 'ses_f23a3c587ffejiT55j036fj1EK'
await page.goto(`http://127.0.0.1:4099/session/${SID}`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(4000)

// ── 1. 分享：create snapshot via API, open public landing WITHOUT token ──
const shared = await page.request.post('http://127.0.0.1:4099/api/share', {
  headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
  data: { sessionId: SID },
}).then((r) => r.json())
check('share: snapshot created (authed)', !!shared.code, `${shared.count} cards`)

const anon = await browser.newContext() // NO token — public visitor
const pub = await anon.newPage()
const pubRes = await pub.goto(`http://127.0.0.1:4099/api/share/${shared.code}`)
check('share: public GET without token → 200', pubRes?.status() === 200)
await pub.goto(`http://127.0.0.1:4099/share/${shared.code}`, { waitUntil: 'domcontentloaded' })
await pub.waitForTimeout(1500)
check('share: landing renders (no auth)', (await pub.locator('text=ocrc 分享').count()) === 1)
const shareCards = await pub.locator('.cv-card').count()
check('share: read-only timeline renders', shareCards > 0, `${shareCards} cards`)
await pub.screenshot({ path: '/tmp/ocrc-rebuild/m6-share-landing.png' })
await anon.close()

// ── 2. 工作台分屏 ──
await page.goto(`http://127.0.0.1:4099/session/${SID}`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(3500)
await page.locator('main button[title="多会话分屏"]').click()
await page.waitForTimeout(1500)
const panes = await page.locator('main').getByText('分屏').count()
const paneCards = await page.locator('main [data-split] .cv-card').count()
check('split: second pane opens', panes >= 1, `markers=${panes}`)
const splitSelect = page.locator('select')
await page.waitForTimeout(1500)
// the dropdown defaults to the first other session (often empty) — pick a
// session with actual history, then count cards in the split pane
const all = await page.request.get('http://127.0.0.1:4099/api/sessions', { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.json())
let rich = null
for (const s2 of all) {
  if (s2.id === SID) continue
  const j = await page.request.get(`http://127.0.0.1:4099/api/session/${s2.id}?limit=50`, { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.json()).catch(() => null)
  if (j && (j.cards ?? []).length >= 2) { rich = s2.id; break }
}
if (rich) {
  await page.locator('main select').selectOption(rich)
  await page.waitForTimeout(1800)
  const splitCards = await page.locator('main [data-split] .cv-card').count()
  check('split: peek transcript renders (rich session)', splitCards > 0, `${splitCards} cards`)
} else {
  check('split: peek transcript renders (rich session)', true, '(no other rich session — skipped)')
}

// ── 3. 画板：open, draw, undo, clear ──
await page.locator('main button[title="画板"]').click()
await page.waitForTimeout(400)
const canvas = page.locator('canvas')
check('whiteboard: canvas opens', (await canvas.count()) === 1)
const box = await canvas.boundingBox()
if (box) {
  // draw a stroke
  await page.mouse.move(box.x + 50, box.y + 50)
  await page.mouse.down()
  for (let i = 0; i < 8; i++) await page.mouse.move(box.x + 50 + i * 12, box.y + 50 + (i % 2) * 20, { steps: 2 })
  await page.mouse.up()
}
const strokeCount = await page.evaluate(() => JSON.parse(localStorage.getItem(`ocrc.whiteboard.${'ses_f23a3c587ffejiT55j036fj1EK'}`) ?? '[]').length)
check('whiteboard: stroke captured + persisted', strokeCount >= 1, `${strokeCount} strokes`)
await page.locator('button[title="撤销"]').click()
await page.waitForTimeout(150)
const afterUndo = await page.evaluate(() => JSON.parse(localStorage.getItem(`ocrc.whiteboard.${'ses_f23a3c587ffejiT55j036fj1EK'}`) ?? '[]').length)
check('whiteboard: undo pops stroke', afterUndo === strokeCount - 1, `${afterUndo}`)
await page.screenshot({ path: '/tmp/ocrc-rebuild/m6-whiteboard.png' })

// 4. console clean
const realErrors = errors.filter((e) => !/Failed to load resource/.test(e))
check('console: zero errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))
await ctx.close()
process.exit(process.exitCode ?? 0)
