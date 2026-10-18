import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createLogger } from '../utils/logger.js'
import { generateSecret } from '../utils/secret.js'
import {
  DEFAULT_APP_VERSION, DEFAULT_INSTANCE_PORT, DEFAULT_LOCAL_PORT, PROXY_DEFAULTS, RECONNECT_DEFAULTS,
  instanceIdFor, redactInstance, type RedactedInstance, type RemoteInstance,
} from './remote-instance.js'

const log = createLogger('remote-instances')

/**
 * Persisted list of remote openchamber instances — same discipline as
 * `remotes.json` (in-memory list, 100ms-debounced tmp+rename, 0600), one file
 * next door: `~/.ocrc/remote-instances.json`.
 *
 * Persistence is what makes R10's "restart-restore" possible at all: after the
 * control side (or this process) restarts, the list is the only thing that knows
 * a tunnel is supposed to be up. The `uiPassword` is the instance's own door and
 * **never leaves this file** — API responses go through `redactInstance`.
 */

export interface RemoteInstancesStore {
  list(): RemoteInstance[]
  get(id: string): RemoteInstance | undefined
  /** Upsert by id (default id = `user@host`, so re-adding a host updates it). */
  upsert(instance: Partial<RemoteInstance> & { host: string }): RemoteInstance
  update(id: string, patch: Partial<Omit<RemoteInstance, 'id'>>): RemoteInstance | undefined
  remove(id: string): boolean
  /**
   * Re-read the file. The switches (R10) are decisions a **running** supervisor
   * has to see: without this, `ocrc remote switches <id> --reconnect off` in one
   * process is invisible to the supervisor in another, and the tunnel keeps
   * reconnecting against an explicit "off". A pending local write wins — reload
   * is skipped rather than clobbering an unsaved change (the 100 ms debounce).
   */
  reload(): void
  /** Write any debounced change now. The extension service is long-lived, so it
   *  opts out of the process-exit hook and calls this on shutdown instead. */
  flush(): void
}

export function remoteInstancesPath(home: string): string {
  return join(home, 'remote-instances.json')
}

