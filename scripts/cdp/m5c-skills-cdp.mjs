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
await page.goto('http://127.0.0.1:4099/settings', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)

// fixture: a temp source with two skills
const fs = await import('node:fs')
const os = await import('node:os')
const path = await import('node:path')
const src = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-src-'))
for (const n of ['demo-alpha', 'demo-beta']) {
  fs.mkdirSync(path.join(src, n))
  fs.writeFileSync(path.join(n ? path.join(src, n) : '', 'SKILL.md'), `---\ndescription: ${n} demo\n---\nbody`)
}

// register the source via the UI
await page.locator('section', { hasText: '技能源管理' }).first().locator('input').fill(src)
await page.locator('section', { hasText: '技能源管理' }).first().locator('button', { hasText: '注册' }).click()
await page.waitForTimeout(800)

const rows = await page.locator('section', { hasText: '技能源管理' }).first().locator('button[role="switch"]').count()
check('skills: 2 skills scanned from registered source', rows === 2, `${rows} switches`)

// toggle demo-alpha ON → symlink appears in effective dir
await page.locator('section', { hasText: '技能源管理' }).first().locator('button[role="switch"]').first().click()
await page.waitForTimeout(600)
const home = process.env.HOME
const link = path.join(home, '.config', 'opencode', 'skills', 'demo-alpha')
const linkOn = fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink()
check('toggle ON: symlink created in effective dir', linkOn, link)

// toggle OFF → symlink removed
await page.locator('section', { hasText: '技能源管理' }).first().locator('button[role="switch"]').first().click()
await page.waitForTimeout(600)
const linkOff = fs.existsSync(link)
check('toggle OFF: symlink removed', !linkOff)

// cleanup fixture + unregister source
fs.rmSync(src, { recursive: true, force: true })
await page.locator('section', { hasText: '技能源管理' }).first().locator('button[title="重新扫描"]').click()
await page.screenshot({ path: '/tmp/ocrc-rebuild/m5c-skills.png' })
check('console: zero errors', errors.length === 0, errors.slice(0, 3).join(' | '))
await ctx.close()
process.exit(process.exitCode ?? 0)
