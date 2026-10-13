// B2 归因测量：用 CDP CPU Profile 把「大 markdown 消息的渲染成本」归到具体来源。
//
// 只测量、不改产品代码。这个脚本就是 B2 的重开门禁（数据支持 → 另开一批做
// Markdown Worker / 虚拟化；不支持 → 台账写「已测：非热点」并撤掉重启条件）。
//
// 用法（隔离栈；生产 :4096 不接测试流量）：
//   TOKEN=<web token> node scripts/perf-md-attribution.mjs
//   可选 --host（默认 http://127.0.0.1:4199） --engine（默认 http://127.0.0.1:4298）
//
// 两个测量窗口：
//   W1「首次渲染」= 回合进行中：大 markdown 块到达 → lazy chunk（mermaid-*.js，含
//     streamdown/micromark/katex/shiki/mermaid）编译/求值 + 首次解析/渲染；
//   W2「重渲染」  = 回合结束后切走再切回该会话：chunk 已热，只剩解析/渲染。
//   W1 − W2 ≈ chunk 编译求值的一次性成本；W2 ≈ 每次渲染的解析成本。
//
// 输出：按 script URL 的 self time 汇总（µs→ms）、每个 URL 的 top 函数、
//      两窗的 longtask（对照 docs/perf-remediation-brief.md:63 的 137ms 残余）。
//      结果 JSON 落 /tmp/ocrc-perf/md-attribution.json。
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'

const require = createRequire(new URL('../web-next/package.json', import.meta.url))
const { chromium } = require('playwright')

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const TOKEN = process.env.TOKEN || ''
const HOST = argOf('host', 'http://127.0.0.1:4199')
const ENGINE = argOf('engine', 'http://127.0.0.1:4298')
if (!TOKEN) {
  console.error('TOKEN env required（web token；只本地读取，不入库）')
  process.exit(1)
}

const MD_COMMON = [
  '① 三个三级标题；② 无序列表与有序列表各一个；③ 一个 6 行的 markdown 表格；',
  '④ 两个带语法高亮的代码块（一个 ts、一个 bash，各 8 行以上）；⑤ 一段引用；',
  '⑥ 一个行内 LaTeX 公式；',
].join('')
/** 对照 A：无 mermaid 的大 markdown（分离 mermaid 的边际成本）。 */
const PROMPT_NO_MERMAID = `请输出一份约 800 字的技术说明，不要调用任何工具。必须包含：${MD_COMMON}`
/** 对照 B：同上 + 一个 mermaid 流程图。 */
const PROMPT_WITH_MERMAID = `请输出一份约 800 字的技术说明，不要调用任何工具。必须包含：${MD_COMMON}⑦ 一个 \`\`\`mermaid 流程图（5 个节点以上）。`

const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

// ── 汇总 ────────────────────────────────────────────────────────────────
const shortUrl = (url) => {
  if (!url) return '(native)'
  try { const u = new URL(url); return u.pathname.split('/').pop() || url } catch { return url }
}
const familyOf = (name) => {
  if (/^mermaid-[A-Za-z0-9_-]+\.js$/.test(name)) return 'markdown 家族 chunk（streamdown/micromark/katex/shiki/mermaid）'
  if (/^index-[A-Za-z0-9_-]+\.js$/.test(name)) return '入口 chunk（React 运行时 + 桥接 buildRows/diff）'
  if (name.startsWith('(')) return name
  return '其他 chunk'
}

/** profile.samples × timeDeltas → 每个节点 self time → 按 URL/函数聚合。 */
const IDLE_FNS = new Set(['(idle)'])
const ENGINE_FNS = new Set(['(program)', '(garbage collector)'])
function aggregate(profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const selfUs = new Map()
  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i]
    selfUs.set(id, (selfUs.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0))
  }
  const byUrl = new Map()
  let idleUs = 0
  let engineUs = 0
  for (const [id, us] of selfUs) {
    const node = byId.get(id)
    const fn = node?.callFrame?.functionName || '(anonymous)'
    // 空闲 = 等模型出字；(program)/GC = V8 编译/求值/回收——单列，不算「渲染成本」
    // 也不算 idle（chunk 编译一次性成本就落在 (program) 里）。
    if (IDLE_FNS.has(fn)) { idleUs += us; continue }
    if (ENGINE_FNS.has(fn)) { engineUs += us; continue }
    const name = shortUrl(node?.callFrame?.url ?? '')
    const e = byUrl.get(name) ?? { us: 0, fns: new Map() }
    e.us += us
    e.fns.set(fn, (e.fns.get(fn) ?? 0) + us)
    byUrl.set(name, e)
  }
  const busyUs = [...byUrl.values()].reduce((a, e) => a + e.us, 0)
  const fams = new Map()
  for (const [name, e] of byUrl) {
    const f = familyOf(name)
    const cur = fams.get(f) ?? { us: 0, urls: [] }
    cur.us += e.us
    cur.urls.push({ name, us: e.us })
    fams.set(f, cur)
  }
  return { busyUs, idleUs, engineUs, byUrl, fams }
}

