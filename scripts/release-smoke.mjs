// Release smoke — gates a release.
//   1. Read-only API checks against the LIVE production instance.
//   2. Read-only UI checks against production (pane, modal, pair gate).
//   3. The STREAMING send test runs against an ISOLATED stack — a mock
//      opencode engine (scripts/mock-opencode.mjs, port 4098) behind a
//      throwaway ocrc host (port 4199, temp state, own token). It NEVER
//      sends through the user's real engine: ADOPT means every smoke send
//      used to land in the user's 4096 as a real session and burn real
//      tokens (this shipped as an incident on 2026-10-06).
// Usage: node scripts/release-smoke.mjs [prodURL]  (default http://127.0.0.1:4099)
// Exit 0 = all green; anything else lists failures.
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// playwright lives in web-next/node_modules (scripts/ has no deps of its own;
// the old ../web path broke when the Svelte shell was removed). web-next is
// frozen since the base swap, but its node_modules still carries playwright —
// repo root devDeps are the fallback if that ever disappears.
function resolvePlaywright() {
  const bases = ['../web-next/package.json', '../package.json']
  for (const base of bases) {
    try { return createRequire(new URL(base, import.meta.url))('playwright') } catch { /* next */ }
  }
  throw new Error('playwright not resolvable from web-next/ or repo root')
}
const { chromium } = resolvePlaywright()

const BASE = process.argv[2] ?? 'http://127.0.0.1:4099'
const PROD_TOKEN = readFileSync(process.env.HOME + '/.ocrc/token', 'utf-8').trim()
const ISO_PORT = 4199
const ISO_BASE = `http://127.0.0.1:${ISO_PORT}`
const ISO_TOKEN = 'ocrc-release-smoke-token'
const MOCK_PORT = 4098
const failures = []
const cleanup = []
const ok = (name) => console.log(`  ✓ ${name}`)
const bad = (name, detail) => { failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }

function spawnDetached(cmd, args, env) {
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', () => {})
  child.stderr.on('data', (d) => { if (process.env.OCRC_SMOKE_VERBOSE) process.stderr.write(d) })
  cleanup.push(() => { try { child.kill('SIGTERM') } catch { /* gone */ } })
  return child
}

async function waitReady(url, headers, tries = 30) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers })
      if (r.ok) return true
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}

// ── 1. Production API (read-only) ────────────────────────────────────────
console.log('API (production, read-only):')
const v = await fetch(`${BASE}/api/version`, { headers: { Authorization: `Bearer ${PROD_TOKEN}` } }).then((r) => r.json()).catch(() => null)
v && v.commit ? ok(`version ${v.version} (${v.mode}, ${v.commit})`) : bad('version API')
const authz = await fetch(`${BASE}/api/pair/onboarding`).then((r) => r.status)
authz === 200 ? ok('pair onboarding reachable (unauthenticated)') : bad('pair onboarding', `status ${authz}`)
const ch = await fetch(`${BASE}/api/channels`, { headers: { Authorization: `Bearer ${PROD_TOKEN}` } }).then((r) => r.json()).catch(() => null)
ch?.channels?.length ? ok(`channels (${ch.channels.length})`) : bad('channels API')

// ── 2. Isolated stack for the streaming test ─────────────────────────────
console.log('Isolated stack (mock engine + throwaway host):')
const statePath = join(tmpdir(), `ocrc-smoke-state-${Date.now()}.json`)
spawnDetached('node', [new URL('./mock-opencode.mjs', import.meta.url).pathname, String(MOCK_PORT)])
const host = spawnDetached(process.execPath, [new URL('../dist/cli/index.js', import.meta.url).pathname, 'host'], {
  OCRC_BACKENDS: 'opencode',
  OCRC_SERVER_URL: `http://127.0.0.1:${MOCK_PORT}`,
  OCRC_WEB_ENABLED: 'true',
  OCRC_WEB_PORT: String(ISO_PORT),
  OCRC_WEB_TOKEN: ISO_TOKEN,
  OCRC_STATE_PATH: statePath,
  LOG_LEVEL: 'warn',
})
const engineUp = await waitReady(`http://127.0.0.1:${MOCK_PORT}/config`, {})
engineUp ? ok('mock engine up (4098)') : bad('mock engine failed to start')
const hostUp = await waitReady(`${ISO_BASE}/api/version`, { Authorization: `Bearer ${ISO_TOKEN}` })
hostUp ? ok(`isolated host up (4199)`) : bad('isolated host failed to start — see host log')

if (engineUp && hostUp) {
  const created = await fetch(`${ISO_BASE}/api/session`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ISO_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ directory: process.cwd(), title: 'release smoke' }),
  }).then((r) => r.json()).catch(() => null)
  const isoSid = created?.id
  isoSid ? ok(`isolated session created (${isoSid.slice(-8)})`) : bad('isolated session create')

  const browser = await chromium.connectOverCDP(process.env.OCRC_CDP ?? 'http://localhost:9222')
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })
  const p = await ctx.newPage()
  await p.addInitScript((t) => { localStorage.setItem('ocrc.token', t); localStorage.setItem('ocrc-theme', 'dark') }, ISO_TOKEN)

  console.log('Streaming (isolated — cannot touch the user engine):')
  await p.goto(`${ISO_BASE}/${isoSid}`, { waitUntil: 'domcontentloaded' })
  await p.waitForTimeout(2000)
  const live = await p.evaluate(() => document.body.textContent?.includes('live'))
  live ? ok('WS connected (live pill)') : bad('WS live pill missing — streaming will be dead')

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
  await p.evaluate(() => document.querySelector('.send.stop')?.click()).catch(() => {})
  await ctx.close()
  await browser.close()
} else {
  bad('streaming check skipped — isolated stack did not come up')
}

// ── 3. Production UI (read-only interactions) ────────────────────────────
{
  const browser = await chromium.connectOverCDP(process.env.OCRC_CDP ?? 'http://localhost:9222')
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })
  const p = await ctx.newPage()
  await p.addInitScript((t) => { localStorage.setItem('ocrc.token', t); localStorage.setItem('ocrc-theme', 'dark') }, PROD_TOKEN)

  console.log('Right pane (production, read-only):')
  await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await p.waitForTimeout(2000)
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
}

// ── teardown ─────────────────────────────────────────────────────────────
for (const fn of cleanup) { try { fn() } catch { /* already gone */ } }
try { if (statePath && existsSync(statePath)) rmSync(statePath, { force: true }) } catch { /* tmp */ }

console.log(failures.length === 0 ? '\nALL GREEN — release may proceed.' : `\n${failures.length} FAILURE(S): ${failures.join(' | ')}`)
process.exit(failures.length === 0 ? 0 : 1)
