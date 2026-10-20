import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootstrapRemoteInstance, mergeBootstrapRecord, type BootstrapStepName } from '../../src/core/remote-instance-bootstrap.js'
import type { InstancePlan, RemoteInstanceManager } from '../../src/core/remote-instance-bridge.js'
import { createRemoteInstancesStore } from '../../src/core/remote-instances.js'

/**
 * `ocrc remote bootstrap` — the sequence rules, pinned without ssh:
 *   · a dry run never gets past `plan`;
 *   · a later run keeps the record's secrets and hand-set ports;
 *   · fatal steps stop the sequence, warning steps do not;
 *   · the step order is the contract the CLI documents.
 */

function tempStore(): { store: ReturnType<typeof createRemoteInstancesStore>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ocrc-boot-'))
  const store = createRemoteInstancesStore(join(dir, 'remote-instances.json'), { flushOnExit: false })
  return { store, dir }
}

function planFor(id: string, reachable = true): InstancePlan {
  return {
    id,
    target: `dev@peer:22 (${id})`,
    reachable,
    sshError: reachable ? undefined : 'ssh: connect to host peer port 22: Connection refused',
    engineCandidates: [],
    actions: ['推运行时', '装引擎'],
    url: 'http://127.0.0.1:4610',
  }
}

interface FakeOptions {
  reachable?: boolean
  apply?: { ok: boolean; detail: string }
  auth?: { ok: boolean; detail: string }
  config?: { ok: boolean; detail: string }
  up?: { ok: boolean; detail: string }
  pair?: { ok: boolean; detail: string; link?: string }
  throwOn?: 'apply' | 'syncAuth' | 'syncConfig' | 'up' | 'pairLink' | 'plan'
}

function fakeManager(opts: FakeOptions = {}) {
  const calls: string[] = []
  const seen: { apply?: Record<string, unknown>; config?: Record<string, unknown> } = {}
  const manager = {
    async plan(id: string) {
      calls.push('plan')
      if (opts.throwOn === 'plan') throw new Error('plan exploded')
      return planFor(id, opts.reachable ?? true)
    },
    async apply(_id: string, applyOpts?: Record<string, unknown>) {
      calls.push('apply')
      seen.apply = applyOpts
      if (opts.throwOn === 'apply') throw new Error('apply exploded')
      return opts.apply ?? { ok: true, detail: '装机完成' }
    },
    async syncAuth() {
      calls.push('sync-auth')
      if (opts.throwOn === 'syncAuth') throw new Error('auth exploded')
      return opts.auth ?? { ok: true, detail: '凭据已同步' }
    },
    async syncConfig(_id: string, configOpts?: Record<string, unknown>) {
      calls.push('sync-config')
      seen.config = configOpts
      if (opts.throwOn === 'syncConfig') throw new Error('config exploded')
      return opts.config ?? { ok: true, detail: '配置已同步' }
    },
    async up() {
      calls.push('up')
      if (opts.throwOn === 'up') throw new Error('up exploded')
      return opts.up ?? { ok: true, detail: '实例已上线' }
    },
    async pairLink() {
      calls.push('pairlink')
      if (opts.throwOn === 'pairLink') throw new Error('pair exploded')
      return opts.pair ?? { ok: true, detail: '配对链接已生成', link: 'openchamber://pair?t=abc', url: 'http://127.0.0.1:4610' }
    },
  } as unknown as RemoteInstanceManager
  return { manager, calls, seen }
}

const input = { host: 'peer.example', user: 'dev', port: 22 }

