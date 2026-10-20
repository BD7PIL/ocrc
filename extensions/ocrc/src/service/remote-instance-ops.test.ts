import { describe, it, expect, vi } from 'vitest'
import type { RemoteInstance, RemoteInstanceManager, RemoteInstancesStore } from '../../../../src/remote-instance/index.js'
import { createRemoteInstanceOps, type RemoteInstanceOp } from './remote-instance-ops.js'

function makeStore(initial: RemoteInstance[] = []): RemoteInstancesStore {
  let items = initial.map((i) => ({ ...i }))
  return {
    list: () => items.map((i) => ({ ...i })),
    get: (id) => {
      const i = items.find((x) => x.id === id)
      return i ? { ...i } : undefined
    },
    upsert: (input) => {
      const id = input.id?.trim() || `${input.user ? `${input.user}@` : ''}${input.host}`
      const rec = {
        port: 22, instancePort: 2610, localPort: 4610, appVersion: '2.3.3',
        enabled: true, uiPassword: 'pw-test', ...input, id,
      } as RemoteInstance
      const existing = items.find((x) => x.id === id)
      if (existing) Object.assign(existing, rec)
      else items.push(rec)
      return { ...rec }
    },
    update: (id, patch) => {
      const i = items.find((x) => x.id === id)
      if (!i) return undefined
      Object.assign(i, patch)
      return { ...i }
    },
    remove: (id) => {
      const before = items.length
      items = items.filter((x) => x.id !== id)
      return items.length < before
    },
    reload: () => {},
    flush: () => {},
  }
}

function makeManager(): RemoteInstanceManager {
  return {
    plan: vi.fn(async (id: string) => ({ id, target: 'h:22', reachable: true, engineCandidates: [], actions: ['装机'], url: 'http://127.0.0.1:4610' })),
    apply: vi.fn(async () => ({ ok: true, detail: '装机完成' })),
    upgrade: vi.fn(async () => ({ ok: true, changed: true, from: '2.2.0', to: '2.3.3', detail: '升级完成' })),
    up: vi.fn(async () => ({ ok: true, detail: 'online' })),
    down: vi.fn(async () => ({ ok: true, detail: '已停' })),
    probe: vi.fn(async () => ({ online: true, version: '2.3.3' })),
    pairLink: vi.fn(async () => ({
      ok: true, detail: '配对链接已生成', link: 'openchamber://connect?v=2&p=abc', expiresAt: '2026-10-17T12:00:00Z',
    })),
    configDiff: vi.fn(async () => ({
      localDir: '/home/u/.config/opencode', add: ['skill/a.md'], change: [], same: [], peerOnly: ['agent/old.md'],
      unknown: [], auth: { local: true, peer: false },
      plan: { basename: 'opencode.json', configChanged: true, files: ['opencode.json', 'skill/a.md'], deletes: [], droppedManagedKeys: [], secretsReplaced: [], baseUrlRewrites: [], notes: [] },
    })),
    syncConfig: vi.fn(async () => ({ ok: true, detail: '同步 2 个文件' })),
    syncAuth: vi.fn(async () => ({ ok: true, detail: '凭据已同步（512 字节 → 对端 0600）' })),
    status: (id: string) => ({ id, state: 'online' as const, url: 'http://127.0.0.1:4610', tunnelOwner: 'external' as const, logTail: [] }),
    statusAll: () => [],
    logs: () => ['line 1', 'line 2'],
    peerLogs: vi.fn(async () => ({ ok: true, instance: ['serve ready'], app: ['http 200'], paths: { instance: '/home/user/.ocrc/remote/instance.log', app: '/home/user/.config/openchamber/logs/openchamber-2610.log' } })),
    ensureAll: vi.fn(),
    dispose: vi.fn(),
  } as unknown as RemoteInstanceManager
}

const instance = (over: Partial<RemoteInstance> = {}): RemoteInstance => ({
  id: 'user@h', host: 'h', port: 22, instancePort: 2610, localPort: 4610,
  appVersion: '2.3.3', enabled: true, uiPassword: 'pw-secret', ...over,
} as RemoteInstance)

async function waitJob(ops: ReturnType<typeof createRemoteInstanceOps>, jobId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 100; i++) {
    const reply = await ops.handle({ op: 'job', jobId })
    const job = (reply.body as { job: { state: string; result?: unknown; error?: string } }).job
    if (job.state !== 'running') return job as unknown as Record<string, unknown>
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('job did not settle')
}

