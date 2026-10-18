import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { makeHost, type FakeHost } from '../test/host-mock.js'

const held = vi.hoisted(() => ({ host: null as unknown as FakeHost }))
vi.mock('@openchamber/sdk', async (original) => {
  const actual = await original<typeof import('@openchamber/sdk')>()
  return { ...actual, connectHost: () => held.host.client }
})

/**
 * 状态区 = 每台一行**只读读数**（名称 · 状态 · OpenChamber 版本 · 直连/经本机转发）。
 *
 * 这里曾经注册过控件（下拉 + 启动/停机）并给 rail 图标挂徽标：宿主这一栏只有一行宽，
 * 三个控件被挤成两行、落下一个没有主人的按钮，而且和面板里的同一组按钮重复。测试
 * 钉住现在的契约：**不注册控件、不挂徽标、不自己写标题**，缺的事实写「未知/未探测」。
 */

const INSTANCE = (over: Record<string, unknown> = {}) => ({
  id: 'demo@192.168.26.101', name: 'EL7 box', host: '192.168.26.101', user: 'demo', localPort: 4610,
  status: { state: 'online', app: '2.3.3', url: 'http://127.0.0.1:4610', egress: { relay: true, reason: '远程机器出不了网', cached: true } },
  ...over,
})

function instanceRoute(instances: unknown[]) {
  held.host = makeHost({ 'POST /remote-instance': { body: { instances } } })
}

beforeEach(() => {
  held.host = makeHost({ 'POST /remote-instance': { body: { instances: [] } } })
  document.documentElement.removeAttribute('style')
})

describe('StatusMain — 只读读数', () => {
  it('每台一行：名称、状态、OpenChamber 版本、网络', async () => {
    instanceRoute([INSTANCE()])
    const { StatusMain } = await import('./main.js')
    render(<StatusMain />)
    expect(await screen.findByText('EL7 box')).toBeTruthy()
    expect(screen.getByText('在线')).toBeTruthy()
    expect(screen.getByText('OpenChamber 2.3.3 · 经本机转发')).toBeTruthy()
  })

  it('直连的机器不会被画成「缺转发」', async () => {
    instanceRoute([INSTANCE({ status: { state: 'online', app: '2.3.3', egress: { relay: false, reason: '远程机器自己能出网', cached: true } } })])
    const { StatusMain } = await import('./main.js')
    render(<StatusMain />)
    expect(await screen.findByText('OpenChamber 2.3.3 · 直连')).toBeTruthy()
  })

  it('没探测过就写「未探测」，没版本就写「未知」', async () => {
    instanceRoute([INSTANCE({ status: { state: 'unknown' } })])
    const { StatusMain } = await import('./main.js')
    render(<StatusMain />)
    expect(await screen.findByText('OpenChamber 未知 · 未探测')).toBeTruthy()
    expect(screen.getByText('未检查')).toBeTruthy()
  })

  it('两台都在屏上，且不注册任何控件、不挂徽标、不自己写标题', async () => {
    instanceRoute([INSTANCE(), INSTANCE({ id: 'ubuntu@100.100.69.3', name: 'Ubuntu 26.04', status: { state: 'offline', app: '2.3.3', egress: { relay: false, reason: '直连', cached: true } } })])
    const { StatusMain } = await import('./main.js')
    render(<StatusMain />)
    expect(await screen.findByText('EL7 box')).toBeTruthy()
    expect(screen.getByText('Ubuntu 26.04')).toBeTruthy()
    expect(screen.getByText('已停止')).toBeTruthy()
    // 标题由宿主按 manifest 渲染，这一帧里不再写第二遍
    expect(screen.queryByText(/ocrc 对端实例/)).toBeNull()
    expect(held.host.controls.at(-1) ?? []).toHaveLength(0)
    expect(held.host.badges.filter((b) => b !== null)).toHaveLength(0)
  })

  it('没添加服务器时说「未添加服务器」', async () => {
    const { StatusMain } = await import('./main.js')
    render(<StatusMain />)
    expect(await screen.findByText('未添加服务器')).toBeTruthy()
  })

  it('service 没在跑时如实说，不假装是空列表', async () => {
    held.host = makeHost({})
    const { StatusMain } = await import('./main.js')
    render(<StatusMain />)
    expect(await screen.findByText(/服务未运行/)).toBeTruthy()
  })

  it('上报自己需要的高度', async () => {
    instanceRoute([INSTANCE()])
    const { StatusMain } = await import('./main.js')
    render(<StatusMain />)
    await waitFor(() => { expect(held.host.heights.length).toBeGreaterThan(0) })
    expect(held.host.heights.at(-1)).toBeGreaterThan(0)
  })
})
