/**
 * Remote-instance operations for the extension service.
 *
 * The service is the only long-lived OCRC process on the control side, so it
 * owns the manager directly (no :4099 hop). Long operations (`plan`, `apply`,
 * `up`, `down`, `probe`) return a job id: openchamber's host proxy gives each
 * service request 20 seconds, while provisioning easily takes minutes. The
 * panel polls `{op:'job', jobId}` and gets the final result.
 */
import { randomUUID } from 'node:crypto'
import net from 'node:net'
import {
  DEFAULT_APP_VERSION, DEFAULT_ENGINE_PIN, DEFAULT_INSTANCE_PORT, DEFAULT_LOCAL_PORT, NODE_RUNTIME,
  buildDesktopHandoff, redactInstance,
  type InstanceStatus, type RemoteInstance, type RemoteInstanceManager, type RemoteInstancesStore,
} from '../../../../src/remote-instance/index.js'

/**
 * The first control-side port nothing is listening on, starting at the default.
 * A record whose local port is already taken fails at `up` with an
 * `ExitOnForwardFailure` message; suggesting a free one up front is cheaper than
 * that error. Bounded to a small window so a machine with many busy ports still
 * answers instead of scanning 65k.
 */
export async function firstFreeLocalPort(from = DEFAULT_LOCAL_PORT, window = 40): Promise<number> {
  for (let port = from; port < from + window; port += 1) {
    if (!(await isPortListening(port))) return port
  }
  return from
}

function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1')
    const done = (listening: boolean) => {
      socket.destroy()
      resolve(listening)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(700, () => done(false))
  })
}

export type RemoteInstanceOp =
  | { op: 'list' }
  | { op: 'add'; payload: Partial<RemoteInstance> & { host: string } }
  | { op: 'patch'; id: string; payload: Partial<RemoteInstance> }
  | { op: 'plan'; id: string }
  | { op: 'apply'; id: string; payload?: { confirm?: boolean; force?: boolean } }
  | { op: 'up'; id: string }
  | { op: 'down'; id: string }
  | { op: 'probe'; id: string }
  | { op: 'status'; id: string }
  | { op: 'logs'; id: string; tail?: number }
  /** D3: the peer-side logs (our serve redirect + the instance's own). A job: two
   *  ssh round trips on a slow peer. */
  | { op: 'peerlog'; id: string; lines?: number }
  | { op: 'url'; id: string }
  | { op: 'connect'; id: string }
  /** Suggest ports for a **new** record: the control-side local port is probed
   *  for real (we can see it), and the peer's instance port gets a default plus
   *  whatever the peer itself says about that port (see `plan`). */
  | { op: 'defaults' }
  /** D4: the instance's UI password, so the panel can show/copy it for the
   *  browser-open path. Same trust domain as `ocrc remote connect`, which has
   *  always printed it. */
  | { op: 'uipassword'; id: string }
  /** C1/C5: local-vs-peer config diff (both directions) + what one sync would do. */
  | { op: 'configdiff'; id: string }
  /** C1–C4: push the whitelisted config. A job: two ssh round trips plus a tar
   *  stream, and the peer may be slow. `deletes` are peer-only files the user
   *  explicitly chose — never implied by the diff. */
  | { op: 'syncconfig'; id: string; payload?: { deletes?: string[]; keyDeletes?: string[]; dryRun?: boolean } }
  /** C3: copy provider credentials (`auth.json`) — stdin, 0600, never echoed. */
  | { op: 'syncauth'; id: string }
  /** Ask the peer's own openchamber for a pairing link. A job, not a plain
   *  request: it ensures the `-L` for the link's URL, re-establishes the egress
   *  leg and starts monitoring, each of which is an ssh round trip — together
   *  they outlive the host proxy's 20 s budget. */
  | { op: 'pairlink'; id: string }
  | { op: 'delete'; id: string }
  | { op: 'job'; jobId: string }

export interface OpsReply {
  status: number
  body: unknown
}

/**
 * The closed-set fields are checked here, not in the store. A typo
 * (`sshAuth: "Password"`, `egress: "directt"`) would otherwise be stored as-is
 * and read back as `undefined` by the arg builders, i.e. silently **key** mode
 * or **auto** policy — the user would see a "Permission denied" or an
 * unexpected detour and have nothing pointing at the cause.
 */
export function validateInstancePayload(payload: Partial<RemoteInstance> | undefined): string | undefined {
  const auth = payload?.sshAuth
  if (auth !== undefined && auth !== null && auth !== 'key' && auth !== 'password') {
    return `invalid sshAuth: ${String(auth)}`
  }
  const egress = payload?.egress
  if (egress !== undefined && egress !== null && egress !== 'auto' && egress !== 'relay' && egress !== 'direct') {
    return `invalid egress: ${String(egress)}`
  }
  const provision = payload?.provision
  if (provision !== undefined && provision !== null && provision !== 'push' && provision !== 'reuse') {
    return `invalid provision: ${String(provision)}`
  }
  return undefined
}

