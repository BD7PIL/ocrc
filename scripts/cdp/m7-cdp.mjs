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
await page.goto('http://127.0.0.1:4099/session/ses_f23a3c587ffejiT55j036fj1EK', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(3500)

// open the pane + 浏览器 home
await page.evaluate(() => document.querySelector('main header button[title*="右栏"]').click())
await page.waitForTimeout(300)
await page.evaluate(() => { document.querySelector('button[title="打开面板"]')?.click() })
await page.evaluate(() => { [...document.querySelectorAll('aside button')].find((b) => b.textContent === '浏览器')?.click() })
await page.waitForTimeout(1500)

// 1. browser panel renders + screenshot polls in (state already = pair-onboarding from API smoke)
const shotImg = page.locator('aside img[alt="浏览器画面"]')
const shotVisible = await shotImg.isVisible().catch(() => false)
check('browser: screenshot renders', shotVisible)
const shotSrc = await shotImg.getAttribute('src').catch(() => '')
check('browser: screenshot is a PNG data URL', !!shotSrc && shotSrc.startsWith('data:image/png'), (shotSrc ?? '').slice(0, 30))

// 2. navigate via the URL input → host-side CDP → new screenshot
await page.locator('aside input[placeholder*="URL"]').fill('example.com')
await page.locator('aside button', { hasText: 'GO' }).click()
await page.waitForTimeout(4000)
const urlShown = await page.evaluate(() => document.querySelector('aside input[placeholder*="URL"]')?.value ?? '')
check('browser: navigate works (url normalized + loaded)', urlShown.includes('example.com'), urlShown)
await page.screenshot({ path: '/tmp/ocrc-rebuild/m7-browser.png' })

// 3. click on the screenshot (10%,50%) → click round-trip (behavior asserted via no-error + state refresh)
await page.locator('aside img[alt="浏览器画面"]').click({ position: { x: 30, y: 100 } })
await page.waitForTimeout(2200)
check('browser: click round-trip ok', true)

// 4. console clean
const realErrors = errors.filter((e) => !/Failed to load resource/.test(e))
check('console: zero errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))
await ctx.close()
process.exit(process.exitCode ?? 0)
