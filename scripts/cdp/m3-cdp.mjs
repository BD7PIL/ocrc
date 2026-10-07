// M3-1 CDP self-check — the SidePane tab drawer, READ-ONLY.
import { createRequire } from 'node:module'
const require = createRequire(new URL('../../web-next/', import.meta.url))
const { chromium } = require('playwright')
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
await page.waitForTimeout(3000)

// open the pane via the sub-header toggle
await page.locator('main header button[title*="右栏"]').click()
await page.waitForTimeout(400)

// 1. empty launcher (nothing resident)
const launcherBtns = await page.locator('aside .grid button').count()
check('pane: launcher grid (7 homes incl. skills)', launcherBtns === 7, `${launcherBtns}`)

// 2. open 任务 home → tab strip shows 28px tab, active = filled block
await page.getByRole('button', { name: '任务', exact: true }).click()
await page.waitForTimeout(2500)
const tab = page.locator('.pane-tab[aria-selected="true"]')
check('pane: 任务 tab active', await tab.count() === 1)
const tabH = await tab.evaluate((el) => el.getBoundingClientRect().height)
check('pane: tab height 28px', Math.round(tabH) === 28, `${tabH}`)
const tabBg = await tab.evaluate((el) => getComputedStyle(el).backgroundColor)
check('pane: active tab = filled 10% ink block (not underline)', /0\.1\)/.test(tabBg), tabBg)
const todos = await page.locator('aside ul li').count()
check('tasks panel: real todos render', todos > 0, `${todos}`)

// 3. ✕ hover-revealed: opacity 0 at rest, 1 on hover
// ✕ register: hidden at rest on INACTIVE tabs, revealed on hover; the ACTIVE
// tab shows it permanently (ZCode register)
const inactiveTab = page.locator('.pane-tab[aria-selected="false"]').first()
if (await inactiveTab.count()) {
  const xInactive = inactiveTab.locator('.pane-tab-x')
  const op0 = await xInactive.evaluate((el) => getComputedStyle(el).opacity)
  await inactiveTab.hover()
  await page.waitForTimeout(150)
  const op1 = await xInactive.evaluate((el) => getComputedStyle(el).opacity)
  check('tab ✕: inactive hidden at rest → hover reveals', op0 === '0' && op1 === '1', `${op0} → ${op1}`)
} else {
  // single-tab case: open a second home so an inactive tab exists
  await page.locator('button[title="打开面板"]').click()
  await page.locator('.absolute >> text=定时任务').last().click()
  await page.waitForTimeout(300)
  const inactiveTab2 = page.locator('.pane-tab[aria-selected="false"]').first()
  const op0 = await inactiveTab2.locator('.pane-tab-x').evaluate((el) => getComputedStyle(el).opacity)
  await inactiveTab2.hover()
  await page.waitForTimeout(150)
  const op1 = await inactiveTab2.locator('.pane-tab-x').evaluate((el) => getComputedStyle(el).opacity)
  check('tab ✕: inactive hidden at rest → hover reveals', op0 === '0' && op1 === '1', `${op0} → ${op1}`)
}

// 4. open second home via +, close active → neighbor activation
await page.locator('button[title="打开面板"]').click()
await page.locator('div[role="region"], .absolute >> text=定时任务').last().click()
await page.waitForTimeout(400)
const tabs2 = await page.locator('.pane-tab').count()
check('pane: + menu opens second home', tabs2 === 2, `${tabs2} tabs`)
await page.locator('.pane-tab[aria-selected="true"] .pane-tab-x').click()
await page.waitForTimeout(250)
const tabs3 = await page.locator('.pane-tab').count()
const activeAfterClose = await page.locator('.pane-tab[aria-selected="true"]').textContent()
check('pane: close activates neighbor', tabs3 === 1 && activeAfterClose?.includes('任务'), `${tabs3} tabs, active=${activeAfterClose}`)

// 5. reopen via + (closed tab reopens idempotently — same id replaces)
await page.locator('button[title="打开面板"]').click()
await page.locator('.absolute >> text=定时任务').last().click()
await page.waitForTimeout(300)
check('pane: closed home reopens via +', (await page.locator('.pane-tab').count()) === 2)

// 6. persistence: reload → tabs survive (localStorage contract)
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)
await page.locator('main header button[title*="右栏"]').click()
await page.waitForTimeout(500)
check('pane: tabs persist across reload', (await page.locator('.pane-tab').count()) === 2)

// 7. overflow shrink: open all 6 homes — tabs shrink (min 60px) not overflow
for (const name of ['子代理', 'MCP', 'Skills', '文件']) {
  await page.locator('button[title="打开面板"]').click()
  await page.locator('.absolute >> text=' + name).last().click()
  await page.waitForTimeout(150)
}
const widths = await page.evaluate(() => [...document.querySelectorAll('.pane-tab')].map((t) => t.getBoundingClientRect().width))
const stripW = await page.evaluate(() => document.querySelector('.pane-tabs')?.getBoundingClientRect().width)
const overflowOk = widths.every((w) => w >= 59) && widths.reduce((a, b) => a + b, 0) <= stripW + 2
check('pane: 6 tabs shrink within the strip (min 60px)', overflowOk, `${widths.map((w) => Math.round(w)).join(',')} in ${Math.round(stripW)}px`)

// 8. screenshot
await page.screenshot({ path: '/tmp/ocrc-rebuild/m3-sidepane.png' })

// 9. console clean
check('console: zero errors', errors.length === 0, errors.slice(0, 3).join(' | '))
await ctx.close()
process.exit(process.exitCode ?? 0)
