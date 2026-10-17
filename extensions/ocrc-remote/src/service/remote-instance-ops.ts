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
import {
  buildDesktopHandoff, redactInstance,
  type InstanceStatus, type RemoteInstance, type RemoteInstanceManager, type RemoteInstancesStore,
} from '../../../../src/remote-instance/index.js'

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
  | { op: 'url'; id: string }
  | { op: 'connect'; id: string }
  | { op: 'delete'; id: string }
  | { op: 'job'; jobId: string }

export interface OpsReply {
  status: number
  body: unknown
}

/**
 * The auth mode is a closed set. A typo (`"Password"`, `"passwd"`) would
 * otherwise be stored as-is and read back as `undefined` by `sshAuthArgs`, i.e.
 * silently **key** mode — the user would see a "Permission denied" for a
 * password peer and have nothing pointing at the cause.
 */
export function validateSshAuth(payload: Partial<RemoteInstance> | undefined): string | undefined {
  const mode = payload?.sshAuth
  if (mode === undefined || mode === null || mode === 'key' || mode === 'password') return undefined
  return `invalid sshAuth: ${String(mode)}`
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
          const authError = validateSshAuth(body)
          if (authError) return { status: 400, body: { error: authError } }
          const saved = store.upsert({ ...body, host: body.host })
          return { status: 200, body: { instance: { ...redactInstance(saved), status: statusFor(saved.id) ?? null } } }
        }

        case 'patch': {
          const authError = validateSshAuth(op.payload)
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

        default:
          return { status: 400, body: { error: 'unknown op' } }
      }
    },

    dispose() {
      jobs.clear()
    },
  }
}