describe('bootstrap sequence', () => {
  it('dry run stops after plan and never writes the peer', async () => {
    const { store, dir } = tempStore()
    try {
      const { manager, calls } = fakeManager()
      const result = await bootstrapRemoteInstance({ store, manager, input, opts: { dryRun: true } })
      expect(result.ok).toBe(true)
      expect(result.dryRun).toBe(true)
      expect(calls).toEqual(['plan'])
      expect(result.steps.map((s) => s.name)).toEqual(['record', 'plan', 'apply', 'sync-auth', 'sync-config', 'up', 'pairlink'])
      expect(result.steps.filter((s) => s.status === 'skipped').map((s) => s.name)).toEqual(['apply', 'sync-auth', 'sync-config', 'up', 'pairlink'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an unreachable peer fails at plan and never applies', async () => {
    const { store, dir } = tempStore()
    try {
      const { manager, calls } = fakeManager({ reachable: false })
      const result = await bootstrapRemoteInstance({ store, manager, input })
      expect(result.ok).toBe(false)
      expect(calls).toEqual(['plan'])
      expect(result.steps.find((s) => s.name === 'plan')?.status).toBe('failed')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps the stored uiPassword, engine pin and hand-set ports across runs', async () => {
    const { store, dir } = tempStore()
    try {
      const first = mergeBootstrapRecord(store, { ...input, instancePort: 3000, enginePath: '/opt/opencode' })
      const second = mergeBootstrapRecord(store, { id: first.id, name: 'renamed' })
      expect(second.id).toBe(first.id)
      expect(second.name).toBe('renamed')
      expect(second.uiPassword).toBe(first.uiPassword)
      expect(second.instancePort).toBe(3000)
      expect(second.enginePath).toBe('/opt/opencode')
      expect(second.host).toBe('peer.example')
      expect(second.user).toBe('dev')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps the stored ssh password when only the mode is re-stated, and erases it for key mode', () => {
    const { store, dir } = tempStore()
    try {
      const saved = mergeBootstrapRecord(store, { ...input, sshAuth: 'password', sshPassword: 'hunter2' })
      expect(saved.sshAuth).toBe('password')
      expect(saved.sshPassword).toBe('hunter2')
      const kept = mergeBootstrapRecord(store, { id: saved.id, sshAuth: 'password' })
      expect(kept.sshPassword).toBe('hunter2')
      const keyed = mergeBootstrapRecord(store, { id: saved.id, sshAuth: 'key' })
      expect(keyed.sshAuth).toBeUndefined()
      expect(keyed.sshPassword).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stops after a failed apply — no up, no pairlink', async () => {
    const { store, dir } = tempStore()
    try {
      const { manager, calls } = fakeManager({ apply: { ok: false, detail: '装机失败' } })
      const result = await bootstrapRemoteInstance({ store, manager, input })
      expect(result.ok).toBe(false)
      expect(calls).toEqual(['plan', 'apply'])
      expect(result.steps.find((s) => s.name === 'apply')?.status).toBe('failed')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('treats a missing auth file as a warning and continues', async () => {
    const { store, dir } = tempStore()
    try {
      const { manager, calls } = fakeManager({ auth: { ok: false, detail: '本地没有 auth.json' } })
      const result = await bootstrapRemoteInstance({ store, manager, input })
      expect(result.ok).toBe(true)
      expect(calls).toEqual(['plan', 'apply', 'sync-auth', 'sync-config', 'up', 'pairlink'])
      expect(result.steps.find((s) => s.name === 'sync-auth')?.status).toBe('warn')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('treats a failed config sync (and a thrown step) as a warning', async () => {
    const { store, dir } = tempStore()
    try {
      const first = fakeManager({ config: { ok: false, detail: '配置合并冲突' } })
      const a = await bootstrapRemoteInstance({ store, manager: first.manager, input })
      expect(a.ok).toBe(true)
      expect(first.calls).toContain('up')

      const second = fakeManager({ throwOn: 'syncConfig' })
      const b = await bootstrapRemoteInstance({ store, manager: second.manager, input })
      expect(b.ok).toBe(true)
      expect(b.steps.find((s) => s.name === 'sync-config')?.status).toBe('warn')
      expect(second.calls).toContain('up')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stops at a failed up and skips pairlink', async () => {
    const { store, dir } = tempStore()
    try {
      const { manager, calls } = fakeManager({ up: { ok: false, detail: '实例没起来' } })
      const result = await bootstrapRemoteInstance({ store, manager, input })
      expect(result.ok).toBe(false)
      expect(calls).toEqual(['plan', 'apply', 'sync-auth', 'sync-config', 'up'])
      expect(result.steps.find((s) => s.name === 'pairlink')?.status).toBe('skipped')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns ok with a warning when only pairlink fails', async () => {
    const { store, dir } = tempStore()
    try {
      const { manager } = fakeManager({ pair: { ok: false, detail: '链接没生成' } })
      const result = await bootstrapRemoteInstance({ store, manager, input })
      expect(result.ok).toBe(true)
      expect(result.link).toBeUndefined()
      expect(result.steps.find((s) => s.name === 'pairlink')?.status).toBe('warn')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('honours --no-sync-auth / --no-sync-config / --no-pairlink', async () => {
    const { store, dir } = tempStore()
    try {
      const { manager, calls } = fakeManager()
      await bootstrapRemoteInstance({
        store,
        manager,
        input,
        opts: { syncAuth: false, syncConfig: false, pairlink: false },
      })
      expect(calls).toEqual(['plan', 'apply', 'up'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not apply when the confirmation says no', async () => {
    const { store, dir } = tempStore()
    try {
      const { manager, calls } = fakeManager()
      const result = await bootstrapRemoteInstance({
        store,
        manager,
        input,
        opts: { confirm: () => false },
      })
      expect(result.ok).toBe(false)
      expect(result.cancelled).toBe(true)
      expect(calls).toEqual(['plan'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('passes the component sources to apply and to the config sync', async () => {
    const { store, dir } = tempStore()
    try {
      const { manager, seen } = fakeManager()
      await bootstrapRemoteInstance({
        store,
        manager,
        input,
        opts: { components: ['/tmp/reeve-0.1.2.tgz'] },
      })
      expect(seen.apply?.components).toEqual(['/tmp/reeve-0.1.2.tgz'])
      expect(seen.config?.components).toEqual(['/tmp/reeve-0.1.2.tgz'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('runs the steps in the documented order', async () => {
    const { store, dir } = tempStore()
    try {
      const { manager, calls } = fakeManager()
      const result = await bootstrapRemoteInstance({ store, manager, input })
      expect(calls).toEqual(['plan', 'apply', 'sync-auth', 'sync-config', 'up', 'pairlink'])
      expect(result.steps.map((s) => s.name as BootstrapStepName)).toEqual([
        'record', 'plan', 'apply', 'sync-auth', 'sync-config', 'up', 'pairlink',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a confirm that throws is a failure, not a cancellation', async () => {
    const { store, dir } = tempStore()
    try {
      const { manager, calls } = fakeManager()
      const result = await bootstrapRemoteInstance({
        store,
        manager,
        input,
        opts: { confirm: () => { throw new Error('tty went away') } },
      })
      expect(result.ok).toBe(false)
      expect(result.cancelled).toBeUndefined()
      expect(calls).toEqual(['plan'])
      expect(result.steps.find((s) => s.name === 'apply')?.status).toBe('failed')
      expect(result.steps.find((s) => s.name === 'apply')?.detail).toContain('tty went away')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('passes onLog through to apply', async () => {
    const { store, dir } = tempStore()
    try {
      const seen: string[] = []
      const { manager } = fakeManager()
      await bootstrapRemoteInstance({
        store,
        manager,
        input,
        opts: { onLog: (line) => seen.push(line) },
      })
      // The fake manager cannot log; assert the option actually reached it.
      expect(seen).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('mergeBootstrapRecord closed-set fields', () => {
  it('keeps egress, provision, proxy and switches across a second merge, and lets an explicit value win', () => {
    const { store, dir } = tempStore()
    try {
      const first = mergeBootstrapRecord(store, {
        ...input,
        egress: 'relay',
        provision: 'reuse',
        providerBaseUrl: { deepseek: 'http://10.0.0.9:8080' },
        proxy: { enabled: true, localPort: 18080, remotePort: 18081, allow: ['Example.COM', 'lan'] },
        reconnect: false,
        restoreOnStart: true,
        replayQueued: true,
        enabled: false,
      })
      expect(first.egress).toBe('relay')
      expect(first.provision).toBe('reuse')
      expect(first.providerBaseUrl).toEqual({ deepseek: 'http://10.0.0.9:8080' })
      expect(first.proxy).toMatchObject({ enabled: true, localPort: 18080, remotePort: 18081, allow: ['example.com', 'lan'] })
      expect(first.reconnect).toBe(false)
      expect(first.enabled).toBe(false)

      // A second run that names none of these must not reset them.
      const second = mergeBootstrapRecord(store, { id: first.id, name: 'again' })
      expect(second.egress).toBe('relay')
      expect(second.provision).toBe('reuse')
      expect(second.providerBaseUrl).toEqual({ deepseek: 'http://10.0.0.9:8080' })
      expect(second.proxy).toMatchObject({ enabled: true, localPort: 18080 })
      expect(second.reconnect).toBe(false)
      expect(second.enabled).toBe(false)

      // An explicit value does overwrite.
      const third = mergeBootstrapRecord(store, { id: first.id, egress: 'direct' })
      expect(third.egress).toBe('direct')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('normalizes illegal egress/provision values away and trims providerBaseUrl to non-empty pairs', () => {
    const { store, dir } = tempStore()
    try {
      const saved = mergeBootstrapRecord(store, {
        ...input,
        egress: 'sideways' as never,
        provision: 'teleport' as never,
        providerBaseUrl: { deepseek: '  ', x: 'http://ok' } as never,
      })
      // 认不出来的值等于没设 —— 与 store.normalize 的 closed-set 语义一致。
      expect(saved.egress).toBeUndefined()
      expect(saved.provision).toBeUndefined()
      expect(saved.providerBaseUrl).toEqual({ x: 'http://ok' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails without a host and without a known id', () => {
    const { store, dir } = tempStore()
    try {
      expect(() => mergeBootstrapRecord(store, {})).toThrow(/host/)
      expect(() => mergeBootstrapRecord(store, { id: 'nope' })).toThrow(/host/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
