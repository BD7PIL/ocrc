import { chromium } from 'playwright'
const TOKEN = process.env.TOKEN
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = await browser.newContext()
await ctx.addInitScript((t) => localStorage.setItem('ocrc.token', t), TOKEN)
const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 150)))
await page.goto('http://127.0.0.1:4099/next/session/ses_f23a3c587ffejiT55j036fj1EK', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(4500)
const fixed = await page.evaluate(() => {
  const els = [...document.querySelectorAll('.fixed.right-4')]
  return els.map((e) => ({ cls: e.className.slice(0, 50), text: (e.textContent || '').slice(0, 60), display: getComputedStyle(e).display }))
})
console.log(JSON.stringify(fixed))
await ctx.close()
process.exit(0)
