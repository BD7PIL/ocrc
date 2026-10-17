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
  status: {
    state: 'online', detail: 'openchamber 2.3.3（引擎 2.0.27）', url: 'http://127.0.0.1:4610',
    engine: { path: '/home/demo/.ocrc/remote/engine/opencode', version: '2.0.27' },
    runtime: 'v24.22.0', proxy: { enabled: true, localPort: 4711, remotePort: 2711 },
  },
}

const PLAN = {
  reachable: true,
  inspected: { uname: 'Linux x86_64', glibc: '2.17', home: '/home/demo' },
  runtime: 'v24.22.0', app: '2.3.3',
  engine: undefined, engineError: '目标机上没有找到 opencode 引擎——请先用「部署引擎」装一份 v2',
  engineCandidates: [{ path: '/home/demo/.local/bin/opencode', raw: '1.18.32' }],
  actions: ['部署我们 pin 的引擎 opencode 2.0.27 到 ~/.ocrc/remote/engine/opencode', '建转发'],
  url: 'http://127.0.0.1:4610',
}

describe('远程实例页', () => {
  it('列出实例：状态、实例自报的引擎路径/版本、中继端口都在屏上', async () => {
    const { request } = fakeRequest(() => ({ status: 200, body: { instances: [ROW] } }))
    await act(async () => { render(<RemoteInstance request={request} host={null} />) })
    await waitFor(() => expect(screen.getByText('demo@192.168.26.101')).toBeTruthy())
    expect(screen.getByText('online')).toBeTruthy()
    expect(screen.getByText('引擎 2.0.27')).toBeTruthy()
    expect(screen.getByText('/home/demo/.ocrc/remote/engine/opencode')).toBeTruthy()
    expect(screen.getByText('出网中继 :4711 → :2711')).toBeTruthy()
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
})
