#!/usr/bin/env node
// Guest UI smoke + screenshots — real Edge, real sandbox, real theme handshake.
//
// This is the gate unit tests cannot be. Both defects that shipped from batch 2
// are invisible in jsdom: a `process.env` reference left in the bundle crashes
// the frame on load, and a frame that never receives the host theme paints a
// frozen palette. Neither appears until the bundle runs inside a sandboxed
// <iframe> served over http, which is what this script reproduces.
//
// It plays the host's side of the bridge for real: `sandbox="allow-scripts"`
// (opaque origin, no modals), a `ready` envelope carrying a theme, answers to
// the frames' service calls and workspace reads from a fixture table. Then it
// screenshots dark and light, and asserts what a screenshot cannot show: that
// the tokens landed, that the kit's geometry is live, that the frame paints no
// plane of its own, and that nothing threw on load.
//
// Usage:  node scripts/cdp/guest-ui.mjs
// Env:    OCRC_GUEST_SHOTS  output directory (default /tmp/ocrc-guest-ui)
//         OCRC_BROWSER      browser executable if the msedge channel is absent
//         OCRC_KEEP=1       leave the static server up and print its URL

import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(pathToFileURL(join(repoRoot, 'package.json')))
const { chromium } = require('playwright-core')

const OUT = process.env.OCRC_GUEST_SHOTS ?? '/tmp/ocrc-guest-ui'

/** The SDK owns the wire contract; read it instead of restating it. */
const apiVersion = await import(
  pathToFileURL(join(repoRoot, 'extensions/ocrc-remote/node_modules/@openchamber/sdk/dist/api-version.js')).href
)
const CHANNEL = apiVersion.OPENCHAMBER_SDK_CHANNEL
const API_VERSION = apiVersion.OPENCHAMBER_SDK_API_VERSION

const STATUS_FIXTURE = {
  status: { profileId: 'vm1', tunnel: 'up', engine: 'reachable' },
  profiles: [
    { id: 'vm1', name: 'V93000 测试机', host: '192.168.26.101', port: 22, user: 'demo', remotePort: 4096, localPort: 4096, allowedRoots: ['/home/demo/project'], projects: [{ path: '/home/demo/project' }] },
    { id: 'vm2', name: 'EL5 老机器', host: '192.168.26.102', port: 2222, user: 'ops', remotePort: 4096, localPort: 4097 },
  ],
}

const PROJECTS = [{ id: 'p1', name: 'ocrc', directory: '/srv/ocrc' }]

const SESSIONS = [
  { id: 's1', title: '把面板行为对齐宿主', projectId: 'p1', directory: '/srv/ocrc', parentId: null, createdAt: 1, updatedAt: 90, archivedAt: null, worktree: null, activity: 'running', outcome: null, items: [] },
  { id: 's2', title: '审计 guest SDK 契约', projectId: 'p1', directory: '/srv/ocrc', parentId: 's1', createdAt: 2, updatedAt: 80, archivedAt: null, worktree: null, activity: 'idle', outcome: 'completed', items: [] },
  { id: 's3', title: '复现 process.env 崩溃', projectId: 'p1', directory: '/srv/ocrc', parentId: 's1', createdAt: 3, updatedAt: 70, archivedAt: null, worktree: null, activity: 'idle', outcome: 'failed', items: [] },
  { id: 's4', title: '整理 handoff 文档', projectId: 'p1', directory: '/srv/ocrc', parentId: 's2', createdAt: 4, updatedAt: 60, archivedAt: null, worktree: null, activity: 'waiting-permission', outcome: null, items: [] },
]

