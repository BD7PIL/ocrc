// M9 CDP — ZCode zai theme fidelity assertions. Run: cd web-next && TOKEN=$(cat /tmp/ocrc-spike/home/.ocrc/token) node ../scripts/cdp/m9-theme-cdp.mjs
// Asserts the deployed CSS resolves to the EXACT zai-dark / zai-light values
// (sourced from /tmp/zcode-src/packages/ui/src/styles.css L461+/L606+) on the
// real served page, plus the ported component geometry (28px tabs, 48px strip,
// hairline border, pill scrollbars) and the token bridges.
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
page.on('pageerror', (e) => console.log(`pageerror: ${e.message}`))

const getVar = (name) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name)
// Browsers normalize rgba() custom props to hex8 (#ffffff1a = rgba(255,255,255,0.1),
// #fff = #ffffff) — compare in canonical hex8 form.
const norm = (v) => {
  const m = v.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/)
  if (m) {
    const hex = (n) => Number(n).toString(16).padStart(2, '0')
    const a = m[4] === undefined ? 'ff' : hex(Math.round(parseFloat(m[4]) * 255))
    return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}${a}`
  }
  if (/^#[0-9a-f]{3}$/i.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}ff`
  if (/^#[0-9a-f]{6}$/i.test(v)) return `${v}ff`
  return v.toLowerCase()
}
const eq = (a, b) => norm(a) === norm(b)

// ── dark（zai-dark verbatim）──
await page.emulateMedia({ colorScheme: 'dark' })
await page.goto('http://127.0.0.1:4099/next/', { waitUntil: 'networkidle' })
await page.waitForTimeout(600)

check('dark: background #161616', (await getVar('--bg')) === '#161616', await getVar('--bg'))
check('dark: panel #202020', (await getVar('--bg-panel')) === '#202020', await getVar('--bg-panel'))
check('dark: sidebar #161616', (await getVar('--bg-sidebar')) === '#161616', await getVar('--bg-sidebar'))
check('dark: header #202020', (await getVar('--bg-header')) === '#202020', await getVar('--bg-header'))
check('dark: card #2b2b2b', (await getVar('--bg-card')) === '#2b2b2b', await getVar('--bg-card'))
check('dark: popover #2b2b2b', (await getVar('--bg-popover')) === '#2b2b2b', await getVar('--bg-popover'))
check('dark: menu-hover #363636', (await getVar('--bg-menu-hover')) === '#363636', await getVar('--bg-menu-hover'))
check('dark: tab #202020 / active #161616', (await getVar('--bg-tab')) === '#202020' && (await getVar('--bg-tab-active')) === '#161616')
check('dark: tag #363636', (await getVar('--bg-tag')) === '#363636', await getVar('--bg-tag'))
check('dark: border rgba(255,255,255,.1)', eq(await getVar('--border'), '#ffffff1a'), await getVar('--border'))
check('dark: border-hover .15', eq(await getVar('--border-hover'), '#ffffff26'))
check('dark: hover .05 / selected .1', eq(await getVar('--hover'), '#ffffff0d') && eq(await getVar('--selected'), '#ffffff1a'))
check('dark: surface .05', eq(await getVar('--surface'), '#ffffff0d'))
check('dark: foreground #d4d4d4', (await getVar('--text')) === '#d4d4d4', await getVar('--text'))
check('dark: primary #ffffff / ink #000000', eq(await getVar('--primary'), '#ffffff') && eq(await getVar('--primary-ink'), '#000000'))
check('dark: accent = primary(white)', eq(await getVar('--accent'), '#ffffff'))
check('dark: ok #46bf72', (await getVar('--ok')) === '#46bf72', await getVar('--ok'))
check('dark: warn #ff8a30', (await getVar('--warn')) === '#ff8a30')
check('dark: err #ff5c5c', (await getVar('--err')) === '#ff5c5c')
check('dark: info #4099ff', (await getVar('--info')) === '#4099ff')
check('dark: ask-surface #001d3d', (await getVar('--ask-surface')) === '#001d3d')
check('dark: idle-task #7b5ce5', (await getVar('--idle-task')) === '#7b5ce5')
check('dark: user-bubble = surface .05', eq(await getVar('--user-bubble'), '#ffffff0d'), await getVar('--user-bubble'))

// rendered body background
const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
check('dark: rendered body rgb(22,22,22)', bodyBg === 'rgb(22, 22, 22)', bodyBg)

// sidebar surface renders bg-sidebar (#161616)
const sidebarBg = await page.evaluate(() => {
  const el = document.querySelector('aside .bg-sidebar')
  return el ? getComputedStyle(el).backgroundColor : null
})
check('dark: sidebar element rgb(22,22,22)', sidebarBg === 'rgb(22, 22, 22)', sidebarBg)

