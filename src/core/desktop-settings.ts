/**
 * openchamber desktop settings integration — the `--desktop-add` path.
 *
 * The desktop shell (Electron) owns `desktopSshInstances` in
 * `~/.config/openchamber/settings.json` and does **not** watch the file: a
 * write while the app is running is invisible until the next start, and a
 * malformed write can lose the user's host list. So this module:
 *   · refuses to write unless the app is not running (a running Electron holds
 *     the same file and would overwrite us on exit);
 *   · backs the file up as `.ocrc-bak` before the first change;
 *   · upserts exactly one entry by id and never touches other keys;
 *   · never writes the UI password or a client token (the user types the
 *     password once; `store: "never"` keeps it out of the file).
 *
 * Everything here is pure except `desktopSettingsPath`, so it is unit-testable
 * without touching a real install.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { RemoteInstance } from './remote-instance.js'

export interface DesktopSshInstance {
  id: string
  nickname?: string
  sshCommand: string
  connectionTimeoutSec: number
  remoteOpenchamber: {
    mode: 'external'
    keepRunning: boolean
    bindHost: '127.0.0.1'
    preferredPort: number
    installMethod: 'auto'
    uploadBundleOverSsh: boolean
  }
  localForward: { bindHost: '127.0.0.1' }
  auth: { openchamberPassword: { enabled: true; store: 'never' } }
  portForwards: Array<{
    id: string
    enabled: boolean
    type: 'remote'
    localHost: '127.0.0.1'
    localPort: number
    remoteHost: '127.0.0.1'
    remotePort: number
  }>
}

export function desktopSettingsPath(home = homedir()): string {
  return process.env.OPENCHAMBER_DATA_DIR?.trim()
    ? join(process.env.OPENCHAMBER_DATA_DIR.trim(), 'settings.json')
    : join(home, '.config', 'openchamber', 'settings.json')
}

export interface DesktopSettingsRoot {
  desktopSshInstances?: unknown[]
  desktopDefaultHostId?: string
  [key: string]: unknown
}

/** Read the settings file; an absent file is `{}`, a parse error is reported so
 *  the caller refuses rather than clobbering someone's config. */
export function readDesktopSettings(path: string): DesktopSettingsRoot {
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    return {}
  }
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} 不是 JSON 对象——拒绝改写桌面版配置`)
  }
  return parsed as DesktopSettingsRoot
}

/** The desktop entry for one remote instance. `reverseRelay` adds the `-R`
 *  forward that gives the peer engine its egress (R9) — the desktop shell owns
 *  both legs, so this process only runs the local relay listener. */
export function desktopEntryFor(instance: RemoteInstance, opts: { reverseRelay?: { remotePort: number; localPort: number } } = {}): DesktopSshInstance {
  const sshCommand = `ssh ${instance.user ? `${instance.user}@` : ''}${instance.host}${instance.port && instance.port !== 22 ? ` -p ${instance.port}` : ''}`
  const portForwards: DesktopSshInstance['portForwards'] = []
  if (opts.reverseRelay) {
    portForwards.push({
      id: `${instance.id}-relay`,
      enabled: true,
      type: 'remote',
      localHost: '127.0.0.1',
      localPort: opts.reverseRelay.localPort,
      remoteHost: '127.0.0.1',
      remotePort: opts.reverseRelay.remotePort,
    })
  }
  return {
    id: instance.id,
    ...(instance.name ? { nickname: instance.name } : {}),
    sshCommand,
    connectionTimeoutSec: 60,
    remoteOpenchamber: {
      mode: 'external',
      keepRunning: true,
      bindHost: '127.0.0.1',
      preferredPort: instance.instancePort,
      installMethod: 'auto',
      uploadBundleOverSsh: false,
    },
    localForward: { bindHost: '127.0.0.1' },
    auth: { openchamberPassword: { enabled: true, store: 'never' } },
    portForwards,
  }
}

/** Merge one entry into the settings root (pure). An existing entry with the
 *  same id is replaced; everything else — other instances, hosts, preferences —
 *  is preserved verbatim. `setDefault` also points the default host at it. */
export function mergeDesktopEntry(
  root: DesktopSettingsRoot,
  entry: DesktopSshInstance,
  opts: { setDefault?: boolean } = {},
): DesktopSettingsRoot {
  const existing = Array.isArray(root.desktopSshInstances) ? root.desktopSshInstances : []
  const without = existing.filter((x) => !(x && typeof x === 'object' && (x as { id?: string }).id === entry.id))
  const next: DesktopSettingsRoot = { ...root, desktopSshInstances: [...without, entry] }
  if (opts.setDefault) next.desktopDefaultHostId = entry.id
  return next
}

export interface DesktopWriteResult {
  ok: boolean
  path: string
  detail: string
}

/** Write the merged settings atomically, with a one-time `.ocrc-bak` backup.
 *  Refuses when the desktop app is running (`appRunning`), because the live
 *  shell would rewrite the file on exit and drop our entry. */
export function writeDesktopSettings(
  path: string,
  root: DesktopSettingsRoot,
  opts: { appRunning?: boolean; backup?: boolean } = {},
): DesktopWriteResult {
  if (opts.appRunning) {
    return { ok: false, path, detail: 'openchamber 桌面版正在运行——它会覆盖这个文件；请先退出桌面版再写，或在它的 Remote Instances 里手工添加' }
  }
  const text = `${JSON.stringify(root, null, 2)}\n`
  if (opts.backup !== false) {
    try {
      const current = readFileSync(path, 'utf-8')
      writeFileSync(`${path}.ocrc-bak`, current)
    } catch { /* no existing file: nothing to back up */ }
  }
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, text)
  renameSync(tmp, path)
  return { ok: true, path, detail: `已写入 ${path}（手工合并说明见 OPS）` }
}