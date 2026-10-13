// B2 归因测量：用 CDP CPU Profile 把「大 markdown 消息 + live tick 的渲染成本」归到具体来源。
//
// 只测量、不改产品代码。这个脚本是 B2 的重开门禁，也回答 B7「buildRows 全量重建是否值得改增量」
// 的重开条件（桥接族占 tick 忙时 >30%？）。
//
// 用法（隔离栈；生产 :4096 不接测试流量）：
//   TOKEN=<web token> node scripts/perf-md-attribution.mjs
//   可选 --host（默认 http://127.0.0.1:4199） --engine（默认 http://127.0.0.1:4298，W3 tick 用）
//   可选 --dist（默认 ../web-next/dist，用于 sourcemap demap）
//
// 归因方法（为什么不按 chunk 名分组）：生产构建把 markdown 全家（streamdown/micromark/katex/
// shiki/mermaid）、vendor UI 与我方桥接（zcodeAgentService）**合并进同一个 9.4MB chunk**，
// 按 chunk 名分组会把桥接与 markdown 混为一谈（2026-10-13 复核发现并修正）。
// 因此本脚本读 **sourcemap**，把每个采样点 demap 到原始模块路径，按**原始路径族**聚合：
//   markdown 库 / ocrc 桥接 / vendor UI / vendor 其他 / React / node_modules 其他 / (native) / (program)/GC。
// 需要带 map 的构建：cd web-next && NODE_OPTIONS=--max-old-space-size=8192 npx vite build --sourcemap
// map 缺失时降级为 chunk 口径并**显式标注**（不静默）。
//
// 三个测量窗口：
//   W1a「首次渲染 · 无 mermaid」/ W1b「首次渲染 · 含 mermaid」= 回合进行中（含 chunk 编译/求值）；
//   W3 「live tick」= 回合结束后连发 shell tick（桥接 buildRows/diff + 行 update 的成本）。
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../web-next/package.json', import.meta.url))
const { chromium } = require('playwright')
const { SourceMapConsumer } = require('source-map-js')

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const TOKEN = process.env.TOKEN || ''
const HOST = argOf('host', 'http://127.0.0.1:4199')
const ENGINE = argOf('engine', 'http://127.0.0.1:4298')
const WEB_NEXT = dirname(fileURLToPath(import.meta.url)) + '/../web-next'
const DIST = argOf('dist', join(WEB_NEXT, 'dist', 'assets'))
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
const ms = (us) => Math.round(us / 100) / 10
const shortUrl = (url) => {
  if (!url) return '(native)'
  try { const u = new URL(url); return u.pathname.split('/').pop() || url } catch { return url }
}

// ── sourcemap demap ────────────────────────────────────────────────────
// 懒加载：只在真的有采样落到某个 chunk 时才解析它的 map（mermaid 的 map 有 34MB）。
const consumers = new Map()
function consumerFor(chunkName) {
  if (consumers.has(chunkName)) return consumers.get(chunkName)
  let c = null
  const p = join(DIST, `${chunkName}.map`)
  if (existsSync(p)) {
    try { c = new SourceMapConsumer(JSON.parse(readFileSync(p, 'utf-8'))) } catch (e) {
      console.error(`warning: map parse failed for ${chunkName}: ${e.message}`)
      c = null
    }
  }
  consumers.set(chunkName, c)
  return c
}
const MAP_URL_RE = /\.js$/
function demap(chunkName, line, column) {
  if (!MAP_URL_RE.test(chunkName)) return null
  if (!existsSync(join(DIST, `${chunkName}.map`))) return null
  const c = consumerFor(chunkName)
  if (!c) return null
  // CDP 的 lineNumber 是 0-based；source-map 期望 1-based。
  const o = c.originalPositionFor({ line: (line ?? 0) + 1, column: column ?? 0 })
  return o && o.source ? o : null
}