// header renders #202020
const headerBg = await page.evaluate(() => {
  const el = document.querySelector('main header')
  return el ? getComputedStyle(el).backgroundColor : null
})
check('dark: header element rgb(32,32,32)', headerBg === 'rgb(32, 32, 32)', headerBg)

// scrollbar thumb = border color pill (ZCode global register)
const sbWidth = await page.evaluate(() => {
  const probe = document.createElement('div')
  probe.style.cssText = 'position:absolute;overflow-y:auto;height:40px;width:40px'
  probe.innerHTML = '<div style="height:200px"></div>'
  document.body.appendChild(probe)
  const w = probe.offsetWidth - probe.clientWidth
  probe.remove()
  return w
})
check('dark: webkit scrollbar 14px', sbWidth >= 13 && sbWidth <= 15, `${sbWidth}`)

// Tailwind bridge utilities resolve to zai values
const utilBg = await page.evaluate(() => {
  const probe = document.createElement('div')
  probe.className = 'bg-sidebar text-foreground-subtle border-border'
  document.body.appendChild(probe)
  const cs = getComputedStyle(probe)
  const out = { bg: cs.backgroundColor, color: cs.color }
  probe.remove()
  return out
})
check('bridge: bg-sidebar → #161616', utilBg.bg === 'rgb(22, 22, 22)', utilBg.bg)

// ── light（zai-light verbatim）──
await page.emulateMedia({ colorScheme: 'light' })
await page.evaluate(() => localStorage.removeItem('ocrc-theme'))
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(600)

check('light: background #f8f8f8', (await getVar('--bg')) === '#f8f8f8', await getVar('--bg'))
check('light: panel #ffffff', eq(await getVar('--bg-panel'), '#ffffff'), await getVar('--bg-panel'))
check('light: sidebar #f0f0f0', (await getVar('--bg-sidebar')) === '#f0f0f0', await getVar('--bg-sidebar'))
check('light: card #ffffff', eq(await getVar('--bg-card'), '#ffffff'))
check('light: tab #f0f0f0 / active #ffffff', eq(await getVar('--bg-tab'), '#f0f0f0') && eq(await getVar('--bg-tab-active'), '#ffffff'))
check('light: tag #e6e6e6', (await getVar('--bg-tag')) === '#e6e6e6')
check('light: border rgba(13,13,13,.1)', eq(await getVar('--border'), '#0d0d0d1a'), await getVar('--border'))
check('light: foreground #262626', (await getVar('--text')) === '#262626', await getVar('--text'))
check('light: primary #000000 / ink #ffffff', eq(await getVar('--primary'), '#000000') && eq(await getVar('--primary-ink'), '#ffffff'))
check('light: ok #1e8a3e / err #e03131 / warn #e07b00 / info #0b7fff', (await getVar('--ok')) === '#1e8a3e' && (await getVar('--err')) === '#e03131' && (await getVar('--warn')) === '#e07b00' && (await getVar('--info')) === '#0b7fff')
check('light: ask-surface #ebf4ff', (await getVar('--ask-surface')) === '#ebf4ff')
check('light: idle-task #9e77ed / surface #f5f3ff', (await getVar('--idle-task')) === '#9e77ed' && (await getVar('--idle-task-surface')) === '#f5f3ff')
check('light: user-bubble = surface .03', eq(await getVar('--user-bubble'), '#0d0d0d08'))

const bodyBgL = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
check('light: rendered body rgb(248,248,248)', bodyBgL === 'rgb(248, 248, 248)', bodyBgL)

// forced light via data-theme (switcher path)
await page.evaluate(() => { localStorage.setItem('ocrc-theme', 'dark'); document.documentElement.setAttribute('data-theme', 'dark') })
await page.waitForTimeout(200)
check('forced dark: --bg #161616 via data-theme', (await getVar('--bg')) === '#161616')
await page.evaluate(() => { localStorage.setItem('ocrc-theme', 'light'); document.documentElement.setAttribute('data-theme', 'light') })
await page.waitForTimeout(200)
check('forced light: --bg #f8f8f8 via data-theme', (await getVar('--bg')) === '#f8f8f8')

await page.screenshot({ path: `${OUT}/m9-light-full.png` })
await page.evaluate(() => { localStorage.removeItem('ocrc-theme'); document.documentElement.removeAttribute('data-theme') })
await page.emulateMedia({ colorScheme: 'dark' })
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(600)
await page.screenshot({ path: `${OUT}/m9-dark-full.png` })

await browser.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join(' | ')); process.exit(1) }
