#!/usr/bin/env node
// 移动端视口探针（审计用，可复跑）
//
// 目的：用真实移动视口（CDP Emulation + touch）渲染 ocrc 的 /z/，对每个「状态」
// 截图并做结构化测量（横向溢出 / 触达尺寸 / hover-only / 16px 字号 / 越界控件 /
// console 报错），产出机器可读报告，供 docs/frontend-mobile-audit.md 引用。
//
// 纪律：
//  - 自起 headless shell（默认 9333），只 kill 自己 spawn 的 PID；绝不碰既有 9222。
//  - token 运行时从隔离栈文件读取，不打印、不落盘到仓库。
//  - 产物一律写 /tmp/mobile-audit/（仓库外）。
//
// 用法：
//   node scripts/mobile-audit.mjs                  # 默认 390x844 + 360x740
//   node scripts/mobile-audit.mjs --device 390     # 只跑一个设备档
//   MOBILE_AUDIT_BASE=http://127.0.0.1:4199 node scripts/mobile-audit.mjs

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'

const BASE = process.env.MOBILE_AUDIT_BASE ?? 'http://127.0.0.1:4199'
const TOKEN_FILE = process.env.MOBILE_AUDIT_TOKEN_FILE ?? '/tmp/ocrc-z-home/.ocrc/token'
const OUT = process.env.MOBILE_AUDIT_OUT ?? '/tmp/mobile-audit'
const CDP_PORT = Number(process.env.MOBILE_AUDIT_CDP_PORT ?? 9333)
const SHELL = process.env.MOBILE_AUDIT_SHELL ?? '/home/demo/chromium/headless_shell'
const SHELL_LIB = process.env.MOBILE_AUDIT_SHELL_LIB ?? '/home/demo/chromium'
const SETTLE_MS = Number(process.env.MOBILE_AUDIT_SETTLE_MS ?? 7000)

const DEVICES = {
  390: { width: 390, height: 844, deviceScaleFactor: 3, label: 'iPhone 14/15 档 390x844' },
  360: { width: 360, height: 740, deviceScaleFactor: 3, label: 'Android 小屏档 360x740' },
}
const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const argv = process.argv.slice(2)
const deviceArg = (() => {
  const i = argv.indexOf('--device')
  return i >= 0 ? argv[i + 1] : null
})()