const ms = (us) => Math.round(us / 100) / 10
function report(tag, agg) {
  const rows = [...agg.fams].sort((a, b) => b[1].us - a[1].us)
  console.log(`\n── ${tag} ──`)
  console.log(`  JS 忙时 ${ms(agg.busyUs)}ms ｜ V8 编译/求值/GC ${ms(agg.engineUs)}ms ｜ 空闲（等模型）${ms(agg.idleUs)}ms`)
  for (const [fam, e] of rows) {
    const pct = agg.busyUs ? Math.round((e.us / agg.busyUs) * 1000) / 10 : 0
    console.log(`  ${String(ms(e.us)).padStart(9)}ms  ${String(pct).padStart(5)}%  ${fam}`)
  }
  const topUrls = [...agg.byUrl].sort((a, b) => b[1].us - a[1].us).slice(0, 4)
  for (const [name, e] of topUrls) {
    const fns = [...e.fns].sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([fn, us]) => `${fn} ${ms(us)}ms`).join(' · ')
    console.log(`    ${name}: ${fns}`)
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────
// 会话必须**先建**再开页面：侧栏列表是页面加载时拉的，后建的会话不在列表里
// （首轮踩坑：点不到标题 → 消息发了但页面没渲染 → profile 全是 idle）。
const title = `MD-ATTR-${Date.now().toString(36)}`
const created = await (await fetch(`${HOST}/api/session`, {
  method: 'POST',
  headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ directory: process.cwd(), title }),
})).json()
if (!created?.id) {
  console.error('create session failed:', created)
  process.exit(1)
}
const sid = created.id
// 注意：POST /api/session 只回 {id, backendId}，**不回 title**——标题要用本地变量，
// 不能读 created.title（首轮踩坑：读成空串 → getByText('') 点到了随便一个元素）。
console.log('session:', sid, title)

const browser = await chromium.launch({
  executablePath: '/home/demo/chromium/headless_shell',
  env: { ...process.env, LD_LIBRARY_PATH: '/home/demo/chromium' },
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })
await page.addInitScript(() => {
  window.__mdattr = { longtasks: [], chunkFetches: [] }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.duration >= 50) window.__mdattr.longtasks.push(Math.round(e.duration))
    }).observe({ entryTypes: ['longtask'] })
  } catch { /* 无 longtask 支持 */ }
})
await page.goto(`${HOST}/#token=${encodeURIComponent(TOKEN)}`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(5000)

const cdp = await page.context().newCDPSession(page)
await cdp.send('Profiler.enable')
await cdp.send('Profiler.setSamplingInterval', { interval: 100 }) // 100µs
const lt = () => page.evaluate(() => { const a = window.__mdattr.longtasks.slice(); window.__mdattr.longtasks.length = 0; return a })
const idle = async (max = 90) => {
  for (let i = 0; i < max; i++) {
    await page.waitForTimeout(800)
    const b = await (await fetch(`${HOST}/api/session/${sid}?limit=1`, { headers: auth })).json()
    if (!b.busy) return true
  }
  return false
}

// 打开会话（点侧栏标题）
await page.getByText(title, { exact: false }).first().click({ timeout: 20000 }).catch(() => {})
await page.waitForTimeout(3000)
const opened = await page.evaluate(() => {
  const tl = document.querySelector('[data-testid="v4-timeline"]')
  return tl ? { rowCount: Number(tl.getAttribute('data-row-count') ?? -1) } : null
})
console.log('opened:', JSON.stringify(opened))
if (!opened) console.error('警告：时间线未出现——下面的数字不可信')

// ── W1：首次渲染（回合进行中）──
/** 发一条消息、等回合结束，期间采一次 CPU profile。 */
async function profileTurn(label, text) {
  await lt()
  await cdp.send('Profiler.start')
  await fetch(`${HOST}/api/message`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ sessionId: sid, clientId: `md-${Date.now()}`, text }),
  })
  const done = await idle()
  await page.waitForTimeout(1500)
  const { profile } = await cdp.send('Profiler.stop')
  const longtasks = await lt()
  const rows = await page.evaluate(() => {
    const tl = document.querySelector('[data-testid="v4-timeline"]')
    return tl ? Number(tl.getAttribute('data-row-count') ?? -1) : null
  })
  return { label, profile, longtasks, rows, done }
}