export function createRemoteInstancesStore(path: string, opts: { flushOnExit?: boolean } = {}): RemoteInstancesStore {
  let instances: RemoteInstance[] = []

  function load(): void {
    if (!existsSync(path)) return
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as { instances?: RemoteInstance[] }
      if (!Array.isArray(raw.instances)) return
      instances = raw.instances.filter((i) => i && typeof i.id === 'string' && typeof i.host === 'string' && i.host)
    } catch (err) {
      log.warn(`failed to load ${path}: ${(err as Error).message}`)
    }
  }

  let writeQueued: ReturnType<typeof setTimeout> | undefined
  let pending: RemoteInstance[] | undefined

  function writeNow(): void {
    if (!pending) return
    const snapshot = pending
    pending = undefined
    try {
      mkdirSync(dirname(path), { recursive: true })
      const tmp = `${path}.tmp`
      writeFileSync(tmp, JSON.stringify({ instances: snapshot }, null, 2), { mode: 0o600 })
      renameSync(tmp, path)
    } catch (err) {
      log.warn(`persist failed: ${(err as Error).message}`)
    }
  }

  function persist(): void {
    pending = instances.map((i) => ({ ...i }))
    if (writeQueued) clearTimeout(writeQueued)
    writeQueued = setTimeout(() => {
      writeQueued = undefined
      writeNow()
    }, 100)
    // unref: the debounce must not hold the host open…
    writeQueued.unref?.()
    // …but a short-lived process (the CLI) exits before that timer fires, so the
    // last write is flushed synchronously at exit. Without this, `ocrc remote add`
    // prints a record it never saved.
    if (opts.flushOnExit !== false && !exitHooked) {
      exitHooked = true
      process.on('exit', writeNow)
    }
  }
  let exitHooked = false

  /** Fill in the defaults and the three R10 switches in one place — a half-filled
   *  record is what turns "reconnect" into "sometimes reconnect". */
  function normalize(i: RemoteInstance): RemoteInstance {
    // A1: the password only exists in password mode. Switching back to key mode
    // must **erase** it, not park it in the file: a credential for someone
    // else's machine that the UI no longer shows is exactly the kind of thing
    // that gets forgotten and then leaks out of a backup.
    const sshAuth = i.sshAuth === 'password' ? 'password' as const : undefined
    const sshPassword = sshAuth === 'password' && i.sshPassword ? String(i.sshPassword) : undefined
    return {
      ...i,
      name: i.name?.trim() || undefined,
      user: i.user?.trim() || undefined,
      sshAuth,
      sshPassword,
      port: i.port > 0 ? i.port : 22,
      instancePort: i.instancePort > 0 ? i.instancePort : DEFAULT_INSTANCE_PORT,
      localPort: i.localPort > 0 ? i.localPort : DEFAULT_LOCAL_PORT,
      appVersion: i.appVersion?.trim() || DEFAULT_APP_VERSION,
      enabled: i.enabled ?? true,
      provision: i.provision === 'reuse' ? 'reuse' as const : undefined,
      // 出口策略是闭集：认不出来的值等于没设（= auto，由探测决定），
      // 不能让一个拼错的值悄悄变成"总是经控制端"。
      egress: i.egress === 'relay' || i.egress === 'direct' ? i.egress : undefined,
      // C2b: per-peer provider URL rewrites — only non-empty strings survive, so
      // a half-filled form cannot write `baseURL: undefined` into the peer.
      providerBaseUrl: (() => {
        const src = i.providerBaseUrl
        if (!src || typeof src !== 'object') return undefined
        const out: Record<string, string> = {}
        for (const [provider, url] of Object.entries(src)) {
          const key = provider.trim()
          const value = typeof url === 'string' ? url.trim() : ''
          if (key && value) out[key] = value
        }
        return Object.keys(out).length > 0 ? out : undefined
      })(),
      reconnect: i.reconnect ?? RECONNECT_DEFAULTS.reconnect,
      restoreOnStart: i.restoreOnStart ?? RECONNECT_DEFAULTS.restoreOnStart,
      replayQueued: i.replayQueued ?? RECONNECT_DEFAULTS.replayQueued,
      proxy: {
        enabled: i.proxy?.enabled ?? PROXY_DEFAULTS.enabled,
        localPort: i.proxy?.localPort && i.proxy.localPort > 0 ? i.proxy.localPort : PROXY_DEFAULTS.localPort,
        remotePort: i.proxy?.remotePort && i.proxy.remotePort > 0 ? i.proxy.remotePort : PROXY_DEFAULTS.remotePort,
        allow: Array.isArray(i.proxy?.allow)
          ? [...new Set(i.proxy.allow.map((a) => String(a).trim().toLowerCase()).filter(Boolean))]
          : [],
      },
    }
  }

  load()

  return {
    list: () => instances.map((i) => ({ ...i })),
    reload() {
      // 有未落盘的本地改动就不动（避免把刚改的开关读没了）
      if (!pending) load()
    },
    flush() {
      if (writeQueued) {
        clearTimeout(writeQueued)
        writeQueued = undefined
      }
      writeNow()
    },
    get: (id) => {
      const i = instances.find((x) => x.id === id)
      return i ? { ...i } : undefined
    },
    upsert(instance) {
      const id = instance.id?.trim() || instanceIdFor(instance)
      const existing = instances.find((x) => x.id === id)
      if (existing) {
        Object.assign(existing, instance, { id })
        Object.assign(existing, normalize(existing))
        existing.uiPassword ??= generateSecret()
        persist()
        return { ...existing }
      }
      const fresh = normalize({
        id,
        host: instance.host,
        port: instance.port ?? 22,
        user: instance.user,
        sshAuth: instance.sshAuth,
        sshPassword: instance.sshPassword,
        name: instance.name,
        instancePort: instance.instancePort ?? DEFAULT_INSTANCE_PORT,
        localPort: instance.localPort ?? DEFAULT_LOCAL_PORT,
        uiPassword: instance.uiPassword || generateSecret(),
        enginePath: instance.enginePath,
        engineVersion: instance.engineVersion,
        appVersion: instance.appVersion ?? DEFAULT_APP_VERSION,
        enabled: instance.enabled ?? true,
        provision: instance.provision,
        egress: instance.egress,
        providerBaseUrl: instance.providerBaseUrl,
        reconnect: instance.reconnect,
        restoreOnStart: instance.restoreOnStart,
        replayQueued: instance.replayQueued,
        proxy: instance.proxy,
      })
      instances.push(fresh)
      persist()
      return { ...fresh }
    },
    update(id, patch) {
      const i = instances.find((x) => x.id === id)
      if (!i) return undefined
      Object.assign(i, patch)
      Object.assign(i, normalize(i))
      persist()
      return { ...i }
    },
    remove(id) {
      const idx = instances.findIndex((x) => x.id === id)
      if (idx === -1) return false
      instances.splice(idx, 1)
      persist()
      return true
    },
  }
}

export { redactInstance }
export type { RedactedInstance, RemoteInstance }