/** The frames under test: package root, manifest entry, surface, fixtures. */
const FRAMES = [
  {
    name: 'ocrc-remote-panel',
    root: join(repoRoot, 'extensions/ocrc-remote'),
    entry: 'panel/index.html',
    surface: 'panel',
    directory: '/srv/ocrc',
    // The project list is what `listProjects()` hands the handoff: the bound
    // work directory on the controlled host has to appear here for the
    // "new session in this project" path to be reachable at all.
    projects: [{ id: 'p9', name: 'project', directory: '/home/demo/project' }],
    routes: {
      '/status': STATUS_FIXTURE,
      '/detect': {
        detect: {
          reachable: true, platform: 'linux-x64', baseline: false,
          os: 'Red Hat Enterprise Linux Server 7.9 (Maipo)', kernel: '3.10.0-1160.el7.x86_64', glibc: '2.17',
          container: 'none', home: '/home/demo', homeWritable: true, hasSh: true, hasTar: true, outbound: true,
          engine: null, legacyEngine: { path: '/home/demo/.local/bin/opencode', version: '1.18.34' }, node: 'v22.11.0',
        },
        readiness: {
          ready: false,
          steps: [
            { id: 'ssh', label: '① SSH 可达', ok: true, detail: '已连上（Red Hat Enterprise Linux Server 7.9 (Maipo)）' },
            { id: 'shell', label: '② sh + tar + 可写 $HOME', ok: true, detail: 'sh ✓ · tar ✓ · $HOME 可写 ✓' },
            { id: 'engine', label: '③ 引擎在位且版本匹配', ok: false, detail: '~/.opencode/bin 里没有；另有既有安装 1.18.34@/home/demo/.local/bin/opencode（不会动它）', action: '点「部署引擎」把面板宿主的引擎版本装到 ~/.opencode/bin（不覆盖用户既有安装）。' },
            { id: 'project', label: '④ 远程工作目录可写', ok: true, detail: '/home/demo/project' },
          ],
        },
        anchor: '2.0.27',
        anchorSource: '面板宿主 /Users/me/.opencode/bin/opencode',
      },
      '/config/source': {
        configPath: 'C:\\Users\\me\\AppData\\Roaming\\opencode\\opencode.json',
        exists: true,
        sections: { agent: ['build', 'plan'], mcp: ['servers'], providers: ['searxng', 'tavily'] },
        agentFiles: [{ name: 'reviewer', path: 'agents/reviewer.md', size: 812 }],
      },
      '/capabilities': {
        capabilities: [
          { id: 'searxng', label: 'searxng 检索', where: 'remote', needs: { runtime: ['node>=20'], network: ['192.168.96.11:8080'], secrets: ['SEARXNG_TOKEN'] } },
          { id: 'files', label: 'files（远端本地）', where: 'remote', needs: {} },
        ],
        forwards: [{ direction: 'local', peerHost: '192.168.96.11', peerPort: 8080, port: 18080, reason: 'searxng' }],
        rewrites: [{ from: 'http://192.168.96.11:8080', to: 'http://127.0.0.1:18080' }],
        notes: ['searxng 的地址在内网，面板宿主直连不到——补一条转发，URL 跟着实际端口改写'],
        config: { projectPath: '/home/demo/project', targetPath: '/home/demo/project/opencode.jsonc', format: 'jsonc', exists: true },
      },
      '/config/preview': {
        remotePath: '/home/demo/project/opencode.jsonc',
        remoteExisted: true,
        sectionsBridged: ['agent', 'mcp', 'providers'],
        agentFilesBridged: ['reviewer'],
        changed: true,
        mergedPreview: '{\n  "mcp": { "servers": { "searxng": { "type": "local" } } }\n}',
      },
      '/omo/config': {
        exists: true,
        format: 'jsonc',
        size: 4210,
        activePreset: 'balanced',
        presetNames: ['balanced', 'cheap', 'deep'],
        fallback: { enabled: true, maxRetries: 3, retryDelayMs: 500, continuationPolicy: 'retry-primary' },
        agentChains: { balanced: { orchestrator: { model: 'opus' }, explorer: { model: ['sonnet', 'haiku'] } } },
        parsed: { preset: 'balanced' },
      },
      '/git-branch': { branch: 'main' },
    },
  },
  {
    name: 'ocrc-remote-status',
    root: join(repoRoot, 'extensions/ocrc-remote'),
    entry: 'status/index.html',
    surface: 'status',
    directory: '/srv/ocrc',
    routes: { '/status': { ...STATUS_FIXTURE, profiles: STATUS_FIXTURE.profiles.slice(0, 1) }, '/git-branch': { branch: 'feat/panel-fusion' } },
  },
  {
    name: 'ocrc-omo-view-panel',
    root: join(repoRoot, 'extensions/ocrc-omo-view'),
    entry: 'panel/index.html',
    surface: 'panel',
    directory: '/srv/ocrc',
    projects: PROJECTS,
    sessions: SESSIONS,
    routes: {},
  },
]

