import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { createRemoteInstancesStore, remoteInstancesPath } from '../../src/core/remote-instances.js'
import { registerRemoteInstance } from '../../src/transport/web/routes/remote-instance.js'
import type { RemoteInstanceManager, InstanceStatus } from '../../src/core/remote-instance-bridge.js'
import { PROXY_DEFAULTS, RECONNECT_DEFAULTS } from '../../src/core/remote-instance.js'

/**
 * 路由契约（开发测试方案 §5.2）：面板拿到的东西与错误码不能悄悄漂。
 * 这里用一个假 manager（不打真 ssh）——契约关注的是"面"，不是对端行为。
 */

const state = new Map<string, InstanceStatus>()
/** id 已建档（假 manager 靠它区分"存在的档案/没这个档案"，与真 manager 一致）。 */
const storeIds = new Set<string>()

function fakeManager(overrides: Partial<RemoteInstanceManager> = {}): RemoteInstanceManager {
  return {
    plan: vi.fn(async (id: string) => ({
      id, target: `${id}:22`, reachable: true, engineCandidates: [], actions: ['装机', '启动'], url: 'http://127.0.0.1:4610',
    })),
    apply: vi.fn(async () => ({ ok: true, detail: '运行时：已推送 v24.22.0；引擎：已推送 opencode v2.0.27；应用：已推送 2.3.3' })),
    up: vi.fn(async () => ({ ok: true, detail: 'online：http://127.0.0.1:4610' })),
    down: vi.fn(async () => ({ ok: true, detail: '已停' })),
    // /status 与 /connect 都会用一次实测覆盖内存状态（多进程下内存状态不可信）。
    probe: vi.fn(async (id: string) => (state.get(id)?.state === 'online' ? { online: true, version: '2.3.3' } : { online: false, detail: 'not listening' })),
    status: (id: string) => state.get(id) ?? (storeIds.has(id) ? { id, state: 'unknown' as const, url: 'http://127.0.0.1:4610', logTail: [] } : undefined),
    statusAll: () => [...state.values()],
    logs: () => ['$ ssh -N -L …'],
    ensureAll: vi.fn(),
    dispose: vi.fn(),
    ...overrides,
  } as RemoteInstanceManager
}

let home = ''
let app = new Hono()
let manager: RemoteInstanceManager

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ocrc-routes-'))
  state.clear()
  manager = fakeManager()
  app = new Hono()
  registerRemoteInstance(app, createRemoteInstancesStore(remoteInstancesPath(home)), manager)
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

async function post(path: string, body?: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

describe('注册与登记', () => {
  it('没有 store/manager 时整组路由不注册（host 未接线不该半活）', async () => {
    const bare = new Hono()
    registerRemoteInstance(bare, undefined, undefined)
    expect((await bare.request('/api/remote-instance')).status).toBe(404)
  })

  it('POST 建档：缺 host 400；端口非法 400；成功不回显 uiPassword', async () => {
    expect((await post('/api/remote-instance', {})).status).toBe(400)
    expect((await post('/api/remote-instance', { host: 'h', instancePort: 0 })).status).toBe(400)
    expect((await post('/api/remote-instance', { host: 'h', localPort: 70000 })).status).toBe(400)

    const ok = await post('/api/remote-instance', { host: '10.0.0.5', user: 'demo' })
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as { instance: Record<string, unknown> }
    expect(body.instance.id).toBe('demo@10.0.0.5')
    expect(body.instance.hasUiPassword).toBe(true)
    expect(body.instance.uiPassword).toBeUndefined()
    // 默认值来自单一事实来源
    expect(body.instance).toMatchObject({
      instancePort: 2610, localPort: 4610, enabled: true,
      reconnect: RECONNECT_DEFAULTS.reconnect, restoreOnStart: RECONNECT_DEFAULTS.restoreOnStart,
      replayQueued: RECONNECT_DEFAULTS.replayQueued,
    })
    expect(body.instance.proxy).toEqual(PROXY_DEFAULTS)
  })

  it('GET 列表带 status（面板一屏看完）', async () => {
    await post('/api/remote-instance', { host: 'h' })
    storeIds.add('h')
    const res = await app.request('/api/remote-instance')
    const body = (await res.json()) as { instances: Array<Record<string, unknown>> }
    expect(body.instances).toHaveLength(1)
    expect(body.instances[0].status).toBeTruthy()
    expect(body.instances[0].uiPassword).toBeUndefined()
  })

  it('PATCH 改开关（R10）落盘；不存在的 id 404', async () => {
    await post('/api/remote-instance', { host: 'h' })
    storeIds.add('h')
    const missing = await app.request('/api/remote-instance/nope', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reconnect: false }) })
    expect(missing.status).toBe(404)
    const ok = await app.request('/api/remote-instance/h', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reconnect: false, replayQueued: true }) })
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as { instance: { reconnect: boolean; replayQueued: boolean } }
    expect(body.instance.reconnect).toBe(false)
    expect(body.instance.replayQueued).toBe(true)
  })
})