/** 按**原始模块路径**归属族（与 chunk 无关——同一 chunk 里混着 markdown/桥接/UI）。
 *  判定顺序：桥接 → vendor UI → markdown 家族（含代码高亮渲染）→ React → 其余 node_modules
 *  → 我方/vendor 源码。node_modules 判定先于 `/src/` 规则——否则
 *  `node_modules/dagre-d3-es/src/…`（mermaid 布局依赖）会被误归成「ocrc/vendor 其他」。 */
function familyOfSource(src) {
  if (!src) return '（未映射）'
  const s = src.replace(/\\/g, '/')
  if (s.includes('/src/zcode-services/')) return 'ocrc 桥接（src/zcode-services）'
  if (s.includes('/vendor/zcode/ui/src/')) return 'vendor UI（vendor/zcode/ui/src）'
  // 代码高亮渲染（shiki/@pierre diffs）与 markdown 解析同属「消息渲染」成本。
  if (/node_modules\/(@streamdown|streamdown|micromark|micromark-|mdast-|remark|rehype|hast-|unified|katex|shiki|@shikijs|mermaid|dagre|@pierre\/diffs|dompurify|highlight\.js|parse5)/.test(s)) return 'markdown/mermaid 库（含代码高亮）'
  if (/node_modules\/(react-dom|react|scheduler|@floating-ui)/.test(s)) return 'React 运行时'
  if (s.includes('node_modules/')) return 'node_modules 其他'
  if (/\/(vendor\/zcode\/|web-next\/src\/|src\/)/.test(s)) return 'ocrc/vendor 其他'
  return '其他'
}

/** chunk 口径的族（降级用；生产构建下这族是混杂的，输出里要标注）。 */
function familyOfChunk(name) {
  if (/^mermaid-[A-Za-z0-9_-]+\.js$/.test(name)) return 'chunk: mermaid-*.js（9.4MB 混合：markdown+vendor UI+桥接）'
  if (/^index-[A-Za-z0-9_-]+\.js$/.test(name)) return 'chunk: index-*.js（入口：React 运行时）'
  if (name.startsWith('(')) return name
  return 'chunk: 其他'
}

// ── 聚合 ────────────────────────────────────────────────────────────────
const IDLE_FNS = new Set(['(idle)'])
const ENGINE_FNS = new Set(['(program)', '(garbage collector)'])
/** profile.samples × timeDeltas → 每节点 self time → 原始文件族 + chunk 族 双向聚合。 */
function aggregate(profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const selfUs = new Map()
  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i]
    selfUs.set(id, (selfUs.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0))
  }
  const byFam = new Map()      // 原始路径族
  const bySrc = new Map()      // 原始 file:line（top 文件）
  const byChunk = new Map()    // chunk 口径（对照）
  const nativeFns = new Map()  // (native) 里的函数名
  let idleUs = 0
  let engineUs = 0
  let unmappedUs = 0
  let mappedUs = 0
  for (const [id, us] of selfUs) {
    const node = byId.get(id)
    const fn = node?.callFrame?.functionName || '(anonymous)'
    const chunk = shortUrl(node?.callFrame?.url ?? '')
    const cn = byChunk.get(chunk) ?? { us: 0, fns: new Map() }
    cn.us += us; cn.fns.set(fn, (cn.fns.get(fn) ?? 0) + us)
    byChunk.set(chunk, cn)
    if (IDLE_FNS.has(fn)) { idleUs += us; continue }
    if (ENGINE_FNS.has(fn)) { engineUs += us; continue }
    if (chunk === '(native)') {
      nativeFns.set(fn, (nativeFns.get(fn) ?? 0) + us)
      const e = byFam.get('(native)') ?? { us: 0, urls: [] }
      e.us += us; byFam.set('(native)', e)
      continue
    }
    // CDP 的 lineNumber/columnNumber 是 0-based。
    const o = demap(chunk, node?.callFrame?.lineNumber, node?.callFrame?.columnNumber)
    const fam = o ? familyOfSource(o.source) : familyOfChunk(chunk)
    if (o) mappedUs += us
    else {
      // 无 map 的 chunk 无法 demap：如实计入「（未映射）」，不静默混进别的族。
      if (!chunk.startsWith('(')) unmappedUs += us
    }
    const e = byFam.get(fam) ?? { us: 0, urls: [] }
    e.us += us; byFam.set(fam, e)
    if (o) {
      const key = `${o.source}:${o.line}`
      const cur = bySrc.get(key) ?? { us: 0, fam, fns: new Map() }
      cur.us += us
      cur.fns.set(fn, (cur.fns.get(fn) ?? 0) + us)
      bySrc.set(key, cur)
    }
  }
  const busyUs = [...byFam.values()].reduce((a, e) => a + e.us, 0)
  return { busyUs, idleUs, engineUs, mappedUs, unmappedUs, byFam, bySrc, byChunk, nativeFns }
}

