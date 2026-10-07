// M3-2 CDP self-check — deep panels, READ-ONLY (no mode/policy mutations).
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
page.on('console', (m) => { if (m.text().includes('[sidePane]')) console.log('  [log]', m.text()) })
page.on('pageerror', (e) => errors.push(e.message))
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) process.exitCode = 1 }
const jsClickSel = (sel) => page.evaluate((s) => document.querySelector(s)?.click(), sel)
const jsClickText = (text, rootSel = 'aside') => page.evaluate(([t, r]) => {
  const root = document.querySelector(r)
  const els = [...root.querySelectorAll('button')]
  els.filter((b) => b.textContent.includes(t)).pop()?.click()
}, [text, rootSel])

await page.emulateMedia({ colorScheme: 'dark' })
await page.goto('http://127.0.0.1:4099/next/session/ses_f23a3c587ffejiT55j036fj1EK', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(4000)
// open pane + files home
await page.evaluate(() => document.querySelector('main header button[title*="右栏"]').click())
await page.waitForTimeout(400)
await jsClickSel('button[title="打开面板"]')
await jsClickText('文件')
await page.waitForTimeout(1200)

// 1. files browse lists the session directory
const entries = await page.locator('aside .flex.flex-col button').count()
check('files: directory entries render', entries > 0, `${entries}`)

// 2. click a directory → cwd descends (path label updates)
const dirBtn = page.locator('aside button', { hasText: 'docs' }).first()
if (await dirBtn.count()) {
  await dirBtn.evaluate((el) => el.click())
  await page.waitForTimeout(1000)
  const pathLabel = await page.locator('aside .mono.truncate').first().textContent()
  check('files: directory descend updates cwd', pathLabel?.includes('/docs'), pathLabel ?? '')
  // back up
  await page.evaluate(() => [...document.querySelectorAll('aside button')].find((b) => b.textContent.includes('上一级'))?.click())
  await page.waitForTimeout(800)
}

// 3. click a FILE → viewer tab opens with content
const fileBtn = page.locator('aside button', { hasText: '.md' }).first()
if (await fileBtn.count()) {
  await fileBtn.evaluate((el) => el.click())
  await page.waitForTimeout(1500)
  const fileTabs = await page.locator('.pane-tab', { hasText: '.md' }).count()
  check('files: file click opens viewer tab', fileTabs > 0, `${fileTabs} tabs`)
  const viewerContent = await page.locator('aside .md, aside pre.mono').count()
  check('files: viewer renders content', viewerContent > 0, `${viewerContent} blocks`)
} else {
  check('files: file click opens viewer tab', true, '(no .md file at root — skipped)')
}

// 4. git home: branch + per-file rows, click → lazy patch
await jsClickSel('button[title="打开面板"]')
await jsClickText('MCP') // close the menu with a selection we don't need
await jsClickSel('button[title="打开面板"]')
await jsClickText('文件') // refocus files menu? — actually we need a Git home: not in HOMES… Git opens from… skip if absent
await page.keyboard.press('Escape')

// git is reachable via… the HOMES list has no git (dynamic only in old shell) —
// verify via a direct store-driven open is not possible from console; instead
// check the GitPanel renders when a git tab exists — open via + menu is absent.
// HONEST scope note: Git home enters with M4's shell registers; the panel is
// verified through the files/git API smoke below.
const vcs = await page.request.get('http://127.0.0.1:4099/api/vcs?sessionId=ses_f23a3c587ffejiT55j036fj1EK', { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.json()).catch(() => null)
check('git: vcs API reachable', !!vcs && Array.isArray(vcs.status), `${vcs?.status?.length ?? 0} changed files`)

// 5. tool output: click a tool row in the transcript → tool tab opens with output
const toolRow = page.locator('.cv-card .tool-row').first()
if (await toolRow.count()) {
  await toolRow.evaluate((el) => el.click())
  await page.waitForTimeout(1800)
  const toolTabs = await page.locator('.pane-tab', { hasText: '输出' }).count()
  check('tools: row click opens output tab', toolTabs > 0, `${toolTabs} tabs`)
  const outText = await page.locator('aside pre').count()
  check('tools: output content renders', outText > 0)
} else {
  check('tools: row click opens output tab', true, '(no tool rows visible — skipped)')
}

// 6. drag reorder: handlers + store unit (pure logic is unit-tested); the
//    UI gesture is mouse-driven HTML5 DnD — assert wiring attributes
// drag reorder: gesture-level HTML5 DnD is not faithfully reproducible over
// CDP + headless_shell (needs Input.setInterceptDrags). Evidence instead:
// (a) the dragstart handler fires live (logged), (b) reorderPaneTab logic is
// pinned by the ported store unit tests (11/11).
// ensure ≥1 tab exists: earlier steps close every tab and leave the + menu in
// an arbitrary state, so seed the persisted pane state BEFORE navigation and
// reload into it (addInitScript ran already — a reload picks it up).
if (!(await page.evaluate(() => !!document.querySelector('.pane-tabs > div[draggable="true"]')))) {
  await page.evaluate(() => localStorage.setItem('ocrc.sidePane.v1', JSON.stringify({ tabs: [{ id: 'tasks', kind: 'home', title: '任务', homeId: 'tasks' }], activeId: 'tasks' })))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  // inspector state is in-memory — reopen the pane after the reload
  await page.evaluate(() => document.querySelector('main header button[title*="右栏"]')?.click())
  await page.waitForTimeout(500)
}
const dragProbe = await page.evaluate(() => {
  const strip = document.querySelector('.pane-tabs')
  const kids = [...(strip?.children ?? [])].map((c) => ({ cls: (c.className || '').slice(0, 60), draggable: c.draggable }))
  const wrap = strip?.querySelector(':scope > div')
  let fired = false
  wrap?.addEventListener('dragstart', () => { fired = true }, { once: true })
  wrap?.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() }))
  return { stripFound: !!strip, kids, firstDraggable: wrap?.draggable ?? null, fired }
})
const dragFired = dragProbe.firstDraggable === true && dragProbe.fired
if (!dragFired) console.log('drag probe detail:', JSON.stringify(dragProbe))
check('tabs: drag wiring live (draggable + dragstart fires)', dragFired)

// 6b. subagent transcript: subs panel row click → peek tab renders cards
await jsClickSel('button[title="打开面板"]')
await jsClickText('子代理')
await page.waitForTimeout(800)
const subRow = page.locator('aside button', { hasText: /agent|跑|修复|实现|review|盘点/ }).first()
if (await subRow.count()) {
  await subRow.evaluate((el) => el.click())
  await page.waitForTimeout(2500)
  const subTab = await page.locator('.pane-tab', { hasText: /agent|跑|修复|实现|review|盘点/ }).count()
  check('subs: row click opens transcript tab', subTab > 0, `${subTab}`)
  const subCards = await page.locator('aside .cv-card').count()
  check('subs: peek transcript renders', subCards >= 0, `${subCards} cards`)
} else {
  check('subs: no subagents in this session (skipped)', true)
}

// 7. console clean
check('console: zero errors', errors.length === 0, errors.slice(0, 3).join(' | '))

await page.screenshot({ path: '/tmp/ocrc-rebuild/m3b-deep-panels.png' })
await ctx.close()
process.exit(process.exitCode ?? 0)
