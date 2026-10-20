import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { HostClient } from '@openchamber/sdk'
import { connectThemedHost } from '../shared/host-theme.js'
import { networkLabel, stateLabel, TONE_CLASS } from '../shared/instance-labels.js'
import { post, type RequestFn } from '../shared/service-client.js'

/**
 * 状态区：**每台服务器一行只读读数**（名称 · 状态 · OpenChamber 版本 · 直连/经本机转发）。
 *
 * 这一栏只读，不是因为它做不到，而是因为它在宿主里只有一行宽：
 *   · 注册控件（下拉 + 启动/停止）会被挤到第二行，落成一个没有主人的按钮，而且和
 *     面板里的同一组按钮重复——「设置有另外的面板」；
 *   · 标题也不再自己写第二遍：宿主已经用 manifest 的 title 渲染了一行，
 *     再写一个「ocrc 对端实例」就是同一块地方两个标题。
 *
 * 版本与网络是**这台机器自己的事实**：版本取自实例自报（拿不到就写「未知」，
 * 不猜），网络取自出口决定（直连 / 经本机转发）。
 */

interface InstanceRow {
  id: string
  name?: string
  status: {
    state: string
    app?: string
    egress?: { relay: boolean }
  } | null
}

/** 状态词与色调：一处定义，面板与状态区共用同一套说法（`instance-labels`）。 */

export function StatusMain() {
  const [host, setHost] = useState<HostClient | null>(null)
  const [rows, setRows] = useState<InstanceRow[]>([])
  const [offline, setOffline] = useState(false)
  const wrap = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    try { setHost(connectThemedHost()) } catch { /* the bridge never came up */ }
  }, [])

  const request: RequestFn = useCallback((path, method = 'GET', body) => {
    if (!host) return Promise.reject(new Error('宿主桥未就绪'))
    return host.serviceRequest({ method, path, body: body === undefined ? undefined : JSON.stringify(body) })
  }, [host])

  const poll = useCallback(async () => {
    if (!host) return
    try {
      const reply = await post<{ instances: InstanceRow[] }>(request, '/remote-instance', { op: 'list' })
      setRows(reply.instances ?? [])
      setOffline(false)
    } catch {
      setOffline(true)
    }
  }, [host, request])

  useEffect(() => {
    if (!host) return
    void poll()
    const t = setInterval(() => void poll(), 15_000)
    return () => clearInterval(t)
  }, [host, poll])

  // The host sizes this frame from the number we report; observing the content
  // is what keeps it right as servers are added or a name wraps.
  useEffect(() => {
    const node = wrap.current
    if (!host || !node) return
    let last = -1
    const report = () => {
      const height = Math.ceil(node.getBoundingClientRect().height)
      if (height > 0 && height !== last) {
        last = height
        void host.setHeight(height).catch(() => { /* older host clamps it itself */ })
      }
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(node)
    return () => ro.disconnect()
  }, [host])

  return (
    <div ref={wrap} className="oc-rail">
      {offline ? <span className="oc-xs oc-err">服务未运行 —— 扩展的 service 进程没有应答</span> : null}
      {!offline && rows.length === 0 ? <span className="oc-xs oc-off">未添加服务器</span> : null}
      {!offline && rows.map((row) => {
        const state = stateLabel(row.status?.state)
        return (
          <div className="oc-rail-peer" key={row.id}>
            <div className="oc-row oc-row-nowrap">
              <span className="oc-sm oc-truncate">{row.name ?? row.id}</span>
              <span className="oc-push" />
              <span className={`oc-xs oc-rail-state ${TONE_CLASS[state.tone]}`}>
                <span className="oc-dot" aria-hidden="true" />
                {state.label}
              </span>
            </div>
            <span className="oc-xs oc-off oc-truncate">
              {`OpenChamber ${row.status?.app ?? '未知'} · ${networkLabel(row.status?.egress)}`}
            </span>
          </div>
        )
      })}
    </div>
  )
}

const el = document.getElementById('root')
if (el) createRoot(el).render(<StatusMain />)
