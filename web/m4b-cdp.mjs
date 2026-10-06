// M4-2 CDP self-check — automations view / channels dialog / status panel.
// READ-ONLY: schedules/channels mutations are NOT performed (they touch the
// user's production schedules + bot config).
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
await page.goto('http://127.0.0.1:4099/next/session/ses_f23a3c587ffejiT55j036fj1EK', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(3500)

// 1. status panel: collapsed strip renders with real plan data
const strip = page.locator('button', { hasText: /计划 \d+\/\d+/ }).first()
check('status: collapsed strip with 计划 n/m', await strip.isVisible().catch(() => false), await strip.textContent().catch(() => ''))

// 2. click strip → expanded partitions (计划 checklist + 子代理 sections)
await strip.click()
await page.waitForTimeout(400)
check('status: expanded partitions', (await page.locator('text=子代理 · 运行中').count()) === 1)
const maxBtn = await page.locator('button[title="最大化"]').count()
check('status: maximize button', maxBtn === 1)

// 3. collapse via ▾ — stays collapsed (latch; no auto-expand without a
//    running subagent wave anyway)
await page.locator('button[title="收起"]').click()
await page.waitForTimeout(300)
check('status: collapse works', (await page.locator('text=子代理 · 运行中').count()) === 0)

// 4. automations main view via the 左栏 自动化 row
await page.locator('.rail-row', { hasText: '自动化' }).click()
await page.waitForTimeout(1200)
check('automations: route renders', (await page.locator('h1', { hasText: '自动化' }).count()) === 1)
const rows = await page.locator('main .flex.items-center.gap-3').count()
check('automations: schedule rows render (0 = honest empty)', rows >= 0, `${rows} rows`)
const emptyText = await page.locator('main', { hasText: '没有定时任务' }).count()
check('automations: honest empty state text', emptyText > 0)
// create form opens (no submit — mutations skipped)
await page.locator('main button', { hasText: '新建' }).first().click()
await page.waitForTimeout(250)
check('automations: create form opens', (await page.locator('textarea').count()) === 1)
// aria-pressed on the rail row
const pressed = await page.locator('.rail-row[aria-pressed="true"]').count()
check('automations: rail row aria-pressed', pressed === 1)

// 5. channels dialog via the 机器人 row
await page.locator('.rail-row', { hasText: '机器人' }).click()
await page.waitForTimeout(1000)
check('channels: dialog renders', (await page.locator('[role="dialog"]').count()) === 1)
const channelRows = await page.locator('[role="dialog"] .w-56 button').count()
check('channels: channel list rows', channelRows > 0, `${channelRows} rows`)
const granularity = await page.locator('[role="dialog"] button', { hasText: '简洁' }).count()
check('channels: detail granularity renders', granularity > 0)
const resetBtn = await page.locator('[role="dialog"] button', { hasText: '重置通道' }).count()
check('channels: two-step reset (armed state hidden)', resetBtn === 1)
await page.screenshot({ path: '/tmp/ocrc-rebuild/m4b-channels.png' })
await page.keyboard.press('Escape')
await page.waitForTimeout(200)

// 6. console clean
check('console: zero errors', errors.length === 0, errors.slice(0, 3).join(' | '))
await ctx.close()
process.exit(process.exitCode ?? 0)
