import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { GuestStatusControl, HostClient } from '@openchamber/sdk'
import { connectThemedHost } from '../shared/host-theme.js'
import { KitBadge, KitSpinner } from '../shared/kit.js'
import { post, type RequestFn } from '../shared/service-client.js'

/**
 * Work Status section — **the remote instance**, not the SSH profile tunnel (D2).
 *
 * The section used to report the batch-2 profile tunnel (`/status`): a different
 * topology with its own controls, which made the rail say "已连 · 引擎可达" about
 * something that was not the machine the panel's 远程实例 tab manages — the exact
 * confusion the user hit ("其它 openchamber 服务器 和 远程实例 是两个东西？").
 *
 * What it shows now is the instance topology's own truth: how many peers are
 * registered, how many are up, and — for the single-peer case — that peer's URL
 * and its egress decision (D1). The controls are 启动/停机 for that one peer,
 * which is the "no terminal needed" path the plan asks for; with two or more
 * peers the rail stays a readout, because "start which one?" has no answer the
 * rail can guess.
 *
 * The profile tunnel's connect/disconnect buttons still exist where their state
 * is visible: the 连接 tab.
 */

interface InstanceStatus {
  state: string
  url: string
  detail?: string
  egress?: { relay: boolean; reason: string; cached: boolean }
}

interface InstanceRow {
  id: string
  name?: string
  host: string
  user?: string
  localPort: number
  status: InstanceStatus | null
}

const EMPTY: InstanceRow[] = []

function railBadge(rows: InstanceRow[]): { label: string; tone: 'success' | 'warning' | 'error' | 'info' | 'neutral' } {
  if (rows.length === 0) return { label: '未登记对端', tone: 'neutral' }
  const online = rows.filter((r) => r.status?.state === 'online').length
  if (online === rows.length) return { label: `在线 ${online}`, tone: 'success' }
  if (online > 0) return { label: `在线 ${online}/${rows.length}`, tone: 'warning' }
  return { label: `离线 ${rows.length}`, tone: 'error' }
}

export function StatusMain() {
  const [host, setHost] = useState<HostClient | null>(null)
  const [rows, setRows] = useState<InstanceRow[]>(EMPTY)
  const [loaded, setLoaded] = useState(false)
  const [offline, setOffline] = useState(false)
  const [busy, setBusy] = useState('')
  const wrap = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    try { setHost(connectThemedHost()) } catch { /* the bridge never came up */ }
  }, [])

  const request: RequestFn = useCallback((path, method = 'GET', body) => {
    if (!host) return Promise.reject(new Error('宿主桥未就绪'))
    return host.serviceRequest({ method, path, body: body === undefined ? undefined : JSON.stringify(body) })
  }, [host])

  const op = useCallback(async <T,>(body: Record<string, unknown>): Promise<T> => {
    const first = await post<{ jobId?: string } & T>(request, '/remote-instance', body)
    if (first && typeof (first as { jobId?: string }).jobId === 'string') {
      const jobId = (first as { jobId: string }).jobId
      const deadline = Date.now() + 5 * 60_000
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1_000))
        const reply = await post<{ job: { state: string; result?: T; error?: string } }>(request, '/remote-instance', { op: 'job', jobId })
        if (reply.job.state === 'done') return reply.job.result as T
        if (reply.job.state === 'error') throw new Error(reply.job.error ?? '操作失败')
      }
      throw new Error('操作超时')
    }
    return first as T
  }, [request])

  const poll = useCallback(async () => {
    if (!host) return
    try {
      const reply = await op<{ instances: InstanceRow[] }>({ op: 'list' })
      setRows(reply.instances ?? [])
      setLoaded(true)
      setOffline(false)
    } catch {
      setOffline(true)
    }
  }, [host, op])

  useEffect(() => {
    if (!host) return
    void poll()
    const t = setInterval(() => void poll(), 15_000)
    return () => clearInterval(t)
  }, [host, poll])

  const single = rows.length === 1 ? rows[0]! : undefined
  const singleUp = single?.status?.state === 'online'

  /** Host-rendered controls. Ids are ours; the host only relays activation. */
  const controls = useCallback((): GuestStatusControl[] => {
    if (!single) return []
    return [
      { kind: 'button', id: 'up', label: '启动', disabled: singleUp || busy === 'up' },
      { kind: 'button', id: 'down', label: '停机', disabled: !singleUp || busy === 'down' },
    ]
  }, [single, singleUp, busy])

  // Nothing to declare until the first answer arrives — declaring the controls
  // from the empty initial state would flash a row of disabled buttons.
  useEffect(() => {
    if (!host) return
    if (!loaded) {
      void host.setStatusControls([]).catch(() => { /* older host */ })
      return
    }
    void host.setStatusControls(controls()).catch(() => { /* older host: stay a plain readout */ })
  }, [host, loaded, rows, controls])

  // Attention, not decoration: a registered peer that is not up.
  useEffect(() => {
    if (!host) return
    const down = offline ? 0 : rows.filter((r) => r.status?.state !== 'online').length
    void host.setBadge(down > 0 ? down : null).catch(() => { /* unsupported */ })
  }, [host, offline, rows])

  const act = useCallback(async (event: { id: string; value?: string }) => {
    if (!host || !single) return
    if (event.id !== 'up' && event.id !== 'down') return
    setBusy(event.id)
    try {
      await op({ op: event.id, id: single.id })
      await poll()
    } catch (e) {
      void host.toast({ kind: 'error', message: e instanceof Error ? e.message : String(e), dismiss: true }).catch(() => {})
    } finally {
      setBusy('')
    }
  }, [host, single, op, poll])

  useEffect(() => {
    if (!host) return
    return host.onStatusControl((event) => { void act(event) })
  }, [host, act])

  // The host sizes this frame from the number we report; observing the content
  // is what keeps it right when a name wraps or a badge appears.
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
  }, [host, rows, offline, busy])

  return (
    <div ref={wrap} className="oc-row" style={{ padding: '8px 12px' }}>
      <strong className="oc-truncate">ocrc 对端实例</strong>
      {offline
        ? <KitBadge label="服务未运行" tone="error" />
        : <KitBadge {...railBadge(rows)} />}
      {busy ? <KitSpinner size="sm" /> : null}
      {single ? (
        <>
          <span className="oc-sdk-muted oc-xs oc-truncate">{single.name ?? single.id}</span>
          <span className="oc-sdk-mono oc-sdk-muted oc-xs oc-truncate">{single.status?.url ?? `http://127.0.0.1:${single.localPort}`}</span>
          {single.status?.egress ? (
            <KitBadge
              label={single.status.egress.relay ? '出口 经控制端' : '出口 直连'}
              tone={single.status.egress.cached ? (single.status.egress.relay ? 'info' : 'success') : 'warning'}
            />
          ) : null}
        </>
      ) : null}
      {!offline && rows.length > 1 ? (
        <span className="oc-sdk-muted oc-xs oc-truncate">{`${rows.map((r) => r.name ?? r.id).slice(0, 3).join('、')}${rows.length > 3 ? ' …' : ''}（多台：起停在「远程实例」页操作）`}</span>
      ) : null}
    </div>
  )
}

const el = document.getElementById('root')
if (el) createRoot(el).render(<StatusMain />)