// 对照 A：无 mermaid（分离 mermaid 的边际成本）
const A = await profileTurn('W1a 首次渲染 · 无 mermaid', PROMPT_NO_MERMAID)
// 对照 B：同规格 + mermaid
const B = await profileTurn('W1b 首次渲染 · 含 mermaid', PROMPT_WITH_MERMAID)

// ── W2：重渲染（切走再切回；chunk 已热）──
// 用 /api/sessions 的**已知标题**挑一个别的会话（不用 DOM 启发式猜），切走再切回，
// 强制 markdown 行重新挂载——chunk 已在缓存里，这窗口只剩解析/渲染成本。
const others = await (await fetch(`${HOST}/api/sessions`, { headers: auth })).json()
const otherTitle = (Array.isArray(others) ? others : [])
  .map((s) => s?.title)
  .find((t) => t && t !== title) ?? null
if (otherTitle) {
  await page.getByText(otherTitle, { exact: false }).first().click().catch(() => {})
  await page.waitForTimeout(2500)
} else {
  console.error('警告：找不到第二个会话，W2 的「切走」退化为原地（数字偏保守）')
}
await lt()
await cdp.send('Profiler.start')
await page.getByText(title, { exact: false }).first().click().catch(() => {})
await page.waitForTimeout(4500)
const { profile: p2 } = await cdp.send('Profiler.stop')
const lt2 = await lt()
const afterW2 = await page.evaluate(() => {
  const tl = document.querySelector('[data-testid="v4-timeline"]')
  return tl ? Number(tl.getAttribute('data-row-count') ?? -1) : null
})

const aA = aggregate(A.profile)
const aB = aggregate(B.profile)
const a2 = aggregate(p2)
report(`${A.label}（行数 ${A.rows}）`, aA)
report(`${B.label}（行数 ${B.rows}）`, aB)
report('W2 重渲染（chunk 已热，只剩解析；行数 ' + afterW2 + '）', a2)
console.log('\nlongtask（≥50ms）:')
for (const w of [A, B]) console.log(`  ${w.label}: ${w.longtasks.length ? w.longtasks.join(', ') + 'ms' : '（无）'}`)
console.log(`  W2 重渲染: ${lt2.length ? lt2.join(', ') + 'ms' : '（无）'}`)
const fam = (agg, re) => { for (const [f, e] of agg.fams) if (re.test(f)) return ms(e.us); return 0 }
const mdA = fam(aA, /markdown 家族/)
const mdB = fam(aB, /markdown 家族/)
console.log(`\nmarkdown 家族 chunk：无 mermaid ${mdA}ms → 含 mermaid ${mdB}ms（mermaid 边际 ${Math.round((mdB - mdA) * 10) / 10}ms）`)
console.log(`入口 chunk（React+桥接）：W1a ${fam(aA, /入口 chunk/)}ms ｜ W1b ${fam(aB, /入口 chunk/)}ms ｜ W2 ${fam(a2, /入口 chunk/)}ms`)

mkdirSync('/tmp/ocrc-perf', { recursive: true })
const dump = (w, agg) => ({
  label: w.label, rows: w.rows, done: w.done, longtasks: w.longtasks,
  busyMs: ms(agg.busyUs), engineMs: ms(agg.engineUs), idleMs: ms(agg.idleUs),
  families: [...agg.fams].map(([f, e]) => ({ family: f, ms: ms(e.us), urls: e.urls.map((u) => ({ ...u, us: ms(u.us) })) })),
})
const out = {
  sid, opened, afterW2,
  w1a: dump(A, aA),
  w1b: dump(B, aB),
  w2: { label: 'W2 重渲染（chunk 已热）', rows: afterW2, longtasks: lt2, busyMs: ms(a2.busyUs), engineMs: ms(a2.engineUs), idleMs: ms(a2.idleUs), families: [...a2.fams].map(([f, e]) => ({ family: f, ms: ms(e.us), urls: e.urls.map((u) => ({ ...u, us: ms(u.us) })) })) },
}
writeFileSync('/tmp/ocrc-perf/md-attribution.json', JSON.stringify(out, null, 2))
console.log('\njson → /tmp/ocrc-perf/md-attribution.json')
console.log(`cleanup: POST ${HOST}/api/sessions/${sid}/delete`)
await browser.close()