function report(tag, agg) {
  console.log(`\n── ${tag} ──`)
  console.log(`  JS 忙时 ${ms(agg.busyUs)}ms ｜ V8 编译/求值/GC ${ms(agg.engineUs)}ms ｜ 空闲（等模型）${ms(agg.idleUs)}ms`)
  console.log(`  demap 覆盖：${ms(agg.mappedUs)}ms 已映射 / ${ms(agg.unmappedUs)}ms 未映射`)
  for (const [fam, e] of [...agg.byFam].sort((a, b) => b[1].us - a[1].us)) {
    const pct = agg.busyUs ? Math.round((e.us / agg.busyUs) * 1000) / 10 : 0
    console.log(`  ${String(ms(e.us)).padStart(9)}ms  ${String(pct).padStart(5)}%  ${fam}`)
  }
  const top = [...agg.bySrc].sort((a, b) => b[1].us - a[1].us).slice(0, 6)
  for (const [src, e] of top) {
    const fns = [...e.fns].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f, us]) => `${f} ${ms(us)}ms`).join(' · ')
    console.log(`    ${ms(e.us)}ms  ${src}  〔${fns}〕`)
  }
  const nf = [...agg.nativeFns].sort((a, b) => b[1] - a[1]).slice(0, 5)
  if (nf.length) console.log(`    (native): ${nf.map(([f, us]) => `${f} ${ms(us)}ms`).join(' · ')}`)
}

const famMs = (agg, re) => { for (const [f, e] of agg.byFam) if (re.test(f)) return ms(e.us); return 0 }
const famPct = (agg, re) => { const v = famMs(agg, re); return agg.busyUs ? Math.round((v / ms(agg.busyUs)) * 1000) / 10 : 0 }

// ── 主流程 ──────────────────────────────────────────────────────────────
// 会话必须**先建**再开页面：侧栏列表是页面加载时拉的，后建的会话不在列表里。
// 另外目录必须是侧栏可见的项目目录（会话按项目分组）。
const title = `MD-ATTR-${Date.now().toString(36)}`
const created = await (await fetch(`${HOST}/api/session`, {
  method: 'POST',
  headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ directory: (argOf('dir', process.cwd())), title }),
})).json()
if (!created?.id) {
  console.error('create session failed:', created)
  process.exit(1)
}
const sid = created.id
// 注意：POST /api/session 只回 {id, backendId}，**不回 title**——标题要用本地变量。
console.log('session:', sid, title)

