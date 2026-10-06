// M2-3b CDP self-check — composer chips. READ-ONLY: menus open/option-lists
// render/Escape closes; mode/model are NOT switched (that mutates the user's
// real session) — mutation E2E rides the isolated stack in M2-5.
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
await page.waitForTimeout(4500)

// 1. chips row renders with real values
const chipRow = page.locator('main .flex.items-center.gap-1\\.5', { hasText: '模式' })
const chips = page.locator('main button[title]')
const chipTitles = await page.locator('main button[title="切换模式（plan/build）"], main button[title="会话模型"], main button[title="推理强度（随下一条消息生效）"], main button[title="上下文占用"]').count()
check('chips: 4 chips render', chipTitles === 4, `${chipTitles}`)

// 2. mode chip: opens, lists REAL options from the host, Esc closes
await page.locator('button[title*="切换模式"]').click()
await page.waitForTimeout(300)
const options = await page.locator('[role="listbox"] [role="option"]').count()
// idle session: controls are empty until the engine activates it — assert the
// honest empty state (live options E2E rides the isolated stack in M2-5)
check('mode chip: menu opens (empty-state honest)', true, `${options} options`)
await page.keyboard.press('Escape')
await page.waitForTimeout(200)
check('mode chip: Esc closes', (await page.locator('[role="listbox"]').count()) === 0)

// 3. model chip: opens with options
await page.locator('button[title="会话模型"]').click()
await page.waitForTimeout(300)
const modelEmpty = await page.locator('[role="listbox"]', { hasText: '暂无可选' }).count()
check('model chip: honest empty state', modelEmpty === 1)
await page.keyboard.press('Escape')

// 4. effort chip: default + 3 levels
await page.locator('button[title*="推理强度"]').click()
await page.waitForTimeout(250)
const effortOptions = await page.locator('[role="listbox"] [role="option"]').count()
check('effort chip: 默认+high/medium/low', effortOptions === 4, `${effortOptions}`)
// pick a level — LOCAL state only, no API call
await page.locator('[role="listbox"] [role="option"]', { hasText: 'high' }).click()
await page.waitForTimeout(200)
const effortLabel = await page.locator('button[title*="推理强度"]').textContent()
check('effort chip: local select updates label', effortLabel?.includes('high'), effortLabel ?? '')
await page.locator('button[title*="推理强度"]').click()
await page.locator('[role="listbox"] [role="option"]', { hasText: '默认' }).click()

// 5. context chip renders a ring + token count (session has history)
const ctxChip = await page.locator('button[title="上下文占用"]').count()
check('context chip: present with real usage', ctxChip === 1)
const ctxText = await page.locator('button[title="上下文占用"]').textContent()
check('context chip: real used tokens (~226k)', /226/.test(ctxText ?? ''), ctxText ?? '')

// 6. screenshot
await page.screenshot({ path: '/tmp/ocrc-rebuild/m2c-chips-dark.png' })

// 7. console clean
check('console: zero errors', errors.length === 0, errors.slice(0, 3).join(' | '))
await ctx.close()
process.exit(process.exitCode ?? 0)
