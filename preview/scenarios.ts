import type { HostTheme } from '@openchamber/sdk'

/**
 * 预览用场景：面板与状态区在几种真实状态下长什么样。
 *
 * 这些形状和 `RemoteInstance.test.tsx` 里的一致——预览不是另造一套数据，
 * 否则"看着没问题"就只是预览没问题。
 */

export interface PreviewRow {
  id: string
  host: string
  user?: string
  port: number
  instancePort: number
  localPort: number
  appVersion: string
  name?: string
  enabled: boolean
  reconnect?: boolean
  restoreOnStart?: boolean
  sshAuth?: 'key' | 'password'
  hasSshPassword?: boolean
  provision?: 'push' | 'reuse'
  egress?: 'auto' | 'relay' | 'direct'
  hasUiPassword: boolean
  status: Record<string, unknown> | null
}

const base = {
  port: 22, appVersion: '2.3.3', enabled: true, reconnect: true, restoreOnStart: true,
  sshAuth: 'key' as const, hasSshPassword: false, provision: 'push' as const, egress: 'auto' as const,
  hasUiPassword: true,
}

export const ONLINE: PreviewRow = {
  ...base,
  id: 'user@192.0.2.10', host: '192.0.2.10', user: 'user', name: 'EL7 box',
  instancePort: 2610, localPort: 4610,
  status: {
    state: 'online', app: '2.3.3', url: 'http://127.0.0.1:4610',
    engine: { path: '/home/user/.ocrc/remote/engine/opencode', version: '2.0.27' },
    runtime: 'v24.22.0',
    proxy: { enabled: true, localPort: 4711, remotePort: 2711 },
    egress: { mode: 'auto', relay: true, reason: '探测：远程机器出不了网', probe: 'none', cached: true },
    inspected: { uname: 'Linux x86_64', glibc: '2.17' },
    detail: '远程实例已就绪（转发由桌面应用持有）',
  },
}

export const STOPPED: PreviewRow = {
  ...base,
  id: 'ubuntu@100.100.69.3', host: '100.100.69.3', user: 'ubuntu', name: 'Ubuntu 26.04',
  instancePort: 2612, localPort: 4612,
  status: {
    state: 'offline', app: '2.3.3', url: 'http://127.0.0.1:4612',
    engine: { path: '/home/ubuntu/.ocrc/remote/engine/opencode', version: '2.0.27' },
    runtime: 'v24.22.0',
    egress: { mode: 'auto', relay: false, reason: '探测：远程机器自己能出网', probe: 'direct', cached: true },
    detail: '远程实例未响应（reconnect 关，不自动重启）',
  },
}

export const FRESH: PreviewRow = {
  ...base,
  id: 'root@10.0.0.5', host: '10.0.0.5', user: 'root', name: '新机器',
  instancePort: 2614, localPort: 4614,
  status: { state: 'unknown', url: 'http://127.0.0.1:4614', detail: '还没有检查过这台机器' },
}

export const SCENARIOS: Record<string, PreviewRow[]> = {
  empty: [],
  one: [ONLINE],
  two: [ONLINE, STOPPED],
  mixed: [ONLINE, STOPPED, FRESH],
  fresh: [FRESH],
  /** 升级发现：已停机器 + 渠道有 2.5.0（defaults 由 sdk-shim 注入 latestPack）。 */
  upgrade: [STOPPED],
}

export const rows = (scenario: string): PreviewRow[] =>
  scenario === 'upfail' ? [STOPPED]
    : scenario === 'pw' ? [{ ...STOPPED, sshAuth: 'password' as const, hasSshPassword: true, provision: 'reuse' as const }]
      : SCENARIOS[scenario] ?? []

/**
 * 每个 op 的固定应答——**没有这些，面板里那些卡片根本打不开**，
 * 而"看过每个组件"要求它们都能打开。
 */
