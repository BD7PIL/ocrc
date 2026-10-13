// B7 基线/复测 harness v3：用时间线根节点的 data-* 属性做行账（工具行文本折叠，文本探针不可用）。
// 账目：open 行数 / loadOlder 后行数（能否到全会话）/ 每 tick 的 history 取数·字节·longtask。
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const require = createRequire('/home/demo/develop/opencode-plugin/ocrc/web-next/package.json')
const { chromium } = require('playwright')

const TOKEN = process.argv[2]
const TAG = process.argv[3] || 'before'
const sidMap = Object.fromEntries(
  readFileSync('/tmp/perf-sids.txt', 'utf-8').trim().split('\n').filter(Boolean).map((l) => {
    const [title, sid] = l.split(' ')
    return [title, sid]
  }),
)
const HOST = 'http://127.0.0.1:4199'
const ENGINE = 'http://127.0.0.1:4298'
const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

/** 只计算 buildRows 的持久行（goal marker / workflow display 不在本合成档输入中）。 */
function expectedRows(cards) {
  return cards.reduce((total, card) => {
    if (card?.kind === 'user') return total + 2 // turnHeader + userInput
    if (card?.kind !== 'assistant' || !Array.isArray(card.blocks)) return total
    const blocks = card.blocks.filter((b) => b?.type === 'text' || b?.type === 'reasoning' || b?.type === 'tool')
    let rows = blocks.length
    if (card.thinkingText && !blocks.some((b) => b.type === 'reasoning')) rows += 1
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
    if (card.meta?.agent === 'plan' && text.trim()) rows += 1 // ExitPlanMode projection
    return total + rows
  }, 0)
}

async function sessionCards(sid) {
  const res = await fetch(`${HOST}/api/session/${sid}?limit=500`, { headers: auth })
  if (!res.ok) throw new Error(`history ${sid}: HTTP ${res.status}`)
  const body = await res.json()
  return Array.isArray(body.cards) ? body.cards : []
}

function cardSummary(cards) {
  const byKind = cards.reduce((out, c) => { out[c?.kind ?? 'unknown'] = (out[c?.kind ?? 'unknown'] ?? 0) + 1; return out }, {})
  return { count: cards.length, expectedRows: expectedRows(cards), byKind }
}

mkdirSync('/tmp/ocrc-perf', { recursive: true })

const browser = await chromium.launch({
  executablePath: '/home/demo/chromium/headless_shell',
  env: { ...process.env, LD_LIBRARY_PATH: '/home/demo/chromium' },
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

await page.addInitScript(() => {
  window.__perf = { fetches: [], longtasks: [] }
  const orig = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || ''
    const t0 = performance.now()
    const res = await orig(input, init)
    try {
      const buf = await res.clone().arrayBuffer()
      window.__perf.fetches.push({ url, ms: Math.round(performance.now() - t0), bytes: buf.byteLength })
    } catch {}
    return res
  }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.duration >= 50) window.__perf.longtasks.push(Math.round(e.duration))
    }).observe({ entryTypes: ['longtask'] })
  } catch {}
})

