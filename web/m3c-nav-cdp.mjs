// M3-3 CDP self-check — TurnNavigator, READ-ONLY.
import { chromium } from 'playwright'
const TOKEN = process.env.TOKEN
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await ctx.addInitScript((t) => localStorage.setItem('ocrc.token', t), TOKEN)
const page = await ctx.newPage()
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push(e.message))
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) process.exitCode = 1 }

await page.emulateMedia({ colorScheme: 'dark' })
var sessions = await page.request.get('http://127.0.0.1:4099/api/sessions', { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.json())
await page.goto('http://127.0.0.1:4099/next/session/ses_f23a3c587ffejiT55j036fj1EK', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(4500)

// 0. pick a session whose window actually has user turns
const hist = (await Promise.all(sessions.slice(0, 8).map((s) =>
  page.request.get(`http://127.0.0.1:4099/api/session/${s.id}?limit=200`, { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.json()).then((j) => ({ id: s.id, title: s.title, users: (j.cards ?? []).slice(-24).filter((c) => c.kind === 'user').length })).catch(() => null)
))).filter(Boolean)
const rich = hist.find((h) => h.users >= 2)
var target = rich ? rich : sessions[0]

// 0. bring older turns (with user cards) into the window
const chip = page.locator('button', { hasText: '加载更早消息' })
if (await chip.count()) { await chip.click(); await page.waitForTimeout(3500) }

// 1. ticks render, one per user turn in the visible window
const ticks = await page.locator('.turn-tick').count()
const userCards = await page.evaluate(() =>
  [...document.querySelectorAll('.cv-card')].filter((c) => c.querySelector('.whitespace-pre-wrap')).length)
check('navigator: ticks render (≈user turns)', ticks > 0, `${ticks} ticks / ${userCards} user cards`)

// 2. ticks are vertically distributed (not stacked)
const tops = await page.evaluate(() => [...document.querySelectorAll('.turn-tick')].map((t) => Math.round(t.getBoundingClientRect().top)))
const spread = Math.max(...tops) - Math.min(...tops)
check('navigator: ticks spread vertically', spread > 40, `spread ${spread}px`)

// 3. click a top-area tick → scrolls UP toward that turn
const before = await page.evaluate(() => document.querySelector('main .overflow-y-auto')?.scrollTop ?? 0)
const topTick = page.locator('.turn-tick').first()
await topTick.click()
await page.waitForTimeout(900)
const after = await page.evaluate(() => document.querySelector('main .overflow-y-auto')?.scrollTop ?? 0)
check('navigator: click jumps to turn (scrolled up)', after < before, `${before} → ${after}`)

// 4. screenshots
await page.screenshot({ path: '/tmp/ocrc-rebuild/m3c-navigator.png' })

// 5. console clean
check('console: zero errors', errors.length === 0, errors.slice(0, 3).join(' | '))
await ctx.close()
process.exit(process.exitCode ?? 0)