export const opRoutes = () => ({
  'POST /remote-instance#defaults': {
    body: { localPort: 4614, instancePort: 2610, appVersion: '2.3.3', enginePin: '2.0.27', nodeRuntime: '24.22.0', bind: '127.0.0.1', taken: [4610, 4612] },
  },
  'POST /remote-instance#plan': {
    body: {
      reachable: true,
      inspected: { uname: 'Linux x86_64', glibc: '2.17', home: '/home/user' },
      app: '2.3.3',
      engineError: '远程机器上没有找到满足 v2 门禁的 OpenCode（候选：$HOME/.ocrc/remote/engine/opencode, $HOME/.opencode/bin/opencode, $HOME/.local/bin/opencode）——先装一份 v2（面板的「检查并安装」会推我们 pin 的那份）',
      engineCandidates: [
        { path: '/home/user/.local/bin/opencode', raw: '1.18.32' },
        { path: '/usr/local/bin/opencode', raw: '（版本未知）' },
      ],
      actions: [
        '推送运行时 node v24.22.0（控制端已备件，离线）',
        'FAIL OpenCode 不满足 v2 门禁：远程机器上只有 v1',
        '安装我们 pin 的 OpenCode 2.0.27 到 ~/.ocrc/remote/engine/opencode（远程机器现有 v1 一律不动）',
        '联网方式：经本机转发（远程机器出不了网）',
        '注意：实例端口 2610 在远程机器已被占用——换个实例端口，或确认那是上一次的实例（启动会复用）',
      ],
      url: 'http://127.0.0.1:4610',
      egress: { mode: 'auto', relay: true, reason: '远程机器出不了网', probe: 'none' },
      provision: 'push',
      tier: 'legacy-glibc217',
      peerPort: 'open',
      /** 0.10.0：检查结果里的实测运行版本与渠道最新（升级入口与「pin 不一致」提示）。 */
      liveApp: '2.5.1',
      latestPack: { version: '2.5.0' },
    },
  },
  'POST /remote-instance#pairlink': {
    body: {
      ok: true,
      detail: '配对链接已生成（远程实例在跑）',
      link: 'openchamber://connect?v=2&p=eyJ2IjoyLCJyZWxheSI6IndzczovL3JlbGF5Lm9wZW5jaGFtYmVyLmRldiIsImtleSI6Ik1IUU5aSUxFT2EzWU1KcUcifQ',
      expiresAt: '2026-10-18T12:34:56Z',
      url: 'http://127.0.0.1:4610',
    },
  },
  'POST /remote-instance#logs': {
    body: {
      lines: [
        '[2026-10-18T10:01:02Z] forward: ssh -N -L 127.0.0.1:4610:127.0.0.1:2610 -R 127.0.0.1:2711:127.0.0.1:4711 user@192.0.2.10',
        '[2026-10-18T10:01:03Z] forward: connected',
        '[2026-10-18T10:01:05Z] relay: listening on 127.0.0.1:4711',
        '[2026-10-18T10:01:06Z] probe: GET http://127.0.0.1:4610/api/system/info → 200 (openchamber 2.3.3)',
        '[2026-10-18T10:01:06Z] instance user@192.0.2.10: online',
      ],
    },
  },
  'POST /remote-instance#peerlog': {
    body: {
      ok: true,
      instance: [
        '2026-10-18T10:01:04Z serve: listening 127.0.0.1:2610',
        '2026-10-18T10:01:04Z engine: /home/user/.ocrc/remote/engine/opencode (2.0.27)',
      ],
      app: [
        '2026-10-18T10:01:05Z openchamber 2.3.3 started on 127.0.0.1:2610',
        '2026-10-18T10:01:07Z provider: 13 configured, 1 builtin',
      ],
      paths: { instance: '/home/user/.ocrc/remote/instance.log', app: '/home/user/.config/openchamber/logs/openchamber-2610.log' },
    },
  },
  'POST /remote-instance#uipassword': {
    body: { uiPassword: 'b3qGkbFTm3CuiGdVcKIBMu43', url: 'http://127.0.0.1:4610' },
  },
  'POST /remote-instance#configdiff': {
    body: {
      localDir: '/home/u/.config/opencode',
      add: ['skill/new-skill.md', 'agents/reviewer.md'],
      change: ['opencode.json'],
      same: ['skill/existing.md'],
      peerOnly: ['agent/old-agent.md'],
      unknown: ['auth.json'],
      auth: { local: true, peer: false },
      plan: {
        basename: 'opencode.jsonc',
        configChanged: true,
        files: ['opencode.jsonc', 'skill/new-skill.md', 'agents/reviewer.md'],
        deletes: [],
        keyDeletes: { requested: [], removed: [] },
        keyDeleteCandidates: [{ collection: 'provider', key: 'acc-provider' }, { collection: 'mcp.servers', key: 'acc' }],
        droppedManagedKeys: ['plugin'],
        secretsReplaced: [{ path: 'mcp.servers.acc.environment.ACC_TOKEN', env: 'ACC_TOKEN' }],
        baseUrlRewrites: [],
        shadowed: ['provider.acc.baseURL'],
        notes: ['远程机器独有的 1 个文件不会被动（要删得显式勾选）', 'plugin 键由远程机器自己的 OpenChamber 管，我们不写'],
      },
    },
  },
  'POST /remote-instance#syncconfig': {
    body: { ok: true, detail: '同步 3 个文件；opencode.jsonc.ocrc-bak 已留' },
  },
  'POST /remote-instance#syncauth': {
    body: { ok: true, detail: 'auth.json 已写到远程机器 0600（旧件留 .ocrc-bak）' },
  },
  'POST /remote-instance#up': { body: { ok: true, detail: '远程实例在线；openchamber 2.3.3' } },
  'POST /remote-instance#down': { body: { ok: true, detail: '已停' } },
  'POST /remote-instance#url': { body: { url: 'http://127.0.0.1:4610', online: true } },
})