await page.goto(`http://127.0.0.1:4199/#token=${encodeURIComponent(TOKEN)}`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(5000)

const histOf = (sid) => (f) => f.url.includes(`/api/session/${sid}?`)
const reset = () => page.evaluate(() => { window.__perf.fetches.length = 0; window.__perf.longtasks.length = 0 })
const read = () => page.evaluate(() => ({ fetches: window.__perf.fetches.slice(), longtasks: window.__perf.longtasks.slice() }))
const rowStats = () => page.evaluate(() => {
  const tl = document.querySelector('[data-testid="v4-timeline"]')
  if (!tl) return null
  const n = (k) => Number(tl.getAttribute(k) ?? -1)
  return { rowCount: n('data-row-count'), totalRowCount: n('data-total-row-count'), windowRowCount: n('data-window-row-count'), renderUnits: n('data-render-unit-count'), loadingOlder: tl.getAttribute('data-loading-older'), loadOlderBtn: !!document.querySelector('[data-testid="v4-timeline-load-older"]') }
})
const scrollTop = () => page.evaluate(() => { const el = document.querySelector('[data-testid="v4-timeline"]'); if (el) el.scrollTop = 0 })
const waitIdle = async (sid, max = 45) => {
  for (let i = 0; i < max; i++) {
    await page.waitForTimeout(700)
    const b = await (await fetch(`${HOST}/api/session/${sid}?limit=1`, { headers: auth })).json()
    if (!b.busy) return true
  }
  return false
}

const out = {}
for (const [title, sid] of Object.entries(sidMap)) {
  await reset()
  const t0 = Date.now()
  await page.getByText(title, { exact: false }).first().click({ timeout: 20000 }).catch(() => {})
  const appeared = await page
    .waitForFunction(() => {
      const tl = document.querySelector('[data-testid="v4-timeline"]')
      return !!tl && Number(tl.getAttribute('data-row-count') ?? 0) > 0
    }, null, { timeout: 25000 })
    .then(() => true).catch(() => false)
  const firstRowMs = appeared ? Date.now() - t0 : null
  await page.waitForTimeout(3000)
  const open = await read()
  const openRows = await rowStats()
  const openCards = await sessionCards(sid)

  // live：每 tick 单独计数（6 tick）；每次等引擎空闲，避免把 busy 队列误记成页面性能。
  const ticks = []
  for (let i = 0; i < 6; i++) {
    await reset()
    const beforeCards = await sessionCards(sid)
    const t0 = Date.now()
    const engineRes = await fetch(`${ENGINE}/session/${sid}/shell`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'build', command: `echo TICK-${i}-${'y'.repeat(120)}` }),
    })
    const idle = await waitIdle(sid)
    await page.waitForTimeout(800)
    const afterCards = await sessionCards(sid)
    const r = await read()
    const hist = r.fetches.filter(histOf(sid))
    ticks.push({
      tick: i, engineStatus: engineRes.status, idle, elapsedMs: Date.now() - t0,
      before: cardSummary(beforeCards), after: cardSummary(afterCards),
      rowStats: await rowStats(),
      histFetches: hist.length, histMs: hist.map((f) => f.ms), histBytes: hist.reduce((a, f) => a + f.bytes, 0),
      allFetches: r.fetches.length, longtasks: r.longtasks,
    })
  }

  // loadOlder：真实滚轮上滚（vendor 的 handleScroll 只认用户滚动意图），
  // 到顶后按钮出现则点，最多 32 轮；明确记录「按钮是否出现/是否点击/阶段是否真的取历史」。
  await reset()
  await page.mouse.move(720, 450)
  let olderRounds = 0
  let olderButtonSeen = false
  let olderButtonClicks = 0
  let rowsAfterOlder = openRows
  const olderBeforeCards = await sessionCards(sid)
  for (let i = 0; i < 32; i++) {
    await page.mouse.wheel(0, -2500)
    await page.waitForTimeout(500)
    const st = await rowStats()
    if (st?.loadOlderBtn) {
      olderButtonSeen = true
      await page.locator('[data-testid="v4-timeline-load-older"]').first().click().catch(() => {})
      olderButtonClicks++
    }
    await page.waitForTimeout(1200)
    const after = await rowStats()
    olderRounds++
    if (after) rowsAfterOlder = after
    if (after && after.rowCount >= after.totalRowCount && !after.loadOlderBtn && i > 3) break
    if (after && after.rowCount === st?.rowCount && !st?.loadingOlder && !st?.loadOlderBtn && i > 3) break
  }
  const older = await read()
  const olderAfterCards = await sessionCards(sid)
  const dynamicExpected = Math.max(cardSummary(openCards).expectedRows, cardSummary(olderAfterCards).expectedRows)
  const loadOlderHist = older.fetches.filter(histOf(sid))
  const loadOlderAttempted = olderButtonClicks > 0
  const reachedAll = rowsAfterOlder ? rowsAfterOlder.rowCount >= dynamicExpected * 0.98 : false

  out[title] = {
    sid, firstRowMs, newestAppeared: appeared,
    openCards: cardSummary(openCards),
    openHistFetches: open.fetches.filter(histOf(sid)).length,
    openHistBytes: open.fetches.filter(histOf(sid)).reduce((a, f) => a + f.bytes, 0),
    openLongtasks: open.longtasks, openRows,
    ticks,
    loadOlder: {
      rounds: olderRounds,
      buttonSeen: olderButtonSeen,
      buttonClicks: olderButtonClicks,
      attempted: loadOlderAttempted,
      beforeCards: cardSummary(olderBeforeCards),
      afterCards: cardSummary(olderAfterCards),
      histFetches: loadOlderHist.length,
      histBytes: loadOlderHist.reduce((a, f) => a + f.bytes, 0),
      loadedRowCount: rowsAfterOlder?.rowCount ?? null,
      expectedTotal: dynamicExpected,
      reachedAll,
      interpretation: loadOlderAttempted ? 'button clicked; stage history fetches are attributable to loadOlder' : 'button never clicked; open/tick phase already supplied the current window',
    },
  }
  const o = out[title]
  console.error(`[${TAG}] ${title}: firstRow=${firstRowMs}ms openCards=${o.openCards.count}/${o.openCards.expectedRows} openRows=${openRows?.totalRowCount} openHist=${o.openHistFetches}/${o.openHistBytes}B tickHist=${ticks.map((t) => t.histFetches).join(',')} tickBytes=${ticks.map((t) => t.histBytes).join(',')} tickCards=${ticks.map((t) => t.after.count).join(',')} longtask=${ticks.flatMap((t) => t.longtasks).sort((a, b) => a - b).join(',') || '-'} | loadOlder: button=${o.loadOlder.buttonSeen}/${o.loadOlder.buttonClicks} rows=${o.loadOlder.loadedRowCount}/${o.loadOlder.expectedTotal} reachedAll=${o.loadOlder.reachedAll} hist=${o.loadOlder.histFetches}`)
}

writeFileSync(`/tmp/ocrc-perf/${TAG}-v3.json`, JSON.stringify(out, null, 2))
await browser.close()
