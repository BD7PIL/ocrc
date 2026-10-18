#!/usr/bin/env node
/**
 * 逐组件视觉/动线评审的**流水线**：按固定清单驱动预览，每个组件一个状态一张截图。
 *
 *   node scripts/audit.mjs                 # 起预览 + 出全套截图到 preview/audit/
 *   node scripts/audit.mjs --only 15       # 只跑序号含 15 的项
 *   node scripts/audit.mjs --no-serve      # 复用已在跑的预览（OCRC_PREVIEW_PORT）
 *
 * 清单 = `preview/audit/README.md` 里那张表（**组件 × 状态**）。没有它，"看过每个
 * 组件"只是一句声明；有了它，每次改动都能拿到同一套图，逐项对 pass/fail。
 *
 * 实现：起本地预览（复用 scripts/preview.mjs），用 headless Chrome/Edge 的 CDP
 * 打开 `panel.html?scenario=…`，按步骤点击把目标卡片打开，再整页截图。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outDir = join(root, 'preview', 'audit')
const port = Number(process.env.OCRC_PREVIEW_PORT ?? 5205)
const debugPort = Number(process.env.OCRC_CDP_PORT ?? 9333)
const base = `http://127.0.0.1:${port}`

const argv = process.argv.slice(2)
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null
const serve = !argv.includes('--no-serve')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** 一步点击：按可见文字找按钮；`nth` 用于同名按钮（三张卡各有一个「更多 ▾」）。 */
const click = (text, nth = 0) => ({ click: text, nth })

/** 清单：每项 = 一个组件状态。`steps` 依次点击；`settle` 是等渲染/应答的时间。 */
const PLAN = [
  { id: '01-panel-empty', page: 'panel', scenario: 'empty', note: '空态（kit 自带 action 按钮）' },
  { id: '02-panel-loading', page: 'panel', scenario: 'slow', note: '首屏读列表（loading 文案，不是空态）' },
  { id: '03-panel-error', page: 'panel', scenario: 'error', note: '服务不可达：横幅 + **不**显示空态' },
  { id: '04-panel-list-one', page: 'panel', scenario: 'one', note: '1 台（在线）' },
  { id: '05-panel-list-mixed', page: 'panel', scenario: 'mixed', note: '3 台（在线 / 已停止 / 未安装）' },
  { id: '06-panel-list-dark', page: 'panel', scenario: 'mixed', theme: 'dark', note: '3 台 · 深色' },
  { id: '07-form-add', page: 'panel', scenario: 'empty', note: '表单：新增（密钥档）', steps: [click('添加服务器')] },
  { id: '08-form-edit-password', page: 'panel', scenario: 'pw', note: '表单：编辑 + 密码档 + 复用安装', steps: [click('更多 ▾'), click('编辑')] },
  { id: '09-card-details', page: 'panel', scenario: 'mixed', note: '详情展开', steps: [click('详情 ▾')] },
  { id: '10-card-more', page: 'panel', scenario: 'mixed', note: '更多展开（配置 / 维护 / 开关 / 移除）', steps: [click('更多 ▾')] },
  { id: '11-card-remove-confirm', page: 'panel', scenario: 'mixed', note: '移除二次确认（独立一块）', steps: [click('更多 ▾'), click('移除服务器')] },
  { id: '12-plan', page: 'panel', scenario: 'fresh', note: '检查结果卡（只读）', steps: [click('检查并安装')], settle: 1000 },
  { id: '13-plan-confirm', page: 'panel', scenario: 'fresh', note: '检查结果 + 安装确认', steps: [click('检查并安装'), click('安装到远程机器')], settle: 1000 },
  { id: '14-pairlink', page: 'panel', scenario: 'one', note: '配对链接卡（长链接折行）', steps: [click('创建配对链接')], settle: 1000 },
  { id: '15-config-diff', page: 'panel', scenario: 'one', note: '配置差异卡（分区 + 结论行）', steps: [click('更多 ▾'), click('配置差异与同步')], settle: 1000 },
  { id: '16-ui-password', page: 'panel', scenario: 'one', note: '界面密码卡', steps: [click('更多 ▾'), click('界面密码')], settle: 1000 },
  { id: '17-logs', page: 'panel', scenario: 'one', note: '日志卡（三段带标签分隔）', steps: [click('更多 ▾'), click('日志')], settle: 1400 },
  { id: '18-card-error-inline', page: 'panel', scenario: 'upfail', note: '卡片级错误：动作失败贴在**那张卡**里', steps: [click('启动')], settle: 1000 },
  { id: '19-panel-narrow', page: 'panel', scenario: 'mixed', width: 360, note: '窄宽 360px：卡片/表单不溢出' },
  { id: '20-rail-two', page: 'status', scenario: 'two', note: '状态区：2 台' },
  { id: '21-rail-one', page: 'status', scenario: 'one', note: '状态区：1 台' },
  { id: '22-rail-empty', page: 'status', scenario: 'empty', note: '状态区：未添加' },
  { id: '23-rail-down', page: 'status', scenario: 'error', note: '状态区：服务未运行' },
  { id: '24-rail-dark', page: 'status', scenario: 'two', theme: 'dark', note: '状态区：深色' },
]

