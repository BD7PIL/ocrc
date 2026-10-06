// M4-1 CDP self-check — 新建任务页 two-state + provisioning UI, READ-ONLY
// (no real save/inspect/provision: those hit SSH; UI states asserted instead).
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
await page.waitForTimeout(3000)

// open the dialog via Ctrl+N
await page.keyboard.press('Control+n')
await page.waitForTimeout(400)

// 1. segmented 本地|远程
check('dialog: 本地/远程 segmented', (await page.locator('[role="dialog"] button', { hasText: '远程连接' }).count()) === 1)

// 2. local tab: engine chips + directory (regression)
const localChips = await page.locator('[role="dialog"] button.rounded-full').count()
check('local: engine chips', localChips > 0, `${localChips}`)

// 3. remote tab: form fields render
await page.locator('[role="dialog"] button', { hasText: '远程连接' }).click()
await page.waitForTimeout(300)
const fields = await page.locator('[role="dialog"] input').count()
check('remote: form fields (5)', fields === 5, `${fields}`)
check('remote: 保存并探测 present', (await page.locator('[role="dialog"] button', { hasText: '保存并探测' }).count()) === 1)

// 4. validation: 探测 disabled without host
const probeBtnDisabled = await page.locator('[role="dialog"] button', { hasText: '保存并探测' }).isDisabled()
check('remote: probe disabled without host', probeBtnDisabled === true)

// 5. TWO-STATE cards render from a synthetic inspection (the dialog reads
//    inspection from its own state — drive it via the component contract by
//    running probe against an unreachable host would error; instead verify
//    the three UI outcomes exist in the bundle)
const bundle = await page.evaluate(async () => {
  const js = performance.getEntriesByType('resource').filter((r) => r.name.includes('index-')).map((r) => r.name)[0]
  const src = await fetch(js).then((r) => r.text())
  return {
    adopt: src.includes('接入已有引擎'),
    spawn: src.includes('接入并拉起 serve'),
    push: src.includes('推送本机二进制'),
    selfInstall: src.includes('远端自装'),
    runtime: src.includes('运行时注册，无需重启'),
  }
})
check('two-state: adopt card in bundle', bundle.adopt)
check('two-state: spawn card in bundle', bundle.spawn)
check('provisioning: push path in bundle', bundle.push)
check('provisioning: self-install path in bundle', bundle.selfInstall)
check('wart fix: runtime registration messaging in bundle', bundle.runtime)

// 6. Escape closes
await page.keyboard.press('Escape')
await page.waitForTimeout(200)
check('dialog: Escape closes', !(await page.locator('[role="dialog"]').isVisible().catch(() => false)))

// 7. screenshots (dialog open again for the record)
await page.keyboard.press('Control+n')
await page.waitForTimeout(300)
await page.locator('[role="dialog"] button', { hasText: '远程连接' }).click()
await page.waitForTimeout(250)
await page.screenshot({ path: '/tmp/ocrc-rebuild/m4-newsession-remote.png' })

// 8. console clean
check('console: zero errors', errors.length === 0, errors.slice(0, 3).join(' | '))
await ctx.close()
process.exit(process.exitCode ?? 0)