/** A dark and a light theme in the host's own token vocabulary, so the
 *  assertions read the same names openchamber writes onto a guest root. */
const THEMES = {
  dark: {
    mode: 'dark',
    tokens: {
      background: '#0e0e10', elevated: '#1c1c1f', foreground: '#e8e8e8', muted: '#9a9aa0',
      subtle: '#2a2a2e', border: '#33333a', hover: '#26262b', selection: '#3a2a1c',
      focus: '#fb8b3c', primary: '#fb8b3c', mutedSurface: '#16161a', elevatedForeground: '#e8e8e8',
      active: '#2f2f35', selectionForeground: '#fb8b3c', primaryForeground: '#211307',
      primaryText: '#fb8b3c', successText: '#6ee7a0', warningText: '#ffd479', errorText: '#f97066',
      infoText: '#8ab4ff', success: '#6ee7a0', warning: '#ffd479', error: '#f97066', info: '#8ab4ff',
      font: '"Segoe UI", system-ui, sans-serif', mono: 'ui-monospace, "Cascadia Mono", monospace', radius: '9px',
    },
  },
  light: {
    mode: 'light',
    tokens: {
      background: '#fdfdfd', elevated: '#ffffff', foreground: '#262626', muted: '#6b6b70',
      subtle: '#efeff1', border: '#d6d6d9', hover: '#f2f2f4', selection: '#fbe6d6',
      focus: '#e4580f', primary: '#e4580f', mutedSurface: '#f6f6f7', elevatedForeground: '#262626',
      active: '#e9e9ec', selectionForeground: '#8a3200', primaryForeground: '#ffffff',
      primaryText: '#e4580f', successText: '#1f7a3d', warningText: '#9a6b00', errorText: '#c2372c',
      infoText: '#2456a6', success: '#1f7a3d', warning: '#9a6b00', error: '#c2372c', info: '#2456a6',
      font: '"Segoe UI", system-ui, sans-serif', mono: 'ui-monospace, "Cascadia Mono", monospace', radius: '9px',
    },
  },
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

function startServer() {
  const mounts = new Map(FRAMES.map((f) => [`/${f.name}`, f.root]))
  const harness = harnessHtml()
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/harness.html') {
      res.writeHead(200, { 'content-type': MIME['.html'] })
      res.end(harness)
      return
    }
    const [, mount, ...rest] = url.pathname.split('/')
    const root = mounts.get(`/${mount}`)
    const file = root ? join(root, normalize(rest.join('/')).replace(/^(\.\.[/\\])+/, '')) : null
    if (!root || !file || !file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end('not found')
      return
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    createReadStream(file).pipe(res)
  })
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({ server, port: server.address().port })))
}

/** The host's side of the bridge plus a strip of chrome painted with the very
 *  tokens the frame is handed — so one screenshot shows whether they match. */
