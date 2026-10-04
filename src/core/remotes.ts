import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { createLogger } from '../utils/logger.js'

const log = createLogger('remotes')

/**
 * 0.26.0 SSH remote hosts — persisted atomically at ~/.ocrc/remotes.json
 * (channels.json pattern: in-memory list, 100ms-debounced tmp+rename, 0600).
 * A remote is a machine ocrc can reach over SSH and turn into an agent host:
 * provision opencode there (official baseline, pinned), launch it bound to the
 * remote loopback, and reach it through an SSH local forward. The generated
 * serverPassword secures the remote HTTP endpoint (which the tunnel keeps
 * off-network); it never leaves this file and API responses redact it.
 */

export interface RemoteHost {
  id: string
  /** Display name; defaults to host. */
  name?: string
  host: string
  /** SSH port. */
  port: number
  /** SSH login user; omitted = system ssh default (~/.ssh/config or current user). */
  user?: string
  /** opencode serve port ON THE REMOTE (loopback-bound). 4199 keeps clear of a
   *  user-run 4096 serve on that machine. */
  remotePort: number
  /** HTTP Basic password ocrc sets on the remote serve it launches. */
  serverPassword?: string
  enabled: boolean
  /** Enterprise relay (0.27): proxy env injected into the REMOTE serve process
   *  so its LLM traffic rides the corporate gateway (ZCode's controlled
   *  env-re-injection model). NO_PROXY always gains 127.0.0.1/localhost — the
   *  tunnel traffic must never be hijacked by the proxy. */
  httpProxy?: string
  httpsProxy?: string
  noProxy?: string
  /** Extra CA the remote needs to trust the corporate gateway (MITM proxies). */
  caPath?: string
}

export interface RemotesStore {
  list(): RemoteHost[]
  get(id: string): RemoteHost | undefined
  /** Upsert by id (new ids get a generated password unless one is provided). */
  upsert(remote: Partial<RemoteHost> & { host: string }): RemoteHost
  update(id: string, patch: Partial<Omit<RemoteHost, 'id'>>): RemoteHost | undefined
  remove(id: string): boolean
}

export function generateServerPassword(): string {
  return randomBytes(18).toString('base64url')
}

/** API-facing redaction — everything the panel may see, minus the secrets.
 *  Proxy URLs may embed credentials (http://user:pass@gw) — userinfo is
 *  scrubbed, the rest of the URL stays visible for panel display. */
export type RedactedRemote = Omit<RemoteHost, 'serverPassword'> & { hasPassword: boolean }
export function redactProxyUrl(u: string | undefined): string | undefined {
  if (!u) return u
  try {
    const url = new URL(u)
    if (url.username || url.password) {
      url.username = '***'
      url.password = ''
    }
    return url.toString()
  } catch {
    return u // not a parseable URL — show as-is (likely a bare host:port)
  }
}
export function redactRemote(r: RemoteHost): RedactedRemote {
  const { serverPassword, ...rest } = r
  return {
    ...rest,
    httpProxy: redactProxyUrl(rest.httpProxy),
    httpsProxy: redactProxyUrl(rest.httpsProxy),
    hasPassword: !!serverPassword,
  }
}

export function createRemotesStore(path: string): RemotesStore {
  let remotes: RemoteHost[] = []

  function load(): void {
    if (!existsSync(path)) return
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as { remotes?: RemoteHost[] }
      if (!Array.isArray(raw.remotes)) return
      remotes = raw.remotes.filter((r) => r && typeof r.id === 'string' && typeof r.host === 'string' && r.host)
    } catch (err) {
      log.warn(`failed to load ${path}: ${(err as Error).message}`)
    }
  }

  let writeQueued: ReturnType<typeof setTimeout> | undefined
  function persist(): void {
    if (writeQueued) clearTimeout(writeQueued)
    writeQueued = setTimeout(() => {
      try {
        mkdirSync(dirname(path), { recursive: true })
        const tmp = `${path}.tmp`
        writeFileSync(tmp, JSON.stringify({ remotes }, null, 2), { mode: 0o600 })
        renameSync(tmp, path)
      } catch (err) {
        log.warn(`persist failed: ${(err as Error).message}`)
      }
    }, 100)
    writeQueued.unref?.()
  }

  function normalize(r: RemoteHost): RemoteHost {
    return {
      ...r,
      name: r.name?.trim() || undefined,
      port: r.port > 0 ? r.port : 22,
      remotePort: r.remotePort > 0 ? r.remotePort : 4199,
      user: r.user?.trim() || undefined,
      enabled: r.enabled ?? true,
    }
  }

  load()

  return {
    list: () => remotes.map((r) => ({ ...r })),
    get: (id) => {
      const r = remotes.find((x) => x.id === id)
      return r ? { ...r } : undefined
    },
    upsert(remote) {
      const id = remote.id?.trim() || `remote-${Date.now().toString(36)}`
      const existing = remotes.find((x) => x.id === id)
      if (existing) {
        const cleared = remote.serverPassword === ''
        Object.assign(existing, remote, { id })
        if (cleared) existing.serverPassword = undefined
        else existing.serverPassword ??= generateServerPassword()
        Object.assign(existing, normalize(existing))
        persist()
        return { ...existing }
      }
      const fresh = normalize({
        id,
        host: remote.host,
        port: remote.port ?? 22,
        user: remote.user,
        remotePort: remote.remotePort ?? 4199,
        name: remote.name,
        serverPassword: remote.serverPassword || generateServerPassword(),
        enabled: remote.enabled ?? true,
      })
      remotes.push(fresh)
      persist()
      return { ...fresh }
    },
    update(id, patch) {
      const r = remotes.find((x) => x.id === id)
      if (!r) return undefined
      Object.assign(r, patch)
      if (patch.serverPassword === '') r.serverPassword = undefined
      Object.assign(r, normalize(r))
      persist()
      return { ...r }
    },
    remove(id) {
      const idx = remotes.findIndex((x) => x.id === id)
      if (idx === -1) return false
      remotes.splice(idx, 1)
      persist()
      return true
    },
  }
}

/** Default on-disk location: ~/.ocrc/remotes.json */
export function remotesPath(home: string): string {
  return join(home, 'remotes.json')
}