// ---------------------------------------------------------------- measurement
// 在页面上下文里跑，返回结构化测量。注意：全部用 getBoundingClientRect + computed
// style，不用 vendor 内部 class 约定（除了 hover-only 的类名启发式，那是唯一手段）。
function collectMeasurements() {
  const W = window.innerWidth
  const H = window.innerHeight
  const all = [...document.querySelectorAll('*')]
  // 祖先感知可见性 —— 但分两条规则：
  //  - display/visibility/opacity 逐级复合，任一祖先为 0 子树即不可见；
  //  - pointer-events 只看元素自身：它可继承，但 `pointer-events:auto` 的后代
  //    会重新命中（Radix 开 modal 时给 body 设 none、给内容设 auto；composer
  //    区也是 pointer-events-none 外壳 + auto 内层）。查祖先会把这些可点元素
  //    全部误判成不可交互（实测：远控对话框 80 个按钮全灭）。
  const vis = (e) => {
    const r = e.getBoundingClientRect()
    if (!(r.width > 1 && r.height > 1)) return false
    if (getComputedStyle(e).pointerEvents === 'none') return false
    for (let n = e; n && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n)
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < 0.05) return false
    }
    return true
  }
  const rect = (e) => {
    const r = e.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  }
  const label = (e) =>
    (e.getAttribute?.('aria-label') || e.innerText || e.getAttribute?.('title') || e.getAttribute?.('data-testid') || e.tagName || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 48)
  const cls = (e) => (typeof e.className === 'string' ? e.className : '').slice(0, 120)
  // 自身可见（不查祖先）—— 用于 hover-only 判定，因为 hover-only 元素本来就是
  // 靠自身 opacity-0 藏起来的。
  const selfHidden = (e) => {
    const s = getComputedStyle(e)
    return Number(s.opacity) < 0.05 || s.visibility === 'hidden' || s.display === 'none'
  }

  const INTERACTIVE =
    'button, a[href], [role="button"], input, select, textarea, [contenteditable="true"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [role="checkbox"], [data-slot="button"]'
  const interactive = [...document.querySelectorAll(INTERACTIVE)].filter(vis)
  const boxes = interactive.map((e) => ({ label: label(e), tag: e.tagName.toLowerCase(), ...rect(e) }))

  const tapTargets = boxes.filter((b) => b.w < 44 || b.h < 44)
  const offscreen = boxes.filter((b) => b.x + b.w > W + 1 || b.x < -1)

  // hover-only：带 hover 揭示类名、当前自身不可见的元素（触屏永远揭示不了）。
  // 必须匹配**具名**组变体 `group-hover/assistant-turn:opacity-100` —— 只认
  // `group-hover:` 会漏掉 vendor 时间线动作栏的全部实况（实测假阴性 0）。
  const HOVER_RE = /\bgroup-hover(\/[A-Za-z0-9_-]+)?:(opacity-100|visible|flex|block|inline|inline-flex|grid)\b|\bhover:(opacity-100|visible|flex|block|inline|inline-flex|grid)\b/
  const hoverOnly = all
    .filter((e) => HOVER_RE.test(cls(e)) && selfHidden(e))
    .map((e) => ({ label: label(e), cls: cls(e), ...rect(e) }))
    .slice(0, 80)

  const smallFontEditable = [...document.querySelectorAll('input, textarea, select, [contenteditable="true"]')]
    .filter(vis)
    .map((e) => ({ label: label(e), fontSize: getComputedStyle(e).fontSize, ...rect(e) }))
    .filter((r) => parseFloat(r.fontSize) < 16)

  const hScroll = all
    .filter((e) => e.scrollWidth > e.clientWidth + 2 && vis(e) && ['auto', 'scroll'].includes(getComputedStyle(e).overflowX))
    .map((e) => ({ cls: cls(e), scrollW: e.scrollWidth, clientW: e.clientWidth }))
    .slice(0, 20)

  // 已经发生横向位移的可滚容器 —— 用于定「聚焦导致整壳平移」的滚动源
  const scrolledX = all
    .filter((e) => e.scrollLeft !== 0)
    .map((e) => ({ cls: cls(e), scrollLeft: Math.round(e.scrollLeft), scrollW: e.scrollWidth, clientW: e.clientWidth }))
    .slice(0, 20)

  const shell = document.querySelector('[data-workspace-shell="true"]')
  const sidebarPanel = document.querySelector('[data-workspace-sidebar-panel="true"]')
  const chatSurface = document.querySelector('[data-mobile-chat-surface]')
  const sidePaneOverlay = document.querySelector('[data-mobile-side-pane-overlay="true"]')
  // 会话主区：含 composer 的那个 flex 列（标准壳 = 侧栏右侧剩下的全部宽度）
  const composer = document.querySelector('[contenteditable="true"]')
  const chatPane = composer?.closest('[data-workspace-shell="true"] > *:not([data-workspace-sidebar-panel])') ?? null

  const text = (document.body.innerText || '').replace(/\n{2,}/g, '\n').slice(0, 1500)

  return {
    viewport: { W, H, dpr: window.devicePixelRatio },
    docOverflowX: document.documentElement.scrollWidth - W,
    counts: {
      interactive: interactive.length,
      buttons: document.querySelectorAll('button').length,
      dialogs: document.querySelectorAll('[role="dialog"]').length,
      contenteditable: document.querySelectorAll('[contenteditable="true"]').length,
      fixed: document.querySelectorAll('.fixed').length,
    },
    layout: {
      shellSidebarWidthVar: shell ? getComputedStyle(shell).getPropertyValue('--workspace-sidebar-panel-width').trim() : null,
      sidebarPanel: sidebarPanel ? rect(sidebarPanel) : null,
      chatPane: chatPane ? rect(chatPane) : null,
      composer: composer ? rect(composer) : null,
      composerRowOverflow: (() => {
        const row = composer?.closest('[class*="flex"]')
        if (!row) return null
        return { scrollW: row.scrollWidth, clientW: row.clientWidth, overflow: row.scrollWidth - row.clientWidth }
      })(),
      mobileChatSurface: chatSurface ? { mode: chatSurface.getAttribute('data-mobile-chat-surface') } : null,
      sidePaneOverlayPresent: Boolean(sidePaneOverlay),
      rootPadding: getComputedStyle(document.querySelector('.zcode-shell-root') ?? document.body).padding,
      mediaCoarse: window.matchMedia('(pointer: coarse)').matches,
      mediaHoverNone: window.matchMedia('(hover: none)').matches,
      mediaMaxMd: window.matchMedia('(max-width: 767px)').matches,
    },
    tapTargetCount: tapTargets.length,
    tapTargets: tapTargets.slice(0, 40),
    offscreenCount: offscreen.length,
    offscreen: offscreen.slice(0, 40),
    hoverOnlyCount: hoverOnly.length,
    hoverOnly,
    smallFontEditable,
    hScroll,
    scrolledX,
    bodyText: text,
  }
}