describe('remote-instance ops', () => {
  it('list redacts the instance password and merges status', async () => {
    const ops = createRemoteInstanceOps({ store: makeStore([instance()]), manager: makeManager() })
    const reply = await ops.handle({ op: 'list' })
    expect(reply.status).toBe(200)
    const body = reply.body as { instances: Array<Record<string, unknown>> }
    expect(body.instances).toHaveLength(1)
    expect(body.instances[0].hasUiPassword).toBe(true)
    expect(JSON.stringify(body)).not.toMatch(/pw-secret|"uiPassword"/)
    expect(body.instances[0].status).toMatchObject({ state: 'online' })
  })

  it('add validates host and ports', async () => {
    const ops = createRemoteInstanceOps({ store: makeStore(), manager: makeManager() })
    expect((await ops.handle({ op: 'add', payload: { host: '' } })).status).toBe(400)
    expect((await ops.handle({ op: 'add', payload: { host: 'h', port: 0 } })).status).toBe(400)
    const ok = await ops.handle({ op: 'add', payload: { host: 'h' } })
    expect(ok.status).toBe(200)
    expect((ok.body as { instance: { hasUiPassword: boolean } }).instance.hasUiPassword).toBe(true)
  })

  it('rejects an auth mode outside the closed set (a typo must not read as key mode)', async () => {
    const ops = createRemoteInstanceOps({ store: makeStore([instance()]), manager: makeManager() })
    expect((await ops.handle({ op: 'add', payload: { host: 'h', sshAuth: 'Password' as never } })).status).toBe(400)
    expect((await ops.handle({ op: 'patch', id: 'user@h', payload: { sshAuth: 'passwd' as never } })).status).toBe(400)
    // The two real modes go through, and the password never comes back.
    const ok = await ops.handle({ op: 'add', payload: { host: 'h', sshAuth: 'password', sshPassword: 'peer-secret' } })
    expect(ok.status).toBe(200)
    const body = ok.body as { instance: Record<string, unknown> }
    expect(body.instance.hasSshPassword).toBe(true)
    expect(JSON.stringify(body)).not.toContain('peer-secret')
  })

  it('long ops return a job and expose the result through polling', async () => {
    const manager = makeManager()
    const ops = createRemoteInstanceOps({ store: makeStore([instance()]), manager })
    const started = await ops.handle({ op: 'plan', id: 'user@h' })
    expect(started.status).toBe(202)
    const jobId = (started.body as { jobId: string }).jobId
    const job = await waitJob(ops, jobId)
    expect(job.state).toBe('done')
    expect(job.result).toMatchObject({ reachable: true })
    expect(manager.plan).toHaveBeenCalledWith('user@h')
  })

  it('apply without confirm is a dry run; with confirm it runs as a job', async () => {
    const manager = makeManager()
    const ops = createRemoteInstanceOps({ store: makeStore([instance()]), manager })
    const gate = await ops.handle({ op: 'apply', id: 'user@h', payload: {} })
    expect(gate.status).toBe(409)
    expect(gate.body).toMatchObject({ dryRun: true })
    expect(manager.apply).not.toHaveBeenCalled()

    const started = await ops.handle({ op: 'apply', id: 'user@h', payload: { confirm: true, force: true } })
    expect(started.status).toBe(202)
    const job = await waitJob(ops, (started.body as { jobId: string }).jobId)
    expect(job.state).toBe('done')
    expect(manager.apply).toHaveBeenCalledWith('user@h', { force: true })
  })

  it('up/down/probe are jobs; delete stops and removes', async () => {
    const manager = makeManager()
    const store = makeStore([instance()])
    const ops = createRemoteInstanceOps({ store, manager })
    for (const op of ['up', 'down', 'probe'] as const) {
      const started = await ops.handle({ op, id: 'user@h' })
      expect(started.status).toBe(202)
      await waitJob(ops, (started.body as { jobId: string }).jobId)
    }
    expect(manager.up).toHaveBeenCalled()
    expect(manager.down).toHaveBeenCalled()

    const del = await ops.handle({ op: 'delete', id: 'user@h' })
    expect(del.status).toBe(200)
    expect(store.get('user@h')).toBeUndefined()
    expect(manager.down).toHaveBeenCalledWith('user@h')
  })

  it('status merges a live probe so a stale in-memory "online" never lies', async () => {
    const manager = makeManager()
    const store = makeStore([instance()])
    const ops = createRemoteInstanceOps({ store, manager })
    manager.status = () => ({ id: 'user@h', state: 'online' as const, url: 'http://127.0.0.1:4610', logTail: [] })
    manager.probe = vi.fn(async () => ({ online: false, detail: '对端实例在跑，但桌面版隧道未连接' }))
    const reply = await ops.handle({ op: 'status', id: 'user@h' })
    expect(reply.status).toBe(200)
    const status = (reply.body as { status: { state: string; detail?: string } }).status
    expect(status.state).toBe('offline')
    expect(status.detail).toContain('桌面版隧道未连接')
  })

  it('upgrade is a job and reports whether anything changed', async () => {
    const manager = makeManager()
    const ops = createRemoteInstanceOps({ store: makeStore([instance()]), manager })
    expect((await ops.handle({ op: 'upgrade', id: 'missing' })).status).toBe(404)
    const started = await ops.handle({ op: 'upgrade', id: 'user@h' })
    expect(started.status).toBe(202)
    const job = await waitJob(ops, (started.body as { jobId: string }).jobId)
    expect(job.state).toBe('done')
    expect(job.result).toMatchObject({ ok: true, changed: true, from: '2.2.0', to: '2.3.3' })
    expect(manager.upgrade).toHaveBeenCalledWith('user@h')
  })

  it('config sync ops are jobs and never imply deletions', async () => {
    const manager = makeManager()
    const ops = createRemoteInstanceOps({ store: makeStore([instance()]), manager })

    const diff = await ops.handle({ op: 'configdiff', id: 'user@h' })
    expect(diff.status).toBe(202)
    const diffJob = await waitJob(ops, (diff.body as { jobId: string }).jobId)
    expect(diffJob.state).toBe('done')
    expect((diffJob.result as { plan: { files: string[] } }).plan.files).toContain('skill/a.md')

    // No `deletes` in the payload must reach the manager as "delete nothing",
    // not as "delete everything the diff found".
    const started = await ops.handle({ op: 'syncconfig', id: 'user@h' })
    expect(started.status).toBe(202)
    await waitJob(ops, (started.body as { jobId: string }).jobId)
    expect(manager.syncConfig).toHaveBeenCalledWith('user@h', { deletes: undefined, keyDeletes: undefined, dryRun: false })

    const explicit = await ops.handle({ op: 'syncconfig', id: 'user@h', payload: { deletes: ['agent/old.md'], dryRun: true } })
    await waitJob(ops, (explicit.body as { jobId: string }).jobId)
    expect(manager.syncConfig).toHaveBeenLastCalledWith('user@h', { deletes: ['agent/old.md'], keyDeletes: undefined, dryRun: true })

    expect((await ops.handle({ op: 'syncconfig', id: 'user@h', payload: { deletes: [1] as never } })).status).toBe(400)
    expect((await ops.handle({ op: 'syncauth', id: 'missing' })).status).toBe(404)
  })

  it('unknown op and unknown ids are explicit', async () => {
    const ops = createRemoteInstanceOps({ store: makeStore(), manager: makeManager() })
    expect((await ops.handle({ op: 'nope' } as never)).status).toBe(400)
    expect((await ops.handle({ op: 'status', id: 'missing' })).status).toBe(404)
    expect((await ops.handle({ op: 'job', jobId: 'missing' })).status).toBe(404)
  })

  it('pairlink is a job that hands the link back', async () => {    const manager = makeManager()
    const ops = createRemoteInstanceOps({ store: makeStore([instance()]), manager })
    expect((await ops.handle({ op: 'pairlink', id: 'missing' })).status).toBe(404)
    const started = await ops.handle({ op: 'pairlink', id: 'user@h' })
    expect(started.status).toBe(202)
    const job = await waitJob(ops, (started.body as { jobId: string }).jobId)
    expect(job.state).toBe('done')
    expect(job.result).toMatchObject({ ok: true, link: expect.stringContaining('openchamber://connect') })
    expect(manager.pairLink).toHaveBeenCalledWith('user@h')
  })

  /**
   * The switch used to fall through to a bare 400, so an op added to the union
   * but never to the switch answered "unknown op" — a feature that looks shipped
   * and does nothing. The `never` assignment in the handler catches that at
   * compile time; this catches a case that exists but is unreachable, and keeps
   * the op list honest for the next person adding one.
   */
  it('every op in the union has a live case', async () => {
    const everyOp: Record<RemoteInstanceOp['op'], true> = {
      list: true, add: true, patch: true, plan: true, apply: true, upgrade: true, up: true, down: true, probe: true,
      status: true, logs: true, peerlog: true, url: true, defaults: true, uipassword: true,
      configdiff: true, syncconfig: true, syncauth: true, pairlink: true,
      delete: true, job: true,
    }
    const ops = createRemoteInstanceOps({ store: makeStore([instance()]), manager: makeManager() })
    for (const name of Object.keys(everyOp) as Array<RemoteInstanceOp['op']>) {
      const reply = await ops.handle({ op: name } as never)
      const body = JSON.stringify(reply.body ?? {})
      expect(`${name}: ${body}`).not.toContain('unknown op')
    }
  })
})