const browser = await chromium.launch({
  executablePath: '/home/demo/chromium/headless_shell',
  env: { ...process.env, LD_LIBRARY_PATH: '/home/demo/chromium' },
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
})
// 产物总会写盘（哪怕中途抛错），会话总会清理——都不依赖正常走到脚本尾部。
const out = { sid, title, host: HOST, startedAt: new Date().toISOString() }
let exitCode = 0
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })
  await page.addInitScript(() => {
    window.__mdattr = { longtasks: [] }
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
  const lt = async () => (await page.evaluate(() => { const a = window.__mdattr.longtasks.slice(); window.__mdattr.longtasks.length = 0; return a })).sort((a, b) => a - b)
  const idle = async (max = 90) => {
    for (let i = 0; i < max; i++) {
      await page.waitForTimeout(800)
      const b = await (await fetch(`${HOST}/api/session/${sid}?limit=1`, { headers: auth })).json()
      if (!b.busy) return true
    }
    return false
  }
  const rowsNow = () => page.evaluate(() => {
    const tl = document.querySelector('[data-testid="v4-timeline"]')
    return tl ? Number(tl.getAttribute('data-row-count') ?? -1) : null
  })

  // 打开会话（点侧栏标题）
  await page.getByText(title, { exact: false }).first().click({ timeout: 20000 }).catch(() => {})
  await page.waitForTimeout(3000)
  const opened = await rowsNow()
  out.opened = opened
  console.log('opened rows:', opened)
  if (opened === null || opened === 0) console.error('警告：时间线元素未出现或初始行数为 0——下面的首次渲染数字可能不代表渲染成本')

  /** 发一条消息、等回合结束，期间采一次 CPU profile。
   *  窗口必须在回合**真正结束**（busy 回落）后才收尾：否则引擎还在出字、markdown/mermaid
   *  还在渲染，窗口边界会互相污染（2026-10-13 首轮 demap 跑就踩过：W1b 未结束 → W3 混进了
   *  W1b 的 mermaid 渲染成本）。done=false 时数字仍在，但必须显式标记不可作为独立结论。 */
  async function profileTurn(label, text, maxWait = 150) {
    await lt()
    await cdp.send('Profiler.start')
    await fetch(`${HOST}/api/message`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ sessionId: sid, clientId: `md-${Date.now()}`, text }),
    })
    const done = await idle(maxWait)
    if (!done) console.error(`警告：${label} 在等待窗口内未结束（busy 未回落）——该窗与后续窗可能互相污染`)
    // 结束后多等一拍：定稿渲染（含 mermaid 重绘/虚拟化收敛）常发生在 busy 回落之后。
    await page.waitForTimeout(3000)
    const { profile } = await cdp.send('Profiler.stop')
    const longtasks = await lt()
    const rows = await rowsNow()
    if (rows === 0) console.error(`警告：${label} 结束时行数为 0——该窗数字可能不代表渲染成本`)
    return { label, profile, longtasks, rows, done }
  }

  // 对照 A：无 mermaid → 对照 B：同规格 + mermaid
  const A = await profileTurn('W1a 首次渲染 · 无 mermaid', PROMPT_NO_MERMAID)
  const B = await profileTurn('W1b 首次渲染 · 含 mermaid', PROMPT_WITH_MERMAID)

  // ── 会话膨胀到实际规模再测 W3 ──
  // 空会话的 tick 只重建个位数行，桥接成本被系统性低估（首轮 W3 只有 19 行）。
  // 用引擎 shell 串行灌到 ~250 卡（与 A 项实测档位同量级），让 buildRows 面对真实窗口。
  // --prefill 0 可关（调试用）。
  const prefill = Number(argOf('prefill', '1'))
  if (prefill > 0) {
    const target = Number(argOf('prefill-cards', '250'))
    console.log(`\n灌会话到 ~${target} 卡（每回合 2 卡）…`)
    for (let i = 0; i < Math.ceil(target / 2); i++) {
      const r = await fetch(`${ENGINE}/session/${sid}/shell`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: 'build', command: `echo CARD-${i}-abcdefgh` }),
      }).catch(() => null)
      // 引擎忙时 POST 会被拒（409）；被拒就等一轮再重试，别把队列越堆越深。
      if (!r?.ok) {
        await idle(30)
        await fetch(`${ENGINE}/session/${sid}/shell`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent: 'build', command: `echo CARD-${i}-abcdefgh` }),
        }).catch(() => {})
      }
      await new Promise((resolve) => setTimeout(resolve, 700))
      if (i % 40 === 39) console.log(`  …${i + 1}/${Math.ceil(target / 2)}（行数 ${await rowsNow()}）`)
    }
    await idle(60)
    await page.waitForTimeout(2000)
    out.prefillRows = await rowsNow()
    console.log(`灌完：行数 ${out.prefillRows}`)
    // 服务端卡片数对照：引擎真收到了多少消息（页面行数应与之同序）
    const hist = await (await fetch(`${HOST}/api/session/${sid}?limit=100000`, { headers: auth })).json()
    out.prefillCards = hist.cards?.length
    console.log(`灌完：服务端卡片数 ${out.prefillCards}`)
  }

  // ── W3：live tick（桥接 buildRows/diff + 行 update）──
  // 连发 3 个 shell tick（引擎直接执行，不经 TG），每次等回合结束再发下一个；
  // profile 覆盖全部 3 个 tick，报「桥接族占忙时比例」——B7 增量重建的重开条件。
  // 两点取证细节（2026-10-13 复核踩过坑）：
  //  ① 窗口饱和后行数会**平移**（尾部小页合并 = 进 2 卡、出 2 卡），行数持平不代表没更新
  //     ——所以同时记录服务端卡片数，卡片增长即证明 tick 真的落到了会话里；
  //  ② 用户可见成本取决于视口是否跟随底部（虚拟化只渲染可见窗）——先滚到底再测。
  //
  // --load-older 1（默认）：先做「加载更早」到取尽，把窗口撑到**最大可达行数**再测 tick——
  // 那才是 buildRows 全量重建的最坏情况（重开条件说的就是 500/1000 行档）。
  const loadOlder = Number(argOf('load-older', '1'))
  if (loadOlder > 0) {
    await page.mouse.move(720, 450)
    let rounds = 0
    let st = null
    for (let i = 0; i < 40; i++) {
      await page.mouse.wheel(0, -2500)
      await page.waitForTimeout(400)
      const btn = page.locator('[data-testid="v4-timeline-load-older"]').first()
      if (await btn.count()) { await btn.click().catch(() => {}); await page.waitForTimeout(900) }
      st = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="v4-timeline"]')
        return el ? {
          top: Math.round(el.scrollTop), rows: Number(el.getAttribute('data-row-count')),
          btn: !!document.querySelector('[data-testid="v4-timeline-load-older"]'),
        } : null
      })
      rounds++
      if (st && st.top === 0 && !st.btn) break
    }
    out.loadOlder = { rounds, ...st }
    console.log(`加载更早：${rounds} 轮 → 行数 ${st?.rows}（滚动位 ${st?.top}，按钮 ${st?.btn ? '在' : '无'}）`)
  }

  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="v4-timeline"]')
    if (el) el.scrollTop = el.scrollHeight
  }).catch(() => {})
  await page.waitForTimeout(1200)
  const cardsAt = async () => (await (await fetch(`${HOST}/api/session/${sid}?limit=100000`, { headers: auth })).json()).cards?.length
  await lt()
  await cdp.send('Profiler.start')
  let ticksOk = 0
  const w3RowPath = [await rowsNow()]
  const w3CardPath = [await cardsAt()]
  const w3Status = []
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`${ENGINE}/session/${sid}/shell`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'build', command: `echo TICK-${i}-${'y'.repeat(120)}` }),
    }).catch(() => null)
    if (r?.ok) ticksOk++
    w3Status.push(r?.status ?? 'ERR')
    await idle(30)
    await page.waitForTimeout(1200) // > live 去抖 250ms，让本 tick 的 delta 落地
    w3RowPath.push(await rowsNow())
    w3CardPath.push(await cardsAt())
  }
  await page.waitForTimeout(2500)
  const { profile: p3 } = await cdp.send('Profiler.stop')
  const lt3 = await lt()
  const rowsAfterTicks = await rowsNow()
  out.w3RowPath = w3RowPath
  out.w3CardPath = w3CardPath
  out.w3Status = w3Status
  console.log(`W3 tick HTTP: ${w3Status.join(', ')}`)
  console.log(`W3 服务端卡片数: ${w3CardPath.join(' → ')}（增长 = tick 已落到会话）`)
  console.log(`W3 行数轨迹: ${w3RowPath.join(' → ')}（窗口饱和时会平移，持平不代表没更新）`)
  if (w3CardPath[w3CardPath.length - 1] === w3CardPath[0]) {
    console.error('警告：W3 期间服务端卡片数没有增长——tick 没落到会话，数字只是下界')
  }

  const aA = aggregate(A.profile)
  const aB = aggregate(B.profile)
  const a3 = aggregate(p3)
  report(`${A.label}（行数 ${A.rows}）`, aA)
  report(`${B.label}（行数 ${B.rows}）`, aB)
  report(`W3 live tick ×${ticksOk}（行数 ${rowsAfterTicks}）`, a3)
  console.log('\nlongtask（≥50ms，升序）:')
  for (const w of [A, B]) console.log(`  ${w.label}: ${w.longtasks.length ? w.longtasks.join(', ') + 'ms' : '（无）'}`)
  console.log(`  W3 tick: ${lt3.length ? lt3.join(', ') + 'ms' : '（无）'}`)
  console.log(`\n原始模块族占比：`)
  for (const [k, w] of [['W1a', aA], ['W1b', aB], ['W3', a3]]) {
    console.log(`  ${k}: markdown/mermaid ${famMs(w, /markdown\/mermaid/)}ms(${famPct(w, /markdown\/mermaid/)}%) ｜ 桥接 ${famMs(w, /ocrc 桥接/)}ms(${famPct(w, /ocrc 桥接/)}%) ｜ vendor UI ${famMs(w, /vendor UI/)}ms(${famPct(w, /vendor UI/)}%) ｜ native ${famMs(w, /^\(native\)$/)}ms`)
  }
  const dump = (w, agg, longtasks) => ({
    label: w.label, rows: w.rows, done: w.done, longtasks,
    busyMs: ms(agg.busyUs), engineMs: ms(agg.engineUs), idleMs: ms(agg.idleUs),
    mappedMs: ms(agg.mappedUs), unmappedMs: ms(agg.unmappedUs),
    families: [...agg.byFam].map(([f, e]) => ({ family: f, ms: ms(e.us) })),
    topFiles: [...agg.bySrc].sort((a, b) => b[1].us - a[1].us).slice(0, 12).map(([src, e]) => ({
      src, ms: ms(e.us), family: e.fam,
      fns: [...e.fns].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f, us]) => ({ fn: f, ms: ms(us) })),
    })),
    chunkView: [...agg.byChunk].sort((a, b) => b[1].us - a[1].us).slice(0, 6).map(([name, e]) => ({ chunk: name, ms: ms(e.us) })),
  })
  Object.assign(out, {
    // 口径警告：demap 需要带 map 的 dist；没有 map 时 family 会退化到 chunk 口径（混杂）。
    demapAvailable: existsSync(join(DIST, 'mermaid-MCJ5UELQ-CvtXjCzx.js.map')),
    w1a: dump(A, aA, A.longtasks),
    w1b: dump(B, aB, B.longtasks),
    w3: dump({ label: `W3 live tick ×${ticksOk}`, rows: rowsAfterTicks, done: true }, a3, lt3),
  })
} catch (e) {
  console.error('测量中途失败:', e?.message ?? e)
  out.error = String(e?.message ?? e)
  exitCode = 1
} finally {
  mkdirSync('/tmp/ocrc-perf', { recursive: true })
  writeFileSync('/tmp/ocrc-perf/md-attribution.json', JSON.stringify(out, null, 2))
  console.log('\njson → /tmp/ocrc-perf/md-attribution.json')
  // 自清（不再只打印命令）：失败路径也删，避免残留会话。
  try {
    const del = await fetch(`${HOST}/api/sessions/${sid}/delete`, { method: 'POST', headers: auth })
    console.log(`cleanup delete ${sid}: ${del.status}`)
  } catch (e) { console.error(`cleanup failed（手动删 ${sid}）: ${e?.message}`) }
  await browser.close()
}
process.exit(exitCode)