// ---------------------------------------------------------------- driver utils
async function clickByText(page, text, { exact = true, nth = 0 } = {}) {
  const loc = page.getByText(text, { exact }).nth(nth)
  const count = await loc.count()
  if (!count) return { ok: false, reason: `no element with text "${text}"` }
  try {
    await loc.first().click({ timeout: 4000 })
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: String(e.message).slice(0, 120) }
  }
}

async function clickByLabel(page, label) {
  const loc = page.locator(`[aria-label="${label}"]`)
  if (!(await loc.count())) return { ok: false, reason: `no aria-label "${label}"` }
  try {
    await loc.first().click({ timeout: 4000 })
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: String(e.message).slice(0, 120) }
  }
}

// ---------------------------------------------------------------- state flows
// 线性流程：每个设备只 goto /z/ 一次（ocrc 引导会预热草稿会话，反复导航会污染
// 隔离栈），随后在应用内用点击/按键切换形态。每步 = 截图 + 测量。
function buildFlow(sessions) {
  // 侧栏默认只显示最近 5 条，其余折叠在「显示更多」后 —— 逐个试到命中为止。
  // 排除 "New session" 草稿：那是空的（探针/引导自己预热出来的），量不出时间线。
  const real = sessions.filter((s) => s.title && !/^New session/.test(s.title))
  const candidates = real.length ? real.map((s) => s.title) : sessions.map((s) => s.title).filter(Boolean)

  const openAnySession = async (page) => {
    const tryTitles = async () => {
      for (const title of candidates) {
        const loc = page.getByText(title, { exact: true })
        if (!(await loc.count())) continue
        const first = loc.first()
        if (!(await first.isVisible().catch(() => false))) continue
        await first.click({ timeout: 5000 }).catch(() => {})
        await page.waitForTimeout(2500)
        return { ok: true, title }
      }
      return null
    }
    let hit = await tryTitles()
    if (hit) return hit
    // 目标行可能折叠在「显示更多」之后 —— 展开一次再试。
    const more = page.getByText('显示更多', { exact: true })
    if (await more.count()) {
      await more.first().click({ timeout: 4000 }).catch(() => {})
      await page.waitForTimeout(1200)
      hit = await tryTitles()
      if (hit) return hit
    }
    return { ok: false, reason: `no visible non-draft session row among ${candidates.length} candidates` }
  }

  const closeOverlays = async (page) => {
    for (let i = 0; i < 4; i++) {
      if (!(await page.locator('[role="dialog"]').count())) break
      await page.keyboard.press('Escape').catch(() => {})
      await page.waitForTimeout(600)
    }
  }

  // 设置页是 h-screen 的 `grid-cols-[68px_minmax(0,1fr)]` 全屏视图（非 role=dialog）。
  const settingsOpen = (page) =>
    page.evaluate(() => {
      for (const e of document.querySelectorAll('div')) {
        const g = getComputedStyle(e).gridTemplateColumns
        if (g && g.startsWith('68px') && e.getBoundingClientRect().height > 600) return true
      }
      return false
    })

  return [
    {
      id: 'home',
      desc: '任务首页 / 侧栏（/z/ 引导完成，未进入任何会话）',
      run: async () => ({ ok: true }),
    },
    {
      id: 'session',
      desc: '任务会话页（点侧栏任务行进入：时间线 + composer + 会话头部）',
      run: openAnySession,
    },
    {
      id: 'session-context-menu',
      desc: '任务行右键（触屏长按的桌面等价物 —— 手机无入口）',
      run: async (page, ctx) => {
        const title = ctx?.lastSessionTitle
        if (!title) return { ok: false, reason: 'no session opened' }
        const loc = page.getByText(title, { exact: true })
        if (!(await loc.count())) return { ok: false, reason: 'row gone' }
        await loc.first().click({ button: 'right', timeout: 5000 }).catch(() => {})
        await page.waitForTimeout(1500)
        return { ok: true }
      },
    },
    {
      id: 'session-longpress',
      desc: '任务行长按 ~700ms（触屏等价右键 —— 验证是否有长按兜底）',
      run: async (page, ctx) => {
        const title = ctx?.lastSessionTitle
        if (!title) return { ok: false, reason: 'no session opened' }
        const loc = page.getByText(title, { exact: true })
        if (!(await loc.count())) return { ok: false, reason: 'row gone' }
        const box = await loc.first().boundingBox()
        if (!box) return { ok: false, reason: 'no bounding box' }
        const x = box.x + box.width / 2
        const y = box.y + box.height / 2
        const cdp = await page.context().newCDPSession(page)
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x, y, id: 1 }],
        })
        await page.waitForTimeout(700)
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        await page.waitForTimeout(1500)
        const popped = await page.evaluate(() => ({
          menus: document.querySelectorAll('[role="menu"]:not([hidden])').length,
          dialogs: document.querySelectorAll('[role="dialog"]').length,
          menuitems: document.querySelectorAll('[role="menuitem"]').length,
        }))
        return { ok: true, longPressAt: { x: Math.round(x), y: Math.round(y) }, popped }
      },
    },
    {
      id: 'session-composer-focus',
      desc: '会话页聚焦 composer（软键盘弹出后的可视区与输入行布局）',
      run: async (page) => {
        const ce = page.locator('[contenteditable="true"]').first()
        if (!(await ce.count())) return { ok: false, reason: 'no composer' }
        await ce.click({ timeout: 5000 }).catch(() => {})
        await page.waitForTimeout(800)
        return { ok: true }
      },
    },
    {
      id: 'command-palette',
      desc: '命令面板（侧栏「搜索」入口：输入框 + 结果分组 + 关闭路径）',
      run: async (page) => {
        const btn = page.getByRole('button', { name: /搜索/ }).first()
        if (!(await btn.count())) return { ok: false, reason: 'no 搜索 button' }
        try { await btn.click({ timeout: 5000 }) } catch (e) { return { ok: false, reason: String(e.message).slice(0, 120) } }
        await page.waitForTimeout(1500)
        const state = await page.evaluate(() => {
          const dlg = document.querySelector('[role="dialog"]')
          const input = dlg?.querySelector('input')
          const rows = dlg ? dlg.querySelectorAll('[role="option"], [cmdk-item]').length : 0
          return {
            dialogOpen: Boolean(dlg),
            inputVisible: input ? { w: Math.round(input.getBoundingClientRect().width), h: Math.round(input.getBoundingClientRect().height) } : null,
            optionRows: rows,
            groups: dlg ? dlg.querySelectorAll('[cmdk-group]').length : 0,
          }
        })
        return { ok: true, ...state }
      },
    },
    {
      id: 'session-side-pane',
      desc: '会话页侧页（文件浏览器；官方移动壳族设计为右覆盖抽屉）',
      run: async (page) => {
        await closeOverlays(page) // 上一状态可能还开着命令面板
        for (const lbl of ['查看文件', '文件', '侧栏', '切换侧栏']) {
          const r = await clickByLabel(page, lbl)
          if (r.ok) { await page.waitForTimeout(1800); return { ok: true, via: lbl } }
        }
        return { ok: false, reason: 'no side pane toggle found' }
      },
    },
    {
      id: 'remote-control-dialog',
      desc: '移动端远程控制对话框（N5 入口：扫码 / Bot Channel）',
      run: async (page) => {
        // 侧页会顶掉侧栏（含页脚），先返回任务。
        for (const lbl of ['返回任务', '返回']) {
          const back = page.getByText(lbl, { exact: true })
          if (await back.count()) { await back.first().click({ timeout: 4000 }).catch(() => {}); await page.waitForTimeout(1200); break }
        }
        const r = await clickByLabel(page, '移动端远程控制')
        if (!r.ok) return r
        await page.waitForTimeout(1800)
        return { ok: true }
      },
    },
    {
      id: 'remote-control-dialog-closed',
      desc: '关闭远控对话框后的会话页（浮层关闭路径）',
      run: async (page) => {
        await closeOverlays(page)
        await page.waitForTimeout(600)
        return { ok: true }
      },
    },
    {
      id: 'settings',
      desc: '设置页（h-screen 全屏视图：68px 图标栏 + 内容列）',
      run: async (page) => {
        await closeOverlays(page)
        await page.waitForTimeout(500)
        const r = await clickByLabel(page, '设置')
        if (!r.ok) return r
        await page.waitForTimeout(1800)
        return { ok: true }
      },
    },
    {
      id: 'settings-exit-attempt',
      desc: '设置页退出路径实测（手机有无可达的返回/关闭入口）',
      noShot: true,
      run: async (page) => {
        const attempts = []
        if (!(await settingsOpen(page))) return { ok: false, reason: 'settings view not open' }

        await page.keyboard.press('Escape').catch(() => {})
        await page.waitForTimeout(700)
        attempts.push({ method: 'Escape 键', exited: !(await settingsOpen(page)) })

        // 找任何语义为「关闭/返回」的可点控件
        const closeLabels = ['返回工作区', '关闭', '返回', 'Close', '关闭设置', '返回任务']
        let clicked = null
        for (const lbl of closeLabels) {
          const loc = page.locator(`[aria-label="${lbl}"]`)
          if (await loc.count()) { await loc.first().click({ timeout: 3000 }).catch(() => {}); clicked = lbl; break }
        }
        if (clicked) { await page.waitForTimeout(900); attempts.push({ method: `点「${clicked}」`, exited: !(await settingsOpen(page)) }) }

        // 再点一次侧栏页脚的「设置」（桌面端的切换语义）
        const gear = page.locator('[aria-label="设置"]')
        if (await gear.count()) {
          await gear.first().click({ timeout: 3000 }).catch(() => {})
          await page.waitForTimeout(900)
          attempts.push({ method: '再点「设置」（切换）', exited: !(await settingsOpen(page)) })
        }

        // 浏览器返回
        await page.goBack({ timeout: 4000 }).catch(() => {})
        await page.waitForTimeout(1500)
        attempts.push({ method: '浏览器返回键', exited: !(await settingsOpen(page)) })

        return { ok: true, attempts, stillOpen: await settingsOpen(page) }
      },
    },
  ]
}

