// M0 CDP self-check — connectOverCDP to the EL7 headless_shell (:9222) and
// verify the web-next boot surface end-to-end: render, theme contract,
// three-layer tokens, font ladder, hairline elevation, corner-shape probing,
// theme button interaction, console cleanliness. Run: cd web && node m0-cdp.mjs
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const OUT = '/tmp/ocrc-rebuild'
mkdirSync(OUT, { recursive: true })

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
const consoleErrors = []
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))

await page.goto('http://127.0.0.1:4099/next/', { waitUntil: 'networkidle' })

// 1. render
const brand = page.locator('header span').first()
check('render: header brand dot visible', await brand.isVisible())

// 2. dark theme (emulated): accent = persimmon #fb8b3c
await page.emulateMedia({ colorScheme: 'dark' })
await page.waitForTimeout(120)
const accentDark = await brand.evaluate((el) => getComputedStyle(el).backgroundColor)
check('dark: accent = #fb8b3c', accentDark === 'rgb(251, 139, 60)', accentDark)
const bgDark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
check('dark: bg = #0d0d0d', bgDark === 'rgb(13, 13, 13)', bgDark)

// 3. font ladder: body base = 14px (--ui-base)
const bodyFont = await page.evaluate(() => getComputedStyle(document.body).fontSize)
check('font ladder: body = 14px', bodyFont === '14px', bodyFont)
const uiXl = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ui-xl').trim())
check('font ladder: --ui-xl = calc(14px + 4px)', uiXl === 'calc(14px + 4px)', uiXl)

// 4. hairline elevation: ElevBox box-shadow carries 0.5px inset ring
const elev = await page.locator('div', { hasText: '--elev-panel' }).last().evaluate((el) => getComputedStyle(el).boxShadow)
check('elevation: --elev-panel has 0.5px hairline', elev.includes('0.5px'), elev.slice(0, 60))

// 5. corner-shape probe text
const corner = await page.getByText(/superellipse 已启用|引擎回落普通圆角/).textContent()
check('corner-shape probe rendered', !!corner, corner ?? '')

// 6. light theme (emulated): accent = #e4580f, bg-canvas light neutral (≥821px)
await page.emulateMedia({ colorScheme: 'light' })
await page.waitForTimeout(120)
const accentLight = await brand.evaluate((el) => getComputedStyle(el).backgroundColor)
check('light: accent = #e4580f', accentLight === 'rgb(228, 88, 15)', accentLight)
const borderLight = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim())
check('light desktop: --bg = #f7f7f8 (neutral override)', borderLight === '#f7f7f8', borderLight)
await page.screenshot({ path: `${OUT}/m0-next-light.png`, fullPage: true })

// 7. theme button interaction: auto → light → dark → auto, attr + localStorage
await page.emulateMedia({ colorScheme: 'dark' }) // system dark so 'auto' == dark
const btn = page.locator('header button')
await btn.click() // auto → light: forced attribute even under dark emulation
const labelLight = await btn.textContent()
const attrAfterLight = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
const lsAfterLight = await page.evaluate(() => localStorage.getItem('ocrc-theme'))
check('theme btn: auto→light forces data-theme=light', attrAfterLight === 'light' && lsAfterLight === 'light', `attr=${attrAfterLight} ls=${lsAfterLight}`)
check('theme btn: label shows 浅色', !!labelLight?.includes('浅色'), labelLight ?? '')
const accentForcedLight = await brand.evaluate((el) => getComputedStyle(el).backgroundColor)
check('theme btn: forced light wins over dark emulation', accentForcedLight === 'rgb(228, 88, 15)', accentForcedLight)
await btn.click() // light → dark
const attrAfterDark = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
check('theme btn: light→dark', attrAfterDark === 'dark')
const accentForcedDark = await brand.evaluate((el) => getComputedStyle(el).backgroundColor)
check('theme btn: forced dark = #fb8b3c', accentForcedDark === 'rgb(251, 139, 60)', accentForcedDark)
await page.screenshot({ path: `${OUT}/m0-next-dark.png`, fullPage: true })
await btn.click() // dark → auto: attribute removed
const attrAfterAuto = await page.evaluate(() => [document.documentElement.getAttribute('data-theme'), localStorage.getItem('ocrc-theme')])
check('theme btn: dark→auto clears attr + key', attrAfterAuto[0] === null && attrAfterAuto[1] === null, JSON.stringify(attrAfterAuto))

// 8. focus modality: pointer click sets pointer modality + no ring; Tab sets
//    keyboard modality + accent ring (the modality rule's real mechanism).
await page.locator('.demo-btn').first().click()
const modalityAfterClick = await page.evaluate(() => document.documentElement.dataset.inputModality)
const outlineAfterClick = await page.locator('.demo-btn').first().evaluate((el) => getComputedStyle(el).outlineStyle)
check('focus: pointer click → modality=pointer, ring suppressed', modalityAfterClick === 'pointer' && outlineAfterClick === 'none', `modality=${modalityAfterClick} outline=${outlineAfterClick}`)
await page.keyboard.press('Tab')
const modalityAfterTab = await page.evaluate(() => document.documentElement.dataset.inputModality)
const ringAfterTab = await page.evaluate(() => {
  const el = document.activeElement
  return el ? getComputedStyle(el).outlineColor : 'none'
})
check('focus: keyboard Tab → modality=keyboard + visible ring', modalityAfterTab === 'keyboard' && ringAfterTab === 'rgb(251, 139, 60)', `modality=${modalityAfterTab} ring=${ringAfterTab}`)

// 9. console cleanliness
check('console: zero errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

await ctx.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
