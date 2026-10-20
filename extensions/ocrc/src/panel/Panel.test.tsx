import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { makeHost, type FakeHost } from '../test/host-mock.js'
import { Panel } from './Panel.js'

/** The host client is the one thing a guest cannot construct itself, so the
 *  module is mocked and the real kit primitives are left in place — the tests
 *  then read the DOM the SDK actually paints. */
const held = vi.hoisted(() => ({ host: null as unknown as FakeHost }))
vi.mock('@openchamber/sdk', async (original) => {
  const actual = await original<typeof import('@openchamber/sdk')>()
  return { ...actual, connectHost: () => held.host.client }
})

const ROW = {
  id: 'user@192.0.2.10', host: '192.0.2.10', user: 'user', port: 22,
  instancePort: 2610, localPort: 4610, appVersion: '2.3.3', name: 'EL7 box',
  enabled: true, reconnect: true, restoreOnStart: true, sshAuth: 'key',
  hasSshPassword: false, provision: 'push', egress: 'auto', hasUiPassword: true,
  status: { state: 'online', url: 'http://127.0.0.1:4610', app: '2.3.3', engine: { path: '/home/user/.ocrc/remote/engine/opencode', version: '2.0.27' }, egress: { mode: 'auto', relay: true, reason: '远程机器出不了网', cached: true } },
}

beforeEach(() => {
  held.host = makeHost({ 'POST /remote-instance': { body: { instances: [ROW] } } })
  document.documentElement.removeAttribute('style')
  document.documentElement.removeAttribute('data-oc-surface')
})

describe('Panel — 服务器列表这一件事', () => {
  it('paints the host theme onto the document root', async () => {
    render(<Panel />)
    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--surface-background')).toBe('#0e0e10')
    })
    expect(document.documentElement.style.getPropertyValue('--oc-font')).toBe('system-ui, sans-serif')
    expect(document.documentElement.dataset.ocSurface).toBe('panel')
    expect(document.documentElement.style.colorScheme).toBe('dark')
  })

  it('shows the registered server and no tab bar', async () => {
    render(<Panel />)
    expect(await screen.findByText('EL7 box')).toBeTruthy()
    // 上一代的四个标签页（连接 / 远程工作区 / 配置同步 / 远程实例）不再存在：
    // 它们要么永远停在空态，要么和这张卡片重复。
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    for (const gone of ['连接', '远程工作区', '配置同步']) {
      expect(screen.queryByText(gone)).toBeNull()
    }
  })

  it('renders every server it is told about', async () => {
    held.host = makeHost({
      'POST /remote-instance': {
        body: {
          instances: [
            ROW,
            { ...ROW, id: 'ubuntu@100.100.69.3', name: 'Ubuntu 26.04', status: { state: 'offline', url: 'http://127.0.0.1:4612', egress: { mode: 'auto', relay: false, reason: '远程机器自己能出网', cached: true } } },
          ],
        },
      },
    })
    render(<Panel />)
    expect(await screen.findByText('EL7 box')).toBeTruthy()
    expect(await screen.findByText('Ubuntu 26.04')).toBeTruthy()
  })
})
