import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { makeHost, type FakeHost } from '../test/host-mock.js'

const held = vi.hoisted(() => ({ host: null as unknown as FakeHost }))
vi.mock('@openchamber/sdk', async (original) => {
  const actual = await original<typeof import('@openchamber/sdk')>()
  return { ...actual, connectHost: () => held.host.client }
})

const STATUS = { status: { profileId: null, tunnel: 'down', engine: 'unknown' }, profiles: [] }

beforeEach(() => {
  held.host = makeHost({ '/status': { body: STATUS } })
  document.documentElement.removeAttribute('style')
})

function profileRoute(tunnel: 'up' | 'down', engine: 'reachable' | 'unknown') {
  held.host = makeHost({
    '/status': { body: { status: { profileId: 'p1', tunnel, engine }, profiles: [{ id: 'p1', name: 'vm', host: 'h', port: 22, user: 'demo', remotePort: 4096, localPort: 4096 }] } },
    GET: { body: {} },
  })
}

describe('StatusMain — work status surface', () => {
  it('declares host-rendered controls for the profile and connect/disconnect', async () => {
    profileRoute('down', 'unknown')
    const { StatusMain } = await import('./main.js')
    render(<StatusMain />)

    await waitFor(() => {
      expect(held.host.controls.at(-1)?.map((c) => c.id)).toContain('profile')
    })
    const controls = held.host.controls.at(-1) ?? []
    expect(controls.map((c) => c.id)).toEqual(['profile', 'connect', 'disconnect'])
    // Nothing to disconnect from yet, and the profile is connectable.
    expect(controls.find((c) => c.id === 'disconnect')?.disabled).toBe(true)
    expect(controls.find((c) => c.id === 'connect')?.disabled).toBe(false)
  })

  it('reports the height the frame needs', async () => {
    profileRoute('up', 'reachable')
    const { StatusMain } = await import('./main.js')
    render(<StatusMain />)
    await waitFor(() => { expect(held.host.heights.length).toBeGreaterThan(0) })
    expect(held.host.heights.at(-1)).toBeGreaterThan(0)
  })

  it('raises the rail badge while a configured profile is not connected', async () => {
    profileRoute('down', 'unknown')
    const { StatusMain } = await import('./main.js')
    render(<StatusMain />)
    await waitFor(() => { expect(held.host.badges).toContain(1) })
  })

  it('reports a failed activation as a host toast', async () => {
    held.host = makeHost({
      '/status': { body: { status: { profileId: 'p1', tunnel: 'down', engine: 'unknown' }, profiles: [{ id: 'p1', name: 'vm', host: 'h', port: 22, user: 'demo', remotePort: 4096, localPort: 4096 }] } },
      'POST /connect': { status: 502, body: { error: 'ssh: handshake failed' } },
    })
    const { StatusMain } = await import('./main.js')
    render(<StatusMain />)

    await waitFor(() => {
      expect(held.host.controls.at(-1)?.map((c) => c.id)).toContain('profile')
    })
    act(() => { held.host.emitStatusControl({ id: 'connect' }) })

    await waitFor(() => { expect(held.host.toasts).toEqual(['ssh: handshake failed']) })
  })

  it('connects the profile the user picks in the host-rendered select', async () => {
    held.host = makeHost({
      '/status': { body: { status: { profileId: 'p1', tunnel: 'down', engine: 'unknown' }, profiles: [
        { id: 'p1', name: 'vm-a', host: 'a', port: 22, user: 'demo', remotePort: 4096, localPort: 4096 },
        { id: 'p2', name: 'vm-b', host: 'b', port: 22, user: 'demo', remotePort: 4096, localPort: 4097 },
      ] } },
      'POST /connect': { body: { status: { profileId: 'p2', tunnel: 'starting', engine: 'unknown' } } },
    })
    const { StatusMain } = await import('./main.js')
    render(<StatusMain />)

    await waitFor(() => { expect(held.host.controls.at(-1)?.length).toBe(3) })
    act(() => { held.host.emitStatusControl({ id: 'profile', value: 'p2' }) })

    await waitFor(() => {
      const post = held.host.requests.find((r) => r.path === '/connect')
      expect(post?.body).toEqual({ profileId: 'p2' })
    })
  })
})

describe('StatusMain — readout', () => {
  it('shows the connected profile and its branch', async () => {
    held.host = makeHost({
      '/status': { body: { status: { profileId: 'p1', tunnel: 'up', engine: 'reachable' }, profiles: [{ id: 'p1', name: 'vm', host: 'h', port: 22, user: 'demo', remotePort: 4096, localPort: 4096 }] } },
      '/git-branch': { body: { branch: 'main' } },
    })
    const { StatusMain } = await import('./main.js')
    render(<StatusMain />)
    expect(await screen.findByText('已连 · 引擎可达')).toBeTruthy()
    expect(await screen.findByText(/main/)).toBeTruthy()
  })

  it('reports a service that is not running without claiming failure', async () => {
    held.host = makeHost({})
    const { StatusMain } = await import('./main.js')
    render(<StatusMain />)
    expect(await screen.findByText('服务未运行')).toBeTruthy()
  })
})