describe('生命周期动作', () => {
  beforeEach(async () => { await post('/api/remote-instance', { host: 'h' }); storeIds.add('h') })

  it('plan 是只读预演（不打折扣地回传引擎门禁与动作清单）', async () => {
    const res = await post('/api/remote-instance/h/plan')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { plan: { actions: string[]; engineCandidates: unknown[] } }
    expect(body.plan.actions).toContain('装机')
    expect(Array.isArray(body.plan.engineCandidates)).toBe(true)
  })

  it('apply 需要 confirm:true（409 + dryRun，避免面板一个手滑就装机）', async () => {
    const dry = await post('/api/remote-instance/h/apply', {})
    expect(dry.status).toBe(409)
    expect(((await dry.json()) as { dryRun: boolean }).dryRun).toBe(true)
    const real = await post('/api/remote-instance/h/apply', { confirm: true })
    expect(real.status).toBe(200)
  })

  it('up/down/status/logs/url：404 与 502 按约定分流', async () => {
    expect((await post('/api/remote-instance/h/up')).status).toBe(200)
    expect((await post('/api/remote-instance/h/down')).status).toBe(200)
    expect((await app.request('/api/remote-instance/h/status')).status).toBe(200)
    expect((await app.request('/api/remote-instance/h/logs?tail=5')).status).toBe(200)
    expect((await app.request('/api/remote-instance/h/url')).status).toBe(200)

    // 一键 external 的 HTTP 面：给交接三项，但**不回密码**（secrets 只在本机终端）
    const connect = await app.request('/api/remote-instance/h/connect')
    expect(connect.status).toBe(200)
    const h = (await connect.json()) as { handoff: Record<string, unknown> }
    expect(h.handoff.url).toBe('http://127.0.0.1:4610')
    expect(h.handoff.port).toBe(4610)
    expect(h.handoff.hasUiPassword).toBe(true)
    expect(JSON.stringify(h.handoff)).not.toContain('uiPassword"')
    expect((h.handoff.lines as string[]).join('\n')).toContain('见本机 ocrc remote connect')

    expect((await post('/api/remote-instance/nope/up')).status).toBe(404)
    expect((await app.request('/api/remote-instance/nope/status')).status).toBe(404)
    expect((await app.request('/api/remote-instance/nope/connect')).status).toBe(404)
    expect((await post('/api/remote-instance/nope/plan')).status).toBe(404)

    const failing = new Hono()
    const failingStore = createRemoteInstancesStore(remoteInstancesPath(home + '-failing'))
    failingStore.upsert({ host: 'h' })
    registerRemoteInstance(failing, failingStore, fakeManager({
      up: async () => ({ ok: false, detail: '引擎不满足 v2 门禁' }),
    }))
    const res = await failing.request('/api/remote-instance/h/up', { method: 'POST' })
    expect(res.status).toBe(502)
    expect(((await res.json()) as { detail: string }).detail).toContain('v2 门禁')
  })

  it('delete：停 + 删档案；不存在 404', async () => {
    expect((await post('/api/remote-instance/h/delete')).status).toBe(200)
    expect((await app.request('/api/remote-instance')).status).toBe(200)
    expect(((await (await app.request('/api/remote-instance')).json()) as { instances: unknown[] }).instances).toHaveLength(0)
    expect((await post('/api/remote-instance/h/delete')).status).toBe(404)
  })
})
