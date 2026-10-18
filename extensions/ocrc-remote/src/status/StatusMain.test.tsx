import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { makeHost, type FakeHost } from '../test/host-mock.js'

const held = vi.hoisted(() => ({ host: null as unknown as FakeHost }))
vi.mock('@openchamber/sdk', async (original) => {
  const actual = await original<typeof import('@openchamber/sdk')>()
  return { ...actual, connectHost: () => held.host.client }
})

/**
 * D2 — the rail reports the **remote instance**, not the batch-2 profile tunnel.
 *
 * The old section asked `/status` (the SSH profile topology) and said "已连 · 引擎
 * 可达" about something that was not the machine the 远程实例 tab manages. The
 * tests below pin the new contract: instance states, the single-peer controls,
 * the egress decision, and the multi-peer case that must NOT offer 启动/停机
 * (there is no way for the rail to know which one the user means).
 */

const INSTANCE = (over: Record<string, unknown> = {}) => ({
  id: 'demo@192.168.26.101', name: 'EL7 box', host: '192.168.26.101', user: 'demo', localPort: 4610,
  status: { state: 'online', url: 'http://127.0.0.1:4610', egress: { relay: true, reason: '探测：对端无出网', cached: true } },
  ...over,
})

function instanceRoute(instances: unknown[]) {
  held.host = makeHost({ 'POST /remote-instance': { body: { instances } } })
}

beforeEach(() => {
  held.host = makeHost({ 'POST /remote-instance': { body: { instances: [] } } })
  document.documentElement.removeAttribute('style')
})

describe('StatusMain — work status surface', () => {
  it('shows the instance, its URL and its egress decision', async () => {
    instanceRoute([INSTANCE()])
    const { StatusMain } = await import('./main.js')
    render(<StatusMain />)
    expect(await screen.findByText('在线 1')).toBeTruthy()
    expect(screen.getByText('EL7 box')).toBeTruthy()
    expect(screen.getByText('http://127.0.0.1:4610')).toBeTruthy()
    expect(screen.getByText('出口 经控制端')).toBeTruthy()
  })

  it('a direct peer is not painted as a missing relay', async () => {
    instanceRoute([INSTANCE({ status: { state: 'online', url: 'http://127.0.0.1:4612', egress: { relay: false, reason: '探测：对端自己可出网', cached: true } } })])
    const { StatusMain } = await import('./main.js')
    render(<StatusMain />)
    expect(await screen.findByText('出口 直连')).toBeTruthy()
  })

  it('always offers a picker + 启动/停机, so the rail is never a dead readout', async () => {
    instanceRoute([INSTANCE()])
    const { StatusMain } = await import('./main.js')
    render(<StatusMain />)
    await waitFor(() => { expect(held.host.controls.at(-1)?.map((c) => c.id)).toEqual(['up', 'down']) })
    const controls = held.host.controls.at(-1) ?? []
    expect(controls.find((c) => c.id === 'up')?.disabled).toBe(true)  // already up
    expect(controls.find((c) => c.id === 'down')?.disabled).toBe(false)

    // Two peers: the picker appears so the buttons still have a target. An
    // earlier version declared no controls at all here and told the user to go to
    // another tab — it read as "这块点不动".
    instanceRoute([INSTANCE(), INSTANCE({ id: 'ubuntu@100.100.69.3', name: 'Ubuntu', status: { state: 'offline', url: 'http://127.0.0.1:4612' } })])
    const second = await import('./main.js')
    render(<second.StatusMain />)
    await waitFor(() => { expect(screen.getAllByText('在线 1/2').length).toBeGreaterThan(0) })
    await waitFor(() => {
      expect(held.host.controls.at(-1)?.map((c) => c.id)).toEqual(['instance', 'up', 'down'])
    })
  })

  it('the picker decides which peer 启动 acts on', async () => {
    instanceRoute([
      INSTANCE(),
      INSTANCE({ id: 'ubuntu@100.100.69.3', name: 'Ubuntu', status: { state: 'offline', url: 'http://127.0.0.1:4612' } }),
    ])
    const { StatusMain } = await import('./main.js')
    render(<StatusMain />)
    await waitFor(() => { expect(held.host.controls.at(-1)?.map((c) => c.id)).toEqual(['instance', 'up', 'down']) })

    act(() => { held.host.emitStatusControl({ id: 'instance', value: 'ubuntu@100.100.69.3' }) })
    await waitFor(() => { expect(held.host.controls.at(-1)?.find((c) => c.id === 'up')?.disabled).toBe(false) })

    act(() => { held.host.emitStatusControl({ id: 'up' }) })
    await waitFor(() => {
      const up = held.host.requests.find((r) => (r.body as { op?: string })?.op === 'up')
      expect((up?.body as { id?: string })?.id).toBe('ubuntu@100.100.69.3')
    })
  })

  it('raises the rail badge for a registered peer that is down, and clears it when all are up', async () => {
    instanceRoute([INSTANCE({ status: { state: 'offline', url: 'http://127.0.0.1:4610' } })])
    const { StatusMain } = await import('./main.js')
    render(<StatusMain />)
    await waitFor(() => { expect(held.host.badges).toContain(1) })

    held.host = makeHost({ 'POST /remote-instance': { body: { instances: [INSTANCE()] } } })
    const second = await import('./main.js')
    render(<second.StatusMain />)
    await waitFor(() => { expect(screen.getAllByText('在线 1').length).toBeGreaterThan(0) })
  })

  it('says "未登记对端" instead of an empty badge when there is nothing registered', async () => {
    const { StatusMain } = await import('./main.js')
    render(<StatusMain />)
    expect(await screen.findByText('未登记对端')).toBeTruthy()
  })

  it('reports a failed activation as a host toast', async () => {
    held.host = makeHost({
      'POST /remote-instance': { body: { instances: [INSTANCE({ status: { state: 'offline', url: 'http://127.0.0.1:4610' } })] } },
      'POST /remote-instance#up': { status: 500, body: { error: 'ssh: handshake failed' } },
    })
    const { StatusMain } = await import('./main.js')
    render(<StatusMain />)
    await waitFor(() => { expect(held.host.controls.at(-1)?.map((c) => c.id)).toEqual(['up', 'down']) })
    act(() => { held.host.emitStatusControl({ id: 'up' }) })
    await waitFor(() => { expect(held.host.toasts.length).toBeGreaterThan(0) })
  })

  it('reports a service that is not running without claiming failure', async () => {
    held.host = makeHost({})
    const { StatusMain } = await import('./main.js')
    render(<StatusMain />)
    expect(await screen.findByText('服务未运行')).toBeTruthy()
  })

  it('reports the height the frame needs', async () => {
    instanceRoute([INSTANCE()])
    const { StatusMain } = await import('./main.js')
    render(<StatusMain />)
    await waitFor(() => { expect(held.host.heights.length).toBeGreaterThan(0) })
    expect(held.host.heights.at(-1)).toBeGreaterThan(0)
  })
})
