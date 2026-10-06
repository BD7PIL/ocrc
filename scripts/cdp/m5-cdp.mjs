// M5-1 CDP self-check — SettingsPage. READ-ONLY on the real config: the raw
// editor's validation-failure path is exercised with a broken draft but the
// confirm step is NEVER completed for valid content (no real config writes).
import { createRequire } from 'node:module'
const require = createRequire(new URL('../../web-next/package.json', import.meta.url))
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
await page.goto('http://127.0.0.1:4099/settings', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)

// 1. page renders with the real config path + provider table
check('settings: route renders', (await page.locator('h1', { hasText: '设置' }).count()) === 1)
const providerRows = await page.locator('section button.rounded-\\[9px\\]').count()
check('settings: provider rows from real config', providerRows > 0, `${providerRows} providers`)

// 2. config path shown
const pathShown = await page.locator('.mono[title*="opencode"]').count()
check('settings: config path shown', pathShown > 0)

// 3. provider editor opens on click (baseURL + write-only key + 拉取模型)
const firstProvider = page.locator('section button.rounded-\\[9px\\]').first()
await firstProvider.click()
await page.waitForTimeout(300)
check('editor: baseURL field', (await page.locator('span.label', { hasText: 'baseURL' }).count()) === 1)
check('editor: write-only key field', (await page.locator('input[type="password"]').count()) === 1)
const pullBtn = page.locator('button', { hasText: '拉取模型列表' })
check('editor: 拉取模型列表 button', (await pullBtn.count()) === 1)

// 4. fetch-models error path: a bogus baseURL → host 502 → error surfaced
//    (read-only: no config write involved)
await page.locator('span.label', { hasText: 'baseURL' }).locator('..').locator('input').fill('http://127.0.0.1:1/v1')
await pullBtn.click()
await page.waitForTimeout(2500)
const errShown = await page.locator('section .flex.flex-col.gap-3 p, [style*="--err"]').count()
check('fetch-models: unreachable endpoint surfaces error', errShown > 0)

// 5. raw editor: loads the real file, validation-failure path writes NOTHING
const editorTabText = await page.locator('.label', { hasText: '原文' }).count()
check('raw editor: section present', editorTabText === 1)
const ta = page.locator('section textarea')
check('raw editor: real content loaded', ((await ta.inputValue()).length) > 10)
// break the draft, arm, confirm → host 400 → error shown, and the file on
// disk is UNCHANGED (verify via the API before/after)
const before = await page.request.get('http://127.0.0.1:4099/api/settings/opencode-config', { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.json())
await ta.fill('{ broken!!')
await page.locator('button', { hasText: '保存原文' }).click()
await page.waitForTimeout(200)
await page.locator('button', { hasText: '确认写入配置文件' }).click()
await page.waitForTimeout(2000)
const after = await page.request.get('http://127.0.0.1:4099/api/settings/opencode-config', { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.json())
check('validation: broken JSONC rejected', after.raw === before.raw, 'file unchanged')
const valError = await page.evaluate(() => document.body.innerText.includes('JSONC 校验失败'))
check('validation: error surfaced in UI', valError)

// 6. screenshots
await page.screenshot({ path: '/tmp/ocrc-rebuild/m5-settings.png' })

// 7. console clean
const realErrors = errors.filter((e) => !/Failed to load resource/.test(e))
check('console: zero errors (resource 404/502 noise filtered)', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))
await ctx.close()
process.exit(process.exitCode ?? 0)