const chrome = [
  process.env.AGENT_BROWSER_EXECUTABLE_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean).find((p) => existsSync(p))
if (!chrome) {
  console.error('找不到 Chrome/Edge：把 AGENT_BROWSER_EXECUTABLE_PATH 指向可执行文件')
  process.exit(2)
}

let server
if (serve) {
  server = spawn(process.execPath, [join(root, 'scripts', 'preview.mjs')], {
    env: { ...process.env, OCRC_PREVIEW_PORT: String(port) },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  await wait(6000)
}

mkdirSync(outDir, { recursive: true })
const profile = join(tmpdir(), 'ocrc-audit-chrome')
try { rmSync(profile, { recursive: true, force: true }) } catch { /* Windows：浏览器还没放开句柄，留着无妨（已 gitignore） */ }

const browser = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] })

/** 等 CDP 起来，然后开一个页面目标（新版 Chrome 的 /json/new 要 PUT）。 */
let target
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })
    if (r.ok) { target = await r.json(); break }
  } catch { /* 还没起来 */ }
  await wait(250)
}
if (!target?.webSocketDebuggerUrl) {
  console.error('CDP 页面目标没起来')
  browser.kill(); server?.kill()
  process.exit(3)
}

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r, j) => { socket.addEventListener('open', r); socket.addEventListener('error', j) })

let nextId = 1
const pending = new Map()
socket.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
})
const send = (method, params = {}) => new Promise((res) => {
  const id = nextId++
  pending.set(id, res)
  socket.send(JSON.stringify({ id, method, params }))
})

await send('Page.enable')
await send('Runtime.enable')

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text ?? 'evaluate 失败')
  return r.result?.result?.value
}

const results = []
for (const item of PLAN.filter((p) => !only || p.id.includes(only))) {
  const width = item.width ?? 660
  await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 2, mobile: false })
  await send('Page.navigate', { url: `${base}/${item.page}.html?scenario=${item.scenario}&theme=${item.theme ?? 'light'}` })
  await wait(item.settle ?? 1200)
  for (const step of item.steps ?? []) {
    const ok = await evaluate(`(() => {
      const want = ${JSON.stringify(step.click)};
      const all = [...document.querySelectorAll('button')].map((x) => x.textContent.trim());
      const b = [...document.querySelectorAll('button')].filter((x) => x.textContent.trim() === want || x.textContent.trim().startsWith(want))[${step.nth}];
      if (!b) return false;
      b.click();
      return true;
    })()`)
    if (!ok) results.push({ id: item.id, note: item.note, warn: `点不到「${step.click}」` })
    await wait(800)
  }
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  writeFileSync(join(outDir, `${item.id}.png`), Buffer.from(shot.result.data, 'base64'))
  results.push({ id: item.id, note: item.note })
  console.log(`${item.id}  ${item.note}`)
}

socket.close()
browser.kill()
server?.kill()
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* Windows：句柄没放开，留着无妨（已 gitignore） */ }

const warned = results.filter((r) => r.warn)
console.log(`\n${results.length} 张截图 → ${outDir}`)
for (const w of warned) console.log(`  · ${w.id}: ${w.warn}`)