interface Job {
  state: 'running' | 'done' | 'error'
  result?: unknown
  error?: string
  startedAt: number
}

export interface RemoteInstanceOps {
  handle(op: RemoteInstanceOp): Promise<OpsReply>
  dispose(): void
}

const withStatus = (manager: RemoteInstanceManager) => (i: RemoteInstance) => ({
  ...redactInstance(i),
  status: manager.status(i.id) ?? null,
})

export function createRemoteInstanceOps({
  store,
  manager,
  jobTtlMs = 10 * 60_000,
}: {
  store: RemoteInstancesStore
  manager: RemoteInstanceManager
  jobTtlMs?: number
}): RemoteInstanceOps {
  const jobs = new Map<string, Job>()

  const prune = () => {
    const cutoff = Date.now() - jobTtlMs
    for (const [id, job] of jobs) {
      if (job.state !== 'running' && job.startedAt < cutoff) jobs.delete(id)
    }
    // Hard cap: a stuck panel must not grow this map without bound.
    if (jobs.size > 100) {
      for (const id of jobs.keys()) {
        if (jobs.size <= 100) break
        if (jobs.get(id)?.state !== 'running') jobs.delete(id)
      }
    }
  }

  const start = (fn: () => Promise<unknown>): OpsReply => {
    prune()
    const jobId = randomUUID()
    const job: Job = { state: 'running', startedAt: Date.now() }
    jobs.set(jobId, job)
    void fn()
      .then((result) => {
        job.state = 'done'
        job.result = result
      })
      .catch((err: unknown) => {
        job.state = 'error'
        job.error = (err as Error).message
      })
    return { status: 202, body: { jobId } }
  }

  const statusFor = (id: string): InstanceStatus | undefined => manager.status(id)

  return {
    async handle(op) {
      switch (op.op) {
        case 'list':
          return { status: 200, body: { instances: store.list().map(withStatus(manager)) } }

        case 'add': {
          const body = op.payload
          if (!body?.host || typeof body.host !== 'string') return { status: 400, body: { error: 'host required' } }
          for (const [key, value] of [['port', body.port], ['instancePort', body.instancePort], ['localPort', body.localPort]] as const) {
            if (value != null && (!Number.isFinite(value) || value < 1 || value > 65535)) {
              return { status: 400, body: { error: `invalid ${key}` } }
            }
          }
          const authError = validateInstancePayload(body)
          if (authError) return { status: 400, body: { error: authError } }
          const saved = store.upsert({ ...body, host: body.host })
          return { status: 200, body: { instance: { ...redactInstance(saved), status: statusFor(saved.id) ?? null } } }
        }

        case 'patch': {
          const authError = validateInstancePayload(op.payload)
          if (authError) return { status: 400, body: { error: authError } }
          const updated = store.update(op.id, op.payload)
          if (!updated) return { status: 404, body: { error: 'not found' } }
          return { status: 200, body: { instance: { ...redactInstance(updated), status: statusFor(updated.id) ?? null } } }
        }

        case 'delete': {
          if (!store.get(op.id)) return { status: 404, body: { error: 'not found' } }
          await manager.down(op.id).catch(() => { /* stop failures must not block deleting the record */ })
          store.remove(op.id)
          return { status: 200, body: { ok: true } }
        }

        case 'plan': {
          if (!store.get(op.id)) return { status: 404, body: { error: 'not found' } }
          return start(() => manager.plan(op.id))
        }

        case 'apply': {
          if (!store.get(op.id)) return { status: 404, body: { error: 'not found' } }
          if (op.payload?.confirm !== true) {
            return { status: 409, body: { error: 'confirm:true required', dryRun: true } }
          }
          return start(() => manager.apply(op.id, { force: op.payload?.force === true }))
        }

        case 'up':
          if (!store.get(op.id)) return { status: 404, body: { error: 'not found' } }
          return start(() => manager.up(op.id))

        case 'down':
          if (!store.get(op.id)) return { status: 404, body: { error: 'not found' } }
          return start(() => manager.down(op.id))

        case 'probe':
          if (!store.get(op.id)) return { status: 404, body: { error: 'not found' } }
          return start(() => manager.probe(op.id))

        case 'status': {
          if (!store.get(op.id)) return { status: 404, body: { error: 'not found' } }
          const status = statusFor(op.id)
          if (!status) return { status: 404, body: { error: 'not found' } }
          // In-memory state is not enough: the desktop shell owns the UI tunnel
          // in this deployment, so only a live probe can say "online".
          const live = await manager.probe(op.id)
          if (live.online) {
            return {
              status: 200,
              body: {
                status: {
                  ...status,
                  state: 'online',
                  detail: live.version ? `openchamber ${live.version}（实测）` : (live.detail ?? status.detail),
                },
              },
            }
          }
          return {
            status: 200,
            body: {
              status: {
                ...status,
                state: status.state === 'online' ? 'offline' : status.state,
                detail: live.detail ?? status.detail,
              },
            },
          }
        }

        case 'logs': {
          if (!store.get(op.id)) return { status: 404, body: { error: 'not found' } }
          const lines = manager.logs(op.id)
          const tail = Number(op.tail ?? 100)
          return { status: 200, body: { lines: Number.isFinite(tail) && tail > 0 ? lines.slice(-tail) : lines } }
        }

        case 'peerlog': {
          if (!store.get(op.id)) return { status: 404, body: { error: 'not found' } }
          return start(() => manager.peerLogs(op.id, { lines: op.lines }))
        }

        case 'url': {
          const instance = store.get(op.id)
          if (!instance) return { status: 404, body: { error: 'not found' } }
          return {
            status: 200,
            body: { url: `http://127.0.0.1:${instance.localPort}`, online: manager.status(op.id)?.state === 'online' },
          }
        }

        case 'connect': {
          const instance = store.get(op.id)
          if (!instance) return { status: 404, body: { error: 'not found' } }
          const { uiPassword, lines, ...handoff } = buildDesktopHandoff(instance, manager.status(instance.id) ?? undefined)
          return {
            status: 200,
            body: {
              handoff: {
                ...handoff,
                hasUiPassword: !!uiPassword,
                lines: lines.map((l) => l.replace(/^密码 : .*$/, '密码 : （见本机 ocrc remote connect）')),
              },
            },
          }
        }

        case 'pairlink': {
          if (!store.get(op.id)) return { status: 404, body: { error: 'not found' } }
          return start(() => manager.pairLink(op.id))
        }

        case 'defaults': {
          const localPort = await firstFreeLocalPort()
          return {
            status: 200,
            body: {
              localPort,
              instancePort: DEFAULT_INSTANCE_PORT,
              appVersion: DEFAULT_APP_VERSION,
              enginePin: DEFAULT_ENGINE_PIN,
              nodeRuntime: NODE_RUNTIME.version,
              bind: '127.0.0.1',
              // Two records must not share the control-side forward port, so the
              // suggestion also avoids what the store already claims.
              taken: store.list().map((i) => i.localPort),
            },
          }
        }

        case 'uipassword': {
          const instance = store.get(op.id)
          if (!instance) return { status: 404, body: { error: 'not found' } }
          if (!instance.uiPassword) return { status: 404, body: { error: '这个档案没有 UI 密码' } }
          return { status: 200, body: { uiPassword: instance.uiPassword, url: `http://127.0.0.1:${instance.localPort}` } }
        }

        case 'configdiff': {
          if (!store.get(op.id)) return { status: 404, body: { error: 'not found' } }
          return start(() => manager.configDiff(op.id))
        }

        case 'syncconfig': {
          if (!store.get(op.id)) return { status: 404, body: { error: 'not found' } }
          for (const field of ['deletes', 'keyDeletes'] as const) {
            const value = op.payload?.[field]
            if (value !== undefined && (!Array.isArray(value) || value.some((v) => typeof v !== 'string'))) {
              return { status: 400, body: { error: `${field} must be a string[]` } }
            }
          }
          return start(() => manager.syncConfig(op.id, {
            deletes: op.payload?.deletes,
            keyDeletes: op.payload?.keyDeletes,
            dryRun: op.payload?.dryRun === true,
          }))
        }

        case 'syncauth': {
          if (!store.get(op.id)) return { status: 404, body: { error: 'not found' } }
          return start(() => manager.syncAuth(op.id))
        }

        case 'job': {
          const job = jobs.get(op.jobId)
          if (!job) return { status: 404, body: { error: 'not found' } }
          return {
            status: 200,
            body: {
              job: { state: job.state, result: job.result, error: job.error, startedAt: job.startedAt },
            },
          }
        }

        default: {
          // Compile-time exhaustiveness: every union member above has a case, so
          // `op` narrows to `never` here. Without this, a new op would silently
          // answer 400 and the panel would show "unknown op" for a feature that
          // looks implemented. The runtime test walks the same list.
          const exhaustive: never = op
          return { status: 400, body: { error: `unknown op: ${JSON.stringify(exhaustive)}` } }
        }
      }
    },

    dispose() {
      jobs.clear()
    },
  }
}