function harnessHtml() {
  const frames = FRAMES.map((f) => ({
    name: f.name, entry: f.entry, surface: f.surface, directory: f.directory,
    routes: f.routes, projects: f.projects ?? null, sessions: f.sessions ?? [],
  }))

  return `<!doctype html>
<html><head><meta charset="utf-8" /><link rel="icon" href="data:," /><title>guest harness</title>
<style>
  html, body { margin: 0; height: 100%; }
  body { font: 13px/1.45 var(--font-sans); color: var(--surface-foreground); background: var(--surface-background); }
  header { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--interactive-border); background: var(--surface-muted); }
  header span { color: var(--surface-muted-foreground); }
  header button { font: inherit; color: var(--surface-foreground); background: var(--surface-elevated); border: 1px solid var(--interactive-border); border-radius: 7px; padding: 4px 10px; cursor: pointer; }
  main { height: calc(100% - 42px); }
  iframe { width: 100%; height: 100%; border: 0; background: transparent; }
</style></head>
<body>
<header>
  <b>openchamber 壳（对照铬件）</b>
  <span id="mode"></span>
  <button id="toggle">切换主题</button>
</header>
<main><iframe id="guest" sandbox="allow-scripts" src="about:blank"></iframe></main>
<script>
const CHANNEL = ${JSON.stringify(CHANNEL)};
const V = ${JSON.stringify(API_VERSION)};
const FRAMES = ${JSON.stringify(frames)};
const THEMES = ${JSON.stringify(THEMES)};

let current = FRAMES[0];
let theme = THEMES.dark;

const paint = () => {
  document.documentElement.style.colorScheme = theme.mode;
  for (const [key, value] of Object.entries(theme.tokens)) {
    document.documentElement.style.setProperty('--' + key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()), value);
  }
  document.getElementById('mode').textContent = theme.mode;
};
paint();

const envelope = (type, payload, extra) => Object.assign({ channel: CHANNEL, v: V, type, payload }, extra ?? {});
const reply = (source, id, payload) => source.postMessage({ channel: CHANNEL, v: V, type: 'result', id, ok: true, payload }, '*');
const push = (type, payload, id) => document.getElementById('guest').contentWindow.postMessage(envelope(type, payload, id ? { id } : undefined), '*');

/** Guest→host traffic the smoke drives and then reads back: the resolved chip,
 *  and every handoff the panel asked for. */
const recorded = [];
const awaiting = new Map();
let seq = 0;
const hostRequest = (type, payload) => new Promise((done, fail) => {
  const id = 'host-' + (++seq);
  awaiting.set(id, { done, fail });
  push(type, payload, id);
  setTimeout(() => { if (awaiting.delete(id)) fail(new Error('timeout waiting for ' + type)); }, 15_000);
});

const context = () => ({
  theme, locale: 'zh-CN', directory: current.directory, session: null, surface: current.surface,
  connection: { connected: true, account: 'local' }, settings: {}, item: null,
});

/** Every call the frames make, answered the way the host answers it. */
window.addEventListener('message', (event) => {
  const wire = event.data;
  if (!wire || wire.channel !== CHANNEL || wire.v !== V || !wire.id) return;
  try {
    if (wire.type === 'service-request') {
      const body = current.routes[wire.payload.path];
      reply(event.source, wire.id, { status: body ? 200 : 404, body: JSON.stringify(body ?? { error: 'no fixture for ' + wire.payload.path }) });
      return;
    }
    if (wire.type === 'workspace-read') {
      const query = wire.payload;
      reply(event.source, wire.id, query.kind === 'projects'
        ? { kind: 'projects', state: 'ready', projects: current.projects ?? [] }
        : { kind: 'sessions', projectId: query.projectId, state: 'ready', coverage: [], sessions: current.sessions });
      return;
    }
    // The command channel: the host asks the frame to resolve /ocrc-host, and the
    // frame answers with the chip it wants attached. Same wire the real host uses.
    if (wire.type === 'resolve-result') {
      const waiter = awaiting.get(wire.id);
      if (!waiter) return;
      awaiting.delete(wire.id);
      if (wire.payload && wire.payload.error) waiter.fail(new Error(wire.payload.error));
      else waiter.done(wire.payload ? wire.payload.item : null);
      return;
    }
    if (wire.type === 'attach' || wire.type === 'compose') {
      recorded.push({ type: wire.type, payload: wire.payload });
      reply(event.source, wire.id, undefined);
      return;
    }
    if (wire.type === 'start-session') {
      recorded.push({ type: wire.type, payload: wire.payload });
      // The host validates this shape (isStartSessionResult) before the guest sees it.
      reply(event.source, wire.id, { sessionId: 'ses-9', sent: 'sent', directory: current.directory });
      return;
    }
    reply(event.source, wire.id, undefined);
  } catch (error) {
    event.source.postMessage({ channel: CHANNEL, v: V, type: 'result', id: wire.id, ok: false, error: String(error) }, '*');
  }
});

/** Subscriptions: the host pushes an update once the frame has asked for one. */
window.addEventListener('message', (event) => {
  const wire = event.data;
  if (!wire || wire.channel !== CHANNEL || wire.type !== 'workspace-subscribe') return;
  const query = wire.payload.query;
  setTimeout(() => push('workspace', {
    subscriptionId: wire.payload.subscriptionId,
    snapshot: query.kind === 'projects'
      ? { kind: 'projects', state: 'ready', projects: current.projects ?? [] }
      : { kind: 'sessions', projectId: query.projectId, state: 'ready', coverage: [], sessions: current.sessions },
  }), 0);
});

window.__harness = {
  async boot(frameName, mode) {
    current = FRAMES.find((f) => f.name === frameName) ?? FRAMES[0];
    theme = THEMES[mode] ?? THEMES.dark;
    paint();
    const iframe = document.getElementById('guest');
    await new Promise((resolve) => {
      iframe.addEventListener('load', resolve, { once: true });
      iframe.src = '/' + current.name + '/' + current.entry;
    });
    push('ready', context());
    push('directory', { directory: current.directory });
    return true;
  },
  retheme(mode) {
    if (!THEMES[mode]) return false;
    theme = THEMES[mode];
    paint();
    push('ready', context());
    return true;
  },
  /** Submit one of the package's slash commands, exactly as the host does it. */
  resolveCommand(command, args = '') {
    return hostRequest('resolve', { command, args });
  },
  /** Everything the frame asked the host to do (attach / compose / start-session). */
  recorded() {
    return recorded.slice();
  },
  reset() {
    recorded.length = 0;
  },
};

document.getElementById('toggle').addEventListener('click', () => {
  theme = theme.mode === 'dark' ? THEMES.light : THEMES.dark;
  paint();
  push('ready', context());
});
</script>
</body></html>`
}

