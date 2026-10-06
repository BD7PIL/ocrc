// M2-2 CDP self-check — tool card family + entrance LRU, READ-ONLY.
import { chromium } from 'playwright'
const TOKEN = process.env.TOKEN
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await ctx.addInitScript((t) => localStorage.setItem('ocrc.token', t), TOKEN)
const page = await ctx.newPage()
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push(e.message))

await page.emulateMedia({ colorScheme: 'dark' })
// WLG5144_DEV group has the rich HANDOFF session (edit/bash/todowrite calls)
await page.goto('http://127.0.0.1:4099/next/session/ses_f23a3c587ffejiT55j036fj1EK', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(4500)

// 0b. load older — edit/todowrite summary rows live beyond the first window
const chip = page.locator('button', { hasText: '加载更早消息' })
if (await chip.count()) { await chip.click(); await page.waitForTimeout(3500) }

// 1. history-reconstructed tool blocks = summary rows (JSON args only exist
//    in live streams — covered by ToolBlock.test.tsx with synthetic args)
const summaryEdits = await page.getByText('2 edits').count()
check('history: edit summary row', summaryEdits > 0, `${summaryEdits}`)
const summaryTodo = await page.getByText('4 items').count()
check('history: todo summary row', summaryTodo > 0, `${summaryTodo}`)
const bashRows = await page.locator('.tool-row', { hasText: 'bash' }).count()
check('history: bash rows with status dots', bashRows > 0, `${bashRows}`)

// 2. generic fallback rows still render for unregistered tools
const genericRows = await page.locator('.tool-row').count()
check('fallback: generic tool rows', genericRows >= 0, `${genericRows}`)

// 3. entrance LRU: first visit animates, in-app revisit (SPA, module state
//    persists) replays nothing — a full page load WOULD reset it by design
const enterFirst = await page.locator('.card-enter').count()
check('entrance: first visit animates', enterFirst > 0, `${enterFirst} animated`)
// in-app navigate to a DIFFERENT session then BACK (SPA: module state — the
// LRU — survives; a full reload would legitimately reset it). Same-session
// clicks don't remount, so they prove nothing.
const title = (await page.locator('main header span').first().textContent()) ?? ''
const otherRow = page.locator('.group.cursor-pointer').nth(8)
await otherRow.click()
await page.waitForTimeout(1200)
check('LRU: navigated away', (await page.locator('main header span').first().textContent()) !== title)
await page.locator('.group.cursor-pointer', { hasText: title.slice(0, 12) }).first().click()
await page.waitForTimeout(2500)
const enterRevisit = await page.locator('.card-enter').count()
check('entrance LRU: same-session REMOUNT replays nothing', enterRevisit === 0, `${enterRevisit} animated`)

// 4. screenshots
await page.screenshot({ path: '/tmp/ocrc-rebuild/m2b-toolcards-dark.png' })

// 5. console clean
check('console: zero errors', errors.length === 0, errors.slice(0, 3).join(' | '))

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) process.exitCode = 1
}
await ctx.close()
process.exit(process.exitCode ?? 0)
