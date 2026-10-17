import { describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import type { GuestRequestMethod, GuestRequestResult } from '@openchamber/sdk'
import { RemoteInstance } from './RemoteInstance.js'

/**
 * 远程实例页的「不撒谎」清单：
 *   · 引擎路径/版本显示的是**实例自报**的那一份（不是我请求它用的）；
 *   · 装机必须先预演、再二次确认（面板上一个手滑不能变成往对端写盘）；
 *   · ocrc host 不可达时说"不可达"，不装成空列表。
 */

type Call = { path: string; method: GuestRequestMethod; body: unknown }

function fakeRequest(handler: (call: Call) => { status: number; body: unknown }) {
  const calls: Call[] = []
  const request = async (path: string, method: GuestRequestMethod = 'GET', body?: unknown): Promise<GuestRequestResult> => {
    const call = { path, method, body }
    calls.push(call)
    const r = handler(call)
    return { status: r.status, body: JSON.stringify(r.body) }
  }
  return { request, calls }
}

const ROW = {
  id: 'demo@192.168.26.101', host: '192.168.26.101', user: 'demo', port: 22,
  instancePort: 2610, localPort: 4610, appVersion: '2.3.3', enabled: true,
  reconnect: true, restoreOnStart: true, hasUiPassword: true,
  sshAuth: 'key' as const, provision: 'push' as const, egress: 'auto' as const,
  status: {
    state: 'online', detail: 'openchamber 2.3.3（引擎 2.0.27）', url: 'http://127.0.0.1:4610',
    engine: { path: '/home/demo/.ocrc/remote/engine/opencode', version: '2.0.27' },
    runtime: 'v24.22.0', proxy: { enabled: true, localPort: 4711, remotePort: 2711 },
    egress: { mode: 'auto', relay: true, reason: '探测：对端无出网', probe: 'none', cached: true },
  },
}

const DEFAULTS = {
  localPort: 4612, instancePort: 2610, appVersion: '2.3.3', enginePin: '2.0.27',
  nodeRuntime: '24.22.0', bind: '127.0.0.1', taken: [4610],
}

const PLAN = {
  reachable: true,
  inspected: { uname: 'Linux x86_64', glibc: '2.17', home: '/home/demo' },
  runtime: 'v24.22.0', app: '2.3.3',
  engine: undefined, engineError: '目标机上没有找到 opencode 引擎——请先用「部署引擎」装一份 v2',
  engineCandidates: [{ path: '/home/demo/.local/bin/opencode', raw: '1.18.32' }],
  actions: ['部署我们 pin 的引擎 opencode 2.0.27 到 ~/.ocrc/remote/engine/opencode', '建转发'],
  url: 'http://127.0.0.1:4610',
  egress: { mode: 'auto', relay: true, reason: '探测：对端无出网', probe: 'none' },
  provision: 'push' as const,
  tier: 'legacy',
  peerPort: 'closed' as const,
}

describe('远程实例页', () => {
  it('列出实例：状态、实例自报的引擎路径/版本、中继端口都在屏上', async () => {
    const { request } = fakeRequest(() => ({ status: 200, body: { instances: [ROW] } }))
    await act(async () => { render(<RemoteInstance request={request} host={null} />) })
    await waitFor(() => expect(screen.getByText('demo@192.168.26.101')).toBeTruthy())
    expect(screen.getByText('online')).toBeTruthy()
    expect(screen.getByText('引擎 2.0.27')).toBeTruthy()
    expect(screen.getByText('/home/demo/.ocrc/remote/engine/opencode')).toBeTruthy()
    expect(screen.getByText('出口 经控制端')).toBeTruthy()
    expect(screen.getByText('中继 :4711 → :2711')).toBeTruthy()
    expect(screen.getByText('node v24.22.0')).toBeTruthy()
  })

  it('装机要两步：先预演（只读），再二次确认才 apply', async () => {
    const { request, calls } = fakeRequest((call) => {
      const body = call.body as { op?: string } | undefined
      if (body?.op === 'list') return { status: 200, body: { instances: [ROW] } }
      if (body?.op === 'plan') return { status: 200, body: PLAN }
      if (body?.op === 'apply') return { status: 200, body: { ok: true, detail: '已推送 2.3.3' } }
      return { status: 200, body: {} }
    })
    await act(async () => { render(<RemoteInstance request={request} host={null} />) })
    await waitFor(() => expect(screen.getByText('预演')).toBeTruthy())

    await act(async () => { screen.getByText('预演').click() })
    await waitFor(() => expect(screen.getByText('预演（只读，不写对端）')).toBeTruthy())
    // 预演把引擎门禁与 v1 候选摆出来
    expect(screen.getByText('1.18.32')).toBeTruthy()
    expect(screen.getAllByText(/不满足 v2 门禁|部署我们 pin 的引擎/).length).toBeGreaterThan(0)
    // 还没点确认之前，不许有 apply
    expect(calls.filter((c) => (c.body as { op?: string })?.op === 'apply')).toHaveLength(0)

    await act(async () => { screen.getByText('装机（推运行时 / 引擎 / 应用）').click() })
    await waitFor(() => expect(screen.getByText('确认装机')).toBeTruthy())
    expect(calls.filter((c) => (c.body as { op?: string })?.op === 'apply')).toHaveLength(0)

    await act(async () => { screen.getByText('确认装机').click() })
    await waitFor(() => expect(calls.some((c) => (c.body as { op?: string })?.op === 'apply')).toBe(true))
    const apply = calls.find((c) => (c.body as { op?: string })?.op === 'apply')
    expect(apply?.body).toMatchObject({ id: ROW.id, payload: { confirm: true } })
  })

  it('控制端 service 不可达时如实报，不装成空列表', async () => {
    const { request } = fakeRequest(() => ({ status: 502, body: { error: '控制端 service 不可达：connect ECONNREFUSED' } }))
    await act(async () => { render(<RemoteInstance request={request} host={null} />) })
    await waitFor(() => expect(screen.getByText(/控制端 service 不可达/)).toBeTruthy())
  })

  it('开机自动重连/自恢复开关：点击把当前值的反写回去（不猜默认）', async () => {
    const { request, calls } = fakeRequest((call) => {
      const body = call.body as { op?: string; payload?: unknown } | undefined
      if (body?.op === 'list') return { status: 200, body: { instances: [{ ...ROW, reconnect: false }] } }
      return { status: 200, body: {} }
    })
    await act(async () => { render(<RemoteInstance request={request} host={null} />) })
    await waitFor(() => expect(screen.getByText('开自动重连')).toBeTruthy())
    await act(async () => { screen.getByText('开自动重连').click() })
    await waitFor(() => expect(calls.some((c) => (c.body as { op?: string })?.op === 'patch')).toBe(true))
    const patch = calls.find((c) => (c.body as { op?: string })?.op === 'patch')
    expect((patch?.body as { payload: { reconnect: boolean } }).payload.reconnect).toBe(true)
  })

  it('出口是「决定」而不是「中继在不在」：直连的对端不显示中继徽标', async () => {
    const direct = {
      ...ROW,
      egress: 'direct' as const,
      status: { ...ROW.status, egress: { mode: 'direct', relay: false, reason: '策略：强制直连', cached: true } },
    }
    const { request } = fakeRequest(() => ({ status: 200, body: { instances: [direct] } }))
    await act(async () => { render(<RemoteInstance request={request} host={null} />) })
    await waitFor(() => expect(screen.getByText('出口 直连')).toBeTruthy())
    expect(screen.queryByText(/出网中继/)).toBeNull()
    expect(screen.getByText(/策略 direct：策略：强制直连/)).toBeTruthy()
  })

  it('生成配对链接：拿到链接后能复制、能重新生成', async () => {
    const LINK = 'openchamber://connect?v=2&p=eyJ2IjoyfQ'
    const { request, calls } = fakeRequest((call) => {
      const body = call.body as { op?: string } | undefined
      if (body?.op === 'list') return { status: 200, body: { instances: [ROW] } }
      if (body?.op === 'pairlink') {
        return { status: 200, body: { ok: true, detail: '配对链接已生成（对端实例在跑）', link: LINK, expiresAt: '2026-10-17T12:00:00Z' } }
      }
      return { status: 200, body: {} }
    })
    const clipboard: string[] = []
    const host = { openUrl: async () => {}, writeClipboard: async (t: string) => { clipboard.push(t) } } as never
    await act(async () => { render(<RemoteInstance request={request} host={host} />) })
    await waitFor(() => expect(screen.getByText('生成配对链接')).toBeTruthy())

    await act(async () => { screen.getByText('生成配对链接').click() })
    await waitFor(() => expect(screen.getByText(LINK)).toBeTruthy())
    // 上游那一步要用户点：我们只递链接，并说清它会落在哪个列表里
    expect(screen.getAllByText(/其他 OpenChamber 服务器/).length).toBeGreaterThan(0)

    await act(async () => { screen.getByText('复制链接').click() })
    await waitFor(() => expect(clipboard).toContain(LINK))

    await act(async () => { screen.getByText('重新生成').click() })
    await waitFor(() => expect(calls.filter((c) => (c.body as { op?: string })?.op === 'pairlink')).toHaveLength(2))
  })

  it('配置差异：先看差异，删除要勾选，同步前可预演', async () => {
    const DIFF = {
      localDir: '/home/u/.config/opencode',
      add: ['skill/new.md'], change: ['opencode.json'], same: [], peerOnly: ['agent/old.md'], unknown: [],
      auth: { local: true, peer: false },
      plan: {
        basename: 'opencode.json', configChanged: true, files: ['opencode.json', 'skill/new.md'], deletes: [],
        keyDeletes: { requested: [], removed: [] },
        keyDeleteCandidates: [{ collection: 'provider', key: 'acc-provider' }],
        droppedManagedKeys: ['plugin'], secretsReplaced: [], baseUrlRewrites: [], shadowed: [],
        notes: ['对端独有的 1 个文件不会被动（要删得显式勾选）'],
      },
    }
    const { request, calls } = fakeRequest((call) => {
      const body = call.body as { op?: string } | undefined
      if (body?.op === 'list') return { status: 200, body: { instances: [ROW] } }
      if (body?.op === 'configdiff') return { status: 200, body: DIFF }
      if (body?.op === 'syncconfig') return { status: 200, body: { ok: true, detail: '同步 2 个文件' } }
      return { status: 200, body: {} }
    })
    await act(async () => { render(<RemoteInstance request={request} host={null} />) })
    await act(async () => { screen.getByText('配置差异').click() })
    await waitFor(() => expect(screen.getByText(/配置差异（本地 ↔ 对端引擎/)).toBeTruthy())
    expect(screen.getByText(/\+ skill\/new\.md/)).toBeTruthy()
    expect(screen.getByText('文件 agent/old.md')).toBeTruthy()
    expect(screen.getByText('配置项 provider:acc-provider')).toBeTruthy()

    // 预演先走：dryRun=true，且没勾选任何删除 → 不删东西
    await act(async () => { screen.getByText('预演（不写对端）').click() })
    await waitFor(() => expect(calls.some((c) => (c.body as { op?: string })?.op === 'syncconfig')).toBe(true))
    let last = calls.filter((c) => (c.body as { op?: string })?.op === 'syncconfig').pop()
    expect((last?.body as { payload: { dryRun: boolean; deletes: string[]; keyDeletes: string[] } }).payload)
      .toEqual({ dryRun: true, deletes: [], keyDeletes: [] })

    // 勾一个对端独有的 provider → 同步时带上 keyDeletes
    await act(async () => { screen.getByText('配置项 provider:acc-provider').click() })
    await act(async () => { screen.getByText('同步配置').click() })
    await waitFor(() => expect(calls.filter((c) => (c.body as { op?: string })?.op === 'syncconfig')).toHaveLength(2))
    last = calls.filter((c) => (c.body as { op?: string })?.op === 'syncconfig').pop()
    expect((last?.body as { payload: { dryRun: boolean; keyDeletes: string[] } }).payload)
      .toMatchObject({ dryRun: false, keyDeletes: ['provider:acc-provider'] })
  })

  it('表单是装机输入：认证档、装机方式、出口策略都在，且派生值只显示不给控件', async () => {
    const { request, calls } = fakeRequest((call) => {
      const body = call.body as { op?: string } | undefined
      if (body?.op === 'list') return { status: 200, body: { instances: [] } }
      if (body?.op === 'defaults') return { status: 200, body: DEFAULTS }
      return { status: 200, body: {} }
    })
    await act(async () => { render(<RemoteInstance request={request} host={null} />) })
    await act(async () => { screen.getByText('添加对端').click() })
    await waitFor(() => expect(screen.getByText('添加对端')).toBeTruthy())
    // 本机端口默认来自 service 的实测空闲值，不是写死的 4610
    await waitFor(() => expect(calls.some((c) => (c.body as { op?: string })?.op === 'defaults')).toBe(true))
    expect((screen.getByDisplayValue('4612') as HTMLInputElement).value).toBe('4612')
    expect(screen.getByText(/档位：由对端 glibc 决定/)).toBeTruthy()
    expect(screen.getByText(/引擎 pin：opencode 2\.0\.27/)).toBeTruthy()
    expect(screen.getByText(/绑定：127\.0\.0\.1/)).toBeTruthy()
    // 默认密钥档：不显示密码框
    expect(screen.queryByText('SSH 密码')).toBeNull()
  })
})