// ── run ──────────────────────────────────────────────────────────────────────
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const { server, port } = await startServer()
  const base = `http://127.0.0.1:${port}`

  const launch = { headless: true }
  if (process.env.OCRC_BROWSER) launch.executablePath = process.env.OCRC_BROWSER
  else launch.channel = 'msedge'

  const browser = await chromium.launch(launch)
  const page = await browser.newPage({ viewport: { width: 1180, height: 760 }, deviceScaleFactor: 2 })

  const frameErrors = []
  page.on('pageerror', (error) => frameErrors.push(String(error)))
  page.on('console', (message) => {
    if (message.type() === 'error') frameErrors.push(`${message.text()} @ ${message.location().url}`)
  })

  for (const frame of FRAMES) {
    for (const mode of ['dark', 'light']) {
      frameErrors.length = 0
      await page.goto(`${base}/harness.html`, { waitUntil: 'load' })
      await page.evaluate(([name, m]) => window.__harness.boot(name, m), [frame.name, mode])

      const guest = page.frames().find((f) => f.url().includes(`/${frame.name}/`))
      if (!guest) {
        check(`${frame.name}/${mode} frame mounted`, false, 'the iframe never loaded the extension entry')
        continue
      }
      await page.waitForTimeout(900)

      const probe = await guest.evaluate(() => ({
        surface: document.documentElement.dataset.ocSurface ?? null,
        background: getComputedStyle(document.documentElement).getPropertyValue('--surface-background').trim(),
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        bodyFont: getComputedStyle(document.body).fontFamily,
        kitStyle: Boolean(document.getElementById('oc-sdk-ui-style')),
        // Buttons inside the hidden tab panels measure 0 — that is the page
        // behaving, not a missing style, so only the painted ones are judged.
        buttons: [...document.querySelectorAll('.oc-sdk-btn')]
          .map((b) => Math.round(b.getBoundingClientRect().height))
          .filter((h) => h > 0),
        badges: document.querySelectorAll('.oc-sdk-badge').length,
        text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 200),
      }))

      const tokens = THEMES[mode].tokens
      check(`${frame.name}/${mode} theme painted`, probe.background === tokens.background, `--surface-background=${probe.background}`)
      check(`${frame.name}/${mode} surface declared`, probe.surface === frame.surface, `data-oc-surface=${probe.surface}`)
      check(`${frame.name}/${mode} frame paints no plane`, probe.bodyBackground === 'rgba(0, 0, 0, 0)', probe.bodyBackground)
      check(`${frame.name}/${mode} host font inherited`, probe.bodyFont.includes('Segoe UI'), probe.bodyFont)
      check(`${frame.name}/${mode} kit stylesheet live`, probe.kitStyle)
      check(`${frame.name}/${mode} host control geometry`, probe.buttons.every((h) => h === 32 || h === 28 || h === 24), `heights=${probe.buttons.join(',') || 'none'}`)
      check(`${frame.name}/${mode} rendered content`, probe.text.length > 0, probe.text.slice(0, 80))
      check(`${frame.name}/${mode} no frame errors`, frameErrors.length === 0, frameErrors.slice(0, 2).join(' | '))

      await page.screenshot({ path: join(OUT, `${frame.name}.${mode}.png`) })
    }
  }

  // ── 动线：composer 命令 → chip → 新会话 ─────────────────────────────────────
  // 单测能证明摘要文本对，却证明不了「在真实沙箱里命令注册得够早、chip 过得了宿主
  // 的 schema、握手真的走得通」。这一段就是那条链的端到端证据。
  {
    frameErrors.length = 0
    await page.goto(`${base}/harness.html`, { waitUntil: 'load' })
    await page.evaluate(() => window.__harness.boot('ocrc-remote-panel', 'dark'))
    const guest = page.frames().find((f) => f.url().includes('/ocrc-remote-panel/'))
    await page.waitForTimeout(900)

    let chip = null
    try {
      chip = await page.evaluate(() => window.__harness.resolveCommand('ocrc-host'))
    } catch (error) {
      check('command /ocrc-host resolves', false, String(error))
    }
    if (chip) {
      check('command /ocrc-host resolves', true, chip.title)
      check('command chip carries the host contract', chip.providerId === 'ocrc' && chip.id === 'host:vm1' && chip.url === 'http://127.0.0.1:4096/', `${chip.providerId} ${chip.id} ${chip.url}`)
      check('command chip briefs the model on the four rungs', chip.text.includes('就绪四档') && chip.text.includes('③ 引擎在位且版本匹配'), chip.text.split('\n').slice(0, 2).join(' / '))
      check('command chip carries machine-readable data', chip.data?.profileId === 'vm1' && chip.data?.pendingSteps?.includes('engine'))
    }

    await page.evaluate(() => window.__harness.reset())
    const clicked = await guest.evaluate(() => {
      const button = [...document.querySelectorAll('.oc-sdk-btn')].find((b) => b.textContent.includes('在此项目上新建会话'))
      if (!button || button.disabled) return false
      button.click()
      return true
    })
    check('handoff button is live on the host view', clicked)
    await page.waitForTimeout(600)

    const handed = await page.evaluate(() => window.__harness.recorded())
    const session = handed.find((r) => r.type === 'start-session')
    check('handoff opens a session in the bound project', Boolean(session) && session.payload.projectId === 'p9' && session.payload.navigation === 'open', session ? JSON.stringify({ projectId: session.payload.projectId, navigation: session.payload.navigation }) : `recorded=${handed.map((r) => r.type).join(',') || 'none'}`)
    check('handoff session is seeded with the same chip', Boolean(session) && session.payload.providerId === 'ocrc' && session.payload.id === 'host:vm1' && session.payload.text.includes('能力盘点'))

    const painted = await guest.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' '))
    check('handoff result is reported honestly', painted.includes('已在项目「project」新建会话 ses-9——首条消息已发给模型'), painted.slice(-160))
    check('handoff pass has no frame errors', frameErrors.length === 0, frameErrors.slice(0, 2).join(' | '))
    // Bring the block itself into frame — the screenshot is the record of it.
    await guest.evaluate(() => {
      const card = [...document.querySelectorAll('.oc-card')].find((c) => c.textContent.includes('交给模型'))
      card?.scrollIntoView({ block: 'center' })
    })
    await page.screenshot({ path: join(OUT, 'ocrc-remote-panel.handoff.png') })
  }

  await browser.close()
  if (process.env.OCRC_KEEP) console.log(`harness left running at ${base}/harness.html`)
  else server.close()

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed — screenshots in ${OUT}`)
  if (failed.length > 0) {
    console.error('guest UI smoke FAILED')
    process.exit(1)
  }
}

await main()
