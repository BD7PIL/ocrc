import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { GuestStatusControl, HostClient } from '@openchamber/sdk'
import { connectThemedHost } from '../shared/host-theme.js'
import { KitBadge, KitSpinner } from '../shared/kit.js'
import type { ServiceApiShape, TunnelStatus } from '../shared/protocol.js'
import { call, type RequestFn } from '../shared/service-client.js'

/** Work Status section — compact tunnel/engine health via the service bridge.
 *
 *  The host sizes this frame, renders the controls we declare and owns the rail
 *  badge, so the section is three things: report the height the content needs,
 *  declare the controls (connect / disconnect / profile pick), and answer their
 *  activation. Anything the user must not miss (a connect that failed) goes to
 *  a host toast instead of a line of text that scrolls away. */

const EMPTY: ServiceApiShape = { status: { profileId: null, tunnel: 'down', engine: 'unknown' }, profiles: [] }

function tunnelBadge(s: TunnelStatus) {
  if (s.tunnel === 'up') return { label: s.engine === 'reachable' ? '已连 · 引擎可达' : '已连 · 引擎不可达', tone: s.engine === 'reachable' ? 'success' as const : 'error' as const }
  if (s.tunnel === 'starting') return { label: '建立中', tone: 'info' as const }
  return { label: '未连', tone: 'neutral' as const }
}

export function StatusMain() {
  const [host, setHost] = useState<HostClient | null>(null)
  const [state, setState] = useState<ServiceApiShape>(EMPTY)
  const [loaded, setLoaded] = useState(false)
  const [branch, setBranch] = useState('')
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
      const next = await call<ServiceApiShape>(request, '/status')
      setState(next)
      setLoaded(true)
      setOffline(false)
      // Batch 4: the branch of the active workspace — one best-effort call;
      // any failure just drops the suffix.
      if (next.status.tunnel === 'up' && next.status.engine === 'reachable') {
        try {
          const gb = await call<{ branch?: string }>(request, '/git-branch')
          setBranch(gb.branch ?? '')
        } catch { setBranch('') }
      } else {
        setBranch('')
      }
    } catch {
      setOffline(true)
    }
  }, [host, request])

  useEffect(() => {
    if (!host) return
    void poll()
    const t = setInterval(() => void poll(), 10_000)
    return () => clearInterval(t)
  }, [host, poll])

  /** Host-rendered controls. Ids are ours; the host only relays activation. */
  const controls = useCallback((s: ServiceApiShape): GuestStatusControl[] => {
    const out: GuestStatusControl[] = []
    if (s.profiles.length > 0) {
      out.push({
        kind: 'select',
        id: 'profile',
        label: '档案',
        value: s.status.profileId ?? s.profiles[0].id,
        options: s.profiles.map((p) => ({ value: p.id, label: p.name })),
        disabled: s.status.tunnel === 'starting',
      })
    }
    out.push({
      kind: 'button',
      id: 'connect',
      label: '连接',
      disabled: s.profiles.length === 0 || s.status.tunnel === 'up' || s.status.tunnel === 'starting',
    })
    out.push({
      kind: 'button',
      id: 'disconnect',
      label: '断开',
      disabled: s.status.tunnel === 'down' || s.status.tunnel === 'starting',
    })
    return out
  }, [])

  // Nothing to declare until the first answer arrives — declaring the controls
  // from the empty initial state would flash a row of disabled buttons.
  useEffect(() => {
    if (!host) return
    if (!loaded) {
      void host.setStatusControls([]).catch(() => { /* older host */ })
      return
    }
    void host.setStatusControls(controls(state)).catch(() => { /* older host: stay a plain readout */ })
  }, [host, loaded, state, controls])

  // Attention, not decoration: a profile that is configured but not connected.
  useEffect(() => {
    if (!host) return
    const pending = !offline && state.profiles.length > 0 && state.status.tunnel === 'down'
    void host.setBadge(pending ? 1 : null).catch(() => { /* unsupported */ })
  }, [host, offline, state])

  const act = useCallback(async (event: { id: string; value?: string }) => {
    if (!host) return
    try {
      if (event.id === 'connect') {
        const id = state.status.profileId ?? state.profiles[0]?.id
        if (!id) return
        await call(request, '/connect', 'POST', { profileId: id })
      } else if (event.id === 'disconnect') {
        await call(request, '/disconnect', 'POST', {})
      } else if (event.id === 'profile' && event.value) {
        await call(request, '/connect', 'POST', { profileId: event.value })
      } else {
        return
      }
      await poll()
    } catch (e) {
      void host.toast({ kind: 'error', message: e instanceof Error ? e.message : String(e), dismiss: true }).catch(() => {})
    }
  }, [host, poll, request, state])

  useEffect(() => {
    if (!host) return
    return host.onStatusControl((event) => { void act(event) })
  }, [host, act])

  // The host sizes this frame from the number we report; observing the content
  // is what keeps it right when the profile name wraps or a badge appears.
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
  }, [host, state, branch, offline])

  const s = state.status
  const active = state.profiles.find((p) => p.id === s.profileId)

  return (
    <div ref={wrap} className="oc-row" style={{ padding: '8px 12px' }}>
      <strong className="oc-truncate">ocrc 隧道</strong>
      {offline
        ? <KitBadge label="服务未运行" tone="error" />
        : <KitBadge {...tunnelBadge(s)} />}
      {!offline && s.tunnel === 'starting' && <KitSpinner size="sm" />}
      {active && <span className="oc-sdk-muted oc-xs oc-truncate">{active.user}@{active.host}</span>}
      {branch && <span className="oc-sdk-mono oc-sdk-muted oc-xs oc-truncate" title={branch}>· {branch}</span>}
    </div>
  )
}

const el = document.getElementById('root')
if (el) createRoot(el).render(<StatusMain />)
