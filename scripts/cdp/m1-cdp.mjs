// M1 CDP self-check — the shell matrix. Run: cd web && TOKEN=$(cat ~/.ocrc/token) node m1-cdp.mjs
// Zero test traffic through the production engine: the new-session dialog is
// opened/closed but never submitted.
import { createRequire } from 'node:module'
const require = createRequire(new URL('../../web-next/', import.meta.url))
const { chromium } = require('playwright')
import { mkdirSync } from 'node:fs'

const OUT = '/tmp/ocrc-rebuild'
mkdirSync(OUT, { recursive: true })
const TOKEN = process.env.TOKEN ?? ''
if (!TOKEN) { console.error('TOKEN env required'); process.exit(2) }

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await ctx.addInitScript((t) => localStorage.setItem('ocrc.token', t), TOKEN)
const page = await ctx.newPage()
const consoleErrors = []
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))

await page.emulateMedia({ colorScheme: 'dark' })
await page.goto('http://127.0.0.1:4099/next/', { waitUntil: 'networkidle' })
await page.waitForTimeout(600)

// 1. rail + action rows with shortcut hints
const newBtn = page.locator('aside button', { hasText: '新建任务' })
check('rail: 新建任务 row + hint', await newBtn.isVisible() && (await newBtn.textContent()).includes('Ctrl+N'))
const searchRow = page.locator('aside button', { hasText: '搜索' })
check('rail: 搜索 row + hint', await searchRow.isVisible() && (await searchRow.textContent()).includes('Ctrl+K'))

// 2. real sessions render (live data from the host)
await page.waitForTimeout(400)
const rows = page.locator('aside li[class*="cursor-pointer"]')
const rowCount = await rows.count()
check('rail: real sessions render', rowCount > 0, `${rowCount} rows`)
const groupHeaders = await page.locator('aside .sticky span.bg-tag\\/50, aside [class*="bg-tag"]').count()
check('rail: group headers exist', groupHeaders > 0, `${groupHeaders}`)

// 3. view pills: 项目 → 时间 (最近 group header appears)
await page.locator('button', { hasText: '时间' }).first().click()
await page.waitForTimeout(200)
const recentHeader = await page.locator('aside div.sticky', { hasText: '最近' }).count()
check('pills: 时间 view shows 最近 group', recentHeader > 0)
await page.locator('button', { hasText: '项目' }).first().click()
await page.waitForTimeout(200)

// 4. row click → navigate + sub-header title
if (rowCount > 0) {
  await rows.first().click()
  await page.waitForTimeout(400)
  const url = page.url()
  const headerTitle = await page.locator('main header span').first().textContent()
  check('row click: navigates to /session/:id', /\/next\/session\//.test(url), url)
  check('row click: sub-header shows session title', !!headerTitle && headerTitle !== 'ocrc', headerTitle ?? '')
}

// 5. collapse via footer button → fully hidden + reopen arrow; reopen
const rail = page.locator('aside').first()
await page.locator('[title*="折叠左栏"]').click()
await page.waitForTimeout(400)
const ml = await rail.evaluate((el) => getComputedStyle(el).marginLeft)
check('collapse: rail fully hidden (negative margin)', parseFloat(ml) < -200, `marginLeft=${ml}`)
const reopen = page.locator('main header button[title*="展开左栏"]')
check('collapse: reopen arrow appears', await reopen.isVisible())
await reopen.click()
await page.waitForTimeout(400)
check('reopen: rail back', parseFloat(await rail.evaluate((el) => getComputedStyle(el).marginLeft)) === 0)

// 6. Ctrl+B toggle
await page.keyboard.press('Control+b')
await page.waitForTimeout(350)
check('Ctrl+B: collapses again', parseFloat(await rail.evaluate((el) => getComputedStyle(el).marginLeft)) < -200)
await page.keyboard.press('Control+b')
await page.waitForTimeout(350)
check('Ctrl+B: reopens', parseFloat(await rail.evaluate((el) => getComputedStyle(el).marginLeft)) === 0)

// 7. Ctrl+K → command center: open, filter, navigate via item, Escape close
await page.keyboard.press('Control+k')
await page.waitForTimeout(250)
const cmdkInput = page.locator('.cmdk-input')
check('Ctrl+K: palette opens', await cmdkInput.isVisible())
await cmdkInput.fill('ocrc') // filter — any word; group headings remain
const itemCount = await page.locator('.cmdk-item').count()
check('palette: items render', itemCount > 0, `${itemCount} items`)
await page.keyboard.press('Escape')
await page.waitForTimeout(200)
check('palette: Escape closes', !(await page.locator('.cmdk-root').isVisible().catch(() => false)))

// 8. Ctrl+N → new-session dialog opens/closes (NEVER submitted — zero
//    traffic through the production engine)
await page.keyboard.press('Control+n')
await page.waitForTimeout(250)
check('Ctrl+N: dialog opens', await page.locator('[role="dialog"]').isVisible())
const dirVal = await page.locator('[role="dialog"] input').inputValue()
check('dialog: directory prefilled from sessions', dirVal.length > 0, dirVal)
await page.keyboard.press('Escape')
await page.waitForTimeout(200)
check('dialog: Escape closes', !(await page.locator('[role="dialog"]').isVisible().catch(() => false)))

// 9. theme cycle via footer button (auto→light→dark under dark emulation)
await page.locator('[title*="切换主题"]').click()
await page.waitForTimeout(150)
const forcedAttr = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
check('footer theme btn: cycles to forced light', forcedAttr === 'light')
await page.locator('[title*="切换主题"]').click()
await page.waitForTimeout(150)
check('footer theme btn: cycles to dark', (await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'dark')
await page.screenshot({ path: `${OUT}/m1-shell-dark.png` })
await page.locator('[title*="切换主题"]').click()
await page.waitForTimeout(150)
check('footer theme btn: back to auto', (await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === null)
await page.emulateMedia({ colorScheme: 'light' })
await page.waitForTimeout(200)
await page.screenshot({ path: `${OUT}/m1-shell-light.png` })

// 10. inspector toggle (right pane container)
await page.locator('main header button[title*="右栏"]').click()
await page.waitForTimeout(250)
check('inspector: container toggles', (await page.locator('main ~ aside').count()) === 1)
await page.locator('main header button[title*="右栏"]').click()

// 11. console cleanliness
check('console: zero errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

await ctx.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