/** 宿主主题：浅色/深色两套，和 app 里的观感对齐（`?theme=light|dark`）。 */
const LIGHT: HostTheme = {
  mode: 'light',
  tokens: {
    background: '#ffffff', elevated: '#ffffff', foreground: '#1b1b1f', muted: '#6a6a74',
    subtle: '#ececef', border: '#e2e2e6', hover: '#f4f4f6', selection: '#fde8d5',
    focus: '#e2761f', primary: '#e2761f', mutedSurface: '#f4f4f6', elevatedForeground: '#1b1b1f',
    active: '#e8e8ec', selectionForeground: '#8a4a10', primaryForeground: '#ffffff',
    primaryText: '#b35c12', successText: '#1a7f4b', warningText: '#8a6100', errorText: '#c0392b',
    infoText: '#1f5fa8', success: '#1a7f4b', warning: '#b8860b', error: '#c0392b', info: '#2f6fb8',
    font: 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
    mono: 'ui-monospace, SFMono-Regular, Consolas, monospace',
    radius: '9px',
  },
}

const DARK: HostTheme = {
  mode: 'dark',
  tokens: {
    background: '#0e0e10', elevated: '#1c1c1f', foreground: '#e8e8e8', muted: '#9a9aa0',
    subtle: '#2a2a2e', border: '#33333a', hover: '#26262b', selection: '#3a2a1c',
    focus: '#fb8b3c', primary: '#fb8b3c', mutedSurface: '#16161a', elevatedForeground: '#e8e8e8',
    active: '#2f2f35', selectionForeground: '#fb8b3c', primaryForeground: '#211307',
    primaryText: '#fb8b3c', successText: '#6ee7a0', warningText: '#ffd479', errorText: '#f97066',
    infoText: '#8ab4ff', success: '#6ee7a0', warning: '#ffd479', error: '#f97066', info: '#8ab4ff',
    font: 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
    mono: 'ui-monospace, SFMono-Regular, Consolas, monospace',
    radius: '9px',
  },
}

export const theme = (name: string | null): HostTheme => (name === 'dark' ? DARK : LIGHT)
