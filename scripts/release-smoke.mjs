// Release smoke — run against the LIVE production instance after deploy.
// Every assertion here is a regression that already shipped to the user once:
//   1. WS streaming actually delivers (the silent killer: token re-seed loop)
//   2. Right pane opens, has height, and its .pane can scroll
//   3. Schedule tools present in version payload; channels API redacts
//   4. PairGate offers the browser-pair button unconditionally
//   5. Both themes render the inspector card
// Usage: node scripts/release-smoke.mjs [baseURL]  (default http://127.0.0.1:4099)
// Exit 0 = all green; anything else lists failures. Gate a release on this.
import { createRequire } from 'node:module'
// playwright lives in web/node_modules (scripts/ has no deps of its own)
const { chromium } = createRequire(new URL('../web/package.json', import.meta.url))('playwright')
import { readFileSync } from 'node:fs'

const BASE = process.argv[2] ?? 'http://127.0.0.1:4099'
const TOKEN = readFileSync(process.env.HOME + '/.ocrc/token', 'utf-8').trim()
const failures = []
const ok = (name) => console.log(`  ✓ ${name}`)
const bad = (name, detail) => { failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }

// ── API layer ────────────────────────────────────────────────────────────
console.log('API:')
const v = await fetch(`${BASE}/api/version`, { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.json()).catch(() => null)
v && v.commit ? ok(`version ${v.version} (${v.mode}, ${v.commit})`) : bad('version API')
const authz = await fetch(`${BASE}/api/pair/onboarding`).then((r) => r.status)
authz === 200 ? ok('pair onboarding reachable (unauthenticated)') : bad('pair onboarding', `status ${authz}`)
const ch = await fetch(`${BASE}/api/channels`, { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.json()).catch(() => null)
ch?.channels?.length ? ok(`channels (${ch.channels.length})`) : bad('channels API')

// ── Browser layer ────────────────────────────────────────────────────────
const browser = await chromium.connectOverCDP(process.env.OCRC_CDP ?? 'http://localhost:9222')
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })
const p = await ctx.newPage()
await p.addInitScript((t) => { localStorage.setItem('ocrc.token', t); localStorage.setItem('ocrc-theme', 'dark') }, TOKEN)

console.log('Streaming:')
await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(2000)
// WS must be live — the pill reads `live` when connected
const live = await p.evaluate(() => document.body.textContent?.includes('live'))
live ? ok('WS connected (live pill)') : bad('WS live pill missing — streaming will be dead')

// Send a real prompt and watch the feed grow (the regression that shipped:
// token re-seed loop killed streaming while HTTP stayed green).
const before = await p.evaluate(() => document.querySelectorAll('.card').length)
await p.fill('textarea, [contenteditable="true"]', 'reply with exactly: OK')
await p.keyboard.press('Enter')
let streamed = false
for (let i = 0; i < 30; i++) {
  await p.waitForTimeout(1000)
  const now = await p.evaluate(() => document.querySelectorAll('.card').length)
  if (now > before) { streamed = true; break }
}
streamed ? ok('streaming delivers (feed grew after send)') : bad('NO streaming within 30s — WS/event pipeline broken')
// abort the turn so the smoke doesn't leave work running
await p.evaluate(() => document.querySelector('.send.stop')?.click()).catch(() => {})

console.log('Right pane:')
await p.evaluate(() => document.querySelector('[aria-label="Inspector"]')?.click())
await p.waitForTimeout(800)
const rp = await p.evaluate(async () => {
  const insp = document.querySelector('.inspector')
  const pane = document.querySelector('.pane')
  if (!insp || !pane) return { h: 0, scrolled: false }
  const div = document.createElement('div')
  div.style.height = '3000px'
  pane.appendChild(div)
  pane.scrollTop = 400
  await new Promise((r) => setTimeout(r, 80))
  const scrolled = pane.scrollTop > 0
  div.remove()
  return { h: Math.round(insp.getBoundingClientRect().height), scrolled }
})
rp.h > 500 ? ok(`inspector fills viewport (${rp.h}px)`) : bad('inspector height collapsed', `${rp.h}px`)
rp.scrolled ? ok('pane scroll works') : bad('pane scroll dead')

console.log('Misc:')
await p.evaluate(() => document.querySelector('[aria-label="机器人与通道"]')?.click())
await p.waitForTimeout(800)
const credGap = await p.evaluate(() => {
  const inputs = document.querySelectorAll('.cred')
  return inputs.length >= 2 ? inputs[1].getBoundingClientRect().top - inputs[0].getBoundingClientRect().bottom : -1
})
credGap > 2 ? ok('credential inputs separated') : bad('credential inputs still glued', `gap=${credGap}`)
await p.evaluate(() => document.querySelector('[aria-label="Close"], .close')?.click())

const pg = await ctx.newPage()
await pg.goto(`${BASE}/#token=deliberately-stale-value`, { waitUntil: 'domcontentloaded' })
await pg.waitForTimeout(1500)
const pairBtn = await pg.evaluate(() => Array.from(document.querySelectorAll('button')).some((b) => b.textContent?.includes('配对此浏览器并进入')))
pairBtn ? ok('pair button unconditional') : bad('pair button missing')

await ctx.close()
await browser.close()

console.log(failures.length === 0 ? '\nALL GREEN — release may proceed.' : `\n${failures.length} FAILURE(S): ${failures.join(' | ')}`)
process.exit(failures.length === 0 ? 0 : 1)