// ---------------------------------------------------------------- main
async function cleanEmptyDrafts(token) {
  const auth = { Authorization: `Bearer ${token}` }
  const j = async (path, init) => {
    const r = await fetch(`${BASE}${path}`, { headers: auth, ...init })
    if (!r.ok) throw new Error(`${r.status} ${path}`)
    return r.json().catch(() => null)
  }
  let removed = 0
  try {
    const list = await j('/api/sessions')
    for (const s of Array.isArray(list) ? list : []) {
      if (!/^New session/.test(s?.title ?? '')) continue
      const h = await j(`/api/session/${s.id}?limit=1`)
      if ((h?.cards ?? []).length > 0) continue
      await j(`/api/sessions/${s.id}/delete`, { method: 'POST' })
      removed += 1
    }
  } catch (e) {
    return { removed, error: String(e.message).slice(0, 120) }
  }
  return { removed }
}

async function main() {
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })
  const token = readFileSync(TOKEN_FILE, 'utf8').trim()
  if (!token) throw new Error(`empty token at ${TOKEN_FILE}`)

  // 拉会话列表（走隔离栈 REST，token 只在内存）
  const sessions = await (async () => {
    try {
      const r = await fetch(`${BASE}/api/sessions`, { headers: { Authorization: `Bearer ${token}` } })
      if (!r.ok) return []
      const list = await r.json()
      return Array.isArray(list) ? list.filter((s) => s?.id) : []
    } catch { return [] }
  })()

  const profile = join(OUT, `profile-${CDP_PORT}`)
  mkdirSync(profile, { recursive: true })
  const child = spawn(
    SHELL,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      'about:blank',
    ],
    { stdio: 'ignore', detached: false, env: { ...process.env, LD_LIBRARY_PATH: SHELL_LIB } },
  )

  let ready = false
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) { ready = true; break } } catch {}
    await sleep(250)
  }
  if (!ready) {
    try { child.kill('SIGKILL') } catch {}
    throw new Error(`headless shell did not open CDP on ${CDP_PORT}`)
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`)
  const report = {
    generatedAt: new Date().toISOString(),
    base: BASE,
    shell: SHELL,
    cdpPort: CDP_PORT,
    tokenSource: TOKEN_FILE,
    sessionsFound: sessions.length,
    devices: [],
  }

  const deviceKeys = deviceArg ? [deviceArg] : Object.keys(DEVICES)
  try {
    for (const key of deviceKeys) {
      const dev = DEVICES[key]
      if (!dev) throw new Error(`unknown device "${key}"`)
      const ctx = await browser.newContext({
        viewport: { width: dev.width, height: dev.height },
        deviceScaleFactor: dev.deviceScaleFactor,
        isMobile: true,
        hasTouch: true,
        userAgent: UA,
      })
      await ctx.addInitScript((t) => {
        try { localStorage.setItem('ocrc.token', t) } catch {}
      }, token)
      const page = await ctx.newPage()
      const consoleErrors = []
      const consoleWarnings = []
      page.on('console', (m) => {
        const t = m.text().slice(0, 300)
        if (m.type() === 'error') consoleErrors.push(t)
        else if (m.type() === 'warning') consoleWarnings.push(t)
      })
      page.on('pageerror', (e) => consoleErrors.push('[pageerror] ' + e.message.slice(0, 300)))
      const failedRequests = []
      page.on('requestfailed', (r) => failedRequests.push(`${r.method()} ${r.url()} ${r.failure()?.errorText ?? ''}`.slice(0, 200)))
      page.on('response', (r) => { if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url()}`.slice(0, 200)) })

      const deviceReport = { device: key, label: dev.label, states: [] }
      const states = buildFlow(sessions)
      const flowCtx = {}

      // 单次导航：避免每个状态都重新引导（引导会预热草稿会话，污染隔离栈）。
      await page.goto(`${BASE}/z/`, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(SETTLE_MS)

      for (const st of states) {
        const stateResult = { id: st.id, desc: st.desc }
        try {
          const runResult = (await st.run(page, flowCtx)) ?? { ok: true }
          stateResult.run = runResult
          if (runResult.title) flowCtx.lastSessionTitle = runResult.title
          stateResult.measurements = await page.evaluate(collectMeasurements)
          // noShot：状态结束时已离开应用（如浏览器返回键实测），截图无意义。
          if (!st.noShot) {
            const shot = join(OUT, `${key}-${st.id}.png`)
            await page.screenshot({ path: shot, fullPage: false })
            stateResult.screenshot = shot
          }
        } catch (e) {
          stateResult.error = String(e.message).slice(0, 300)
        }
        deviceReport.states.push(stateResult)
      }

      deviceReport.consoleErrors = [...new Set(consoleErrors)].slice(0, 30)
      deviceReport.consoleWarnings = [...new Set(consoleWarnings)].slice(0, 20)
      deviceReport.failedRequests = [...new Set(failedRequests)].slice(0, 40)
      report.devices.push(deviceReport)
      await ctx.close()
    }
  } finally {
    try { await browser.close() } catch {}
    try { child.kill('SIGKILL') } catch {}
    rmSync(profile, { recursive: true, force: true })
  }

  // 自净：ocrc 引导会为每次 /z/ 加载预热一个空 "New session" 草稿（应用自身也有
  // 5 分钟回收器）。探针只清自己造成的噪音 —— 空 + 默认标题，与回收器同规则。
  report.draftsCleaned = await cleanEmptyDrafts(token)
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))

  // 控制台摘要
  const lines = [`# 移动端探针报告 ${report.generatedAt}`, `base=${BASE} sessions=${sessions.length}`, '']
  for (const d of report.devices) {
    lines.push(`## ${d.label}`)
    for (const s of d.states) {
      const m = s.measurements
      lines.push(`- **${s.id}** ${m ? `viewport=${m.viewport.W}x${m.viewport.H} overflowX=${m.docOverflowX} 触达<44px=${m.tapTargetCount} 越界=${m.offscreenCount} hover-only=${m.hoverOnlyCount} 小字号可编辑=${m.smallFontEditable.length} 侧栏=${m.layout.sidebarPanel ? m.layout.sidebarPanel.w + 'px' : '无'}` : `(失败: ${s.error ?? s.run?.reason ?? '?'})`}`)
      if (s.screenshot) lines.push(`  - 截图: ${s.screenshot}`)
    }
    if (d.consoleErrors.length) lines.push(`- console errors: ${d.consoleErrors.length} → ${JSON.stringify(d.consoleErrors.slice(0, 5))}`)
    if (d.failedRequests.length) lines.push(`- 4xx/失败请求: ${JSON.stringify(d.failedRequests.slice(0, 8))}`)
    lines.push('')
  }
  writeFileSync(join(OUT, 'report.md'), lines.join('\n'))
  console.log(lines.join('\n'))
}

main().catch((e) => {
  console.error('[mobile-audit] FAILED:', e.message)
  process.exit(1)
})
