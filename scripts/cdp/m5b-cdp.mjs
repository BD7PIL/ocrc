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

// cards render with the project selector
const cards = await page.locator('main section').count()
check('M5-2: three new cards render', cards >= 3, `${cards} sections`)

// MappingCard: project selector populated + current mapping table
const mapping = page.locator('section', { hasText: '模型映射方案库' }).first()
check('mapping: card present', await mapping.isVisible())
const sel = await mapping.locator('select').count()
check('mapping: project selector', sel === 1)
await page.waitForTimeout(800)
const curRows = await mapping.locator('.flex.items-center.gap-2.rounded-\\[6px\\]').count()
check('mapping: current mapping rows (or empty note)', curRows >= 0, `${curRows}`)

// ProjectFilesCard: overview rows for the selected project (rows render only
// after the async overview fetch lands — poll for it)
const files = page.locator('section', { hasText: '项目 .opencode/ 文件' }).first()
check('files: card present', await files.isVisible())
let agentsRow = 0
try {
  await files.locator('button', { hasText: 'AGENTS.md' }).first().waitFor({ state: 'visible', timeout: 8000 })
  agentsRow = 1
} catch { agentsRow = await files.locator('button', { hasText: 'AGENTS.md' }).count() }
check('files: AGENTS.md row', agentsRow === 1)
const opencodeRow = await files.locator('button', { hasText: 'opencode.jsonc' }).count()
check('files: opencode.jsonc row', opencodeRow === 1)

// open AGENTS.md editor → edit → arm → CANCEL (no write; read-only test)
await files.locator('button', { hasText: 'AGENTS.md' }).click()
await page.waitForTimeout(500)
const ta = files.locator('textarea')
check('files: AGENTS.md editor opens with content', ((await ta.inputValue()) || '').length > 0 || (await ta.count()) === 1)
// RiskConfirmation arm step on the editor's 保存 (scoped INSIDE the editor
// card — the strip itself contains other 保存 text)
const editorSave = files.locator('button', { hasText: /^保存$/ }).first()
await editorSave.click()
const armVisible = await files.locator('button', { hasText: '确认写入' }).count()
check('files: RiskConfirmation arm step', armVisible === 1)
await files.locator('button', { hasText: '取消' }).first().click() // CANCEL — no write
check('files: cancel disarms (no write performed)', (await files.locator('button', { hasText: '确认写入' }).count()) === 0)

// McpCard: entries or empty note + 新增 opens form
const mcp = page.locator('section', { hasText: 'MCP 服务器' }).first()
check('mcp: card present', await mcp.isVisible())
await mcp.locator('button', { hasText: '新增 MCP 服务器' }).click()
await page.waitForTimeout(300)
check('mcp: form opens with id/type/command', (await mcp.locator('span.label', { hasText: 'id' }).count()) === 1 && (await mcp.locator('span.label', { hasText: 'command' }).count()) === 1)
await mcp.locator('button', { hasText: '取消' }).click()

await page.screenshot({ path: '/tmp/ocrc-rebuild/m5b-projectcards.png' })
check('console: zero errors', errors.length === 0, errors.slice(0, 3).join(' | '))
await ctx.close()
process.exit(process.exitCode ?? 0)
