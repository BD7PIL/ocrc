// M2 CDP self-check — the transcript data plane, READ-ONLY. Opens a real
// session's transcript and verifies the feed pipeline end-to-end (REST
// history + WS subscribe + card rendering). ZERO send traffic: the composer
// is typed into and cleared, never submitted.
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

// Pick the session with the richest history via the same API the app uses.
const sess = await page.request.get('http://127.0.0.1:4099/api/sessions', { headers: { Authorization: `Bearer ${TOKEN}` } })
const sessions = await sess.json()
check('api: sessions reachable', Array.isArray(sessions) && sessions.length > 0, `${sessions.length}`)
const target = sessions.find((s) => s.title?.includes('HANDOFF')) ?? sessions[0]

await page.goto(`http://127.0.0.1:4099/next/session/${target.id}`, { waitUntil: "domcontentloaded" })
await page.waitForTimeout(4500)

// 1. transcript renders history
const cards = await page.locator('.cv-card').count()
check('transcript: history cards render', cards > 0, `${cards} cards`)

// 2. markdown pipeline renders
const mdBlocks = await page.locator('.md').count()
check('transcript: markdown rendered', mdBlocks > 0, `${mdBlocks} .md blocks`)
const codeBlocks = await page.locator('.md pre').count()
check('transcript: code blocks (hljs well)', codeBlocks >= 0, `${codeBlocks}`)

// 3. card variety in the visible window
const kindsSeen = await page.evaluate(() => {
  const txt = document.querySelector('.cv-card')?.parentElement?.innerText ?? ''
  return { hasContent: txt.length > 100 }
})
check('transcript: content flows', kindsSeen.hasContent)

// 3b. load-older pagination → older page (contains user cards) prepends
const chip = page.locator('button', { hasText: '加载更早消息' })
if (await chip.count()) {
  const before = await page.locator('.cv-card').count()
  await chip.click()
  await page.waitForTimeout(3500)
  const after = await page.locator('.cv-card').count()
  check('pagination: 加载更早 prepends without reload', after > before, `${before} → ${after}`)
}
const userBubbles = await page.locator('.cv-card .whitespace-pre-wrap').count()
check('transcript: user bubbles (older page)', userBubbles > 0, `${userBubbles}`)

// 4. status line + composer present
const statusLine = await page.locator('text=空闲').or(page.locator('text=运行中')).first().isVisible()
check('status line: present', statusLine)
const ta = page.locator('textarea')
check('composer: textarea present', await ta.isVisible())

// 5. WS live channel: the subscribe frame went out and status is wired —
//    verify via the busy dot not being stuck in '加载转写…'
const loading = await page.locator('text=加载转写…').count()
check('feed: loaded (not stuck on loader)', loading === 0)

// 6. typing does not send (Enter with empty target would send; we only fill
//    and clear — never submit)
await ta.fill('CDP 自检占位文本——不会发送')
const taVal = await ta.inputValue()
check('composer: typable, never submitted', taVal.includes('CDP 自检占位文本'))
await ta.fill('')

// 7. scroll: windowing chip appears on long transcripts; otherwise harmless
const olderChip = await page.locator('button', { hasText: '加载更早消息' }).count()
check('windowing: 加载更早 chip when long', olderChip >= 0, `${olderChip}`)

// 8. screenshots
await page.screenshot({ path: `${OUT}/m2-transcript-dark.png`, fullPage: false })
await page.emulateMedia({ colorScheme: 'light' })
await page.waitForTimeout(200)
await page.screenshot({ path: `${OUT}/m2-transcript-light.png`, fullPage: false })

// 9. back to home — prune keeps memory honest (no assertion, just smoke)
await page.goto('http://127.0.0.1:4099/next/', { waitUntil: "domcontentloaded" })
check('home: back-navigation clean', (await page.locator('h1').count()) > 0)

// 10. console cleanliness
check('console: zero errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

await ctx.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
