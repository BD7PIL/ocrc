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
  id: 'demo@192.168.26.101', host: '192.168.26.101', user: 'demo', name: 'EL7 box',
  instancePort: 2610, localPort: 4610,
  status: {
    state: 'online', app: '2.3.3', url: 'http://127.0.0.1:4610',
    engine: { path: '/home/demo/.ocrc/remote/engine/opencode', version: '2.0.27' },
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
}

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
