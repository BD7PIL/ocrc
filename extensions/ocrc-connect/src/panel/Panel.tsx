import { useCallback, useEffect, useState } from 'react'
import { connectHost, type GuestRequestMethod, type GuestRequestResult, type HostClient } from '@openchamber/sdk'
import type { ServiceApiShape, SshProfile, TunnelStatus } from '../shared/protocol.js'
import { Workspace } from './Workspace.js'

const LAST_KEY = 'lastProfileId'
const ROOTS_KEY = 'workspaceRoots'

type RequestFn = (path: string, method?: GuestRequestMethod, body?: unknown) => Promise<GuestRequestResult>

/** Parse a GuestRequestResult body as JSON, propagating non-2xx as errors. */
async function jsonCall(request: RequestFn, path: string, method: GuestRequestMethod = 'GET', body?: unknown): Promise<unknown> {
  const r = await request(path, method, body)
  const parsed = JSON.parse(r.body) as unknown
  if (r.status >= 400) throw new Error((parsed as { error?: string }).error ?? `HTTP ${r.status}`)
  return parsed
}

export function Panel() {
  const [host, setHost] = useState<HostClient | null>(null)
  const [err, setErr] = useState('')
  const [tab, setTab] = useState<'connect' | 'workspace'>('connect')
  const [state, setState] = useState<ServiceApiShape>({ status: { profileId: null, tunnel: 'down', engine: 'unknown' }, profiles: [] })

  useEffect(() => {
    let disposed = false
    void (async () => {
      try {
        const h = connectHost()
        await h.onReady(() => { /* bridge ready */ })
        if (!disposed) setHost(h)
      } catch (e) {
        if (!disposed) setErr(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => { disposed = true }
  }, [])

  const request: RequestFn = useCallback((path, method = 'GET', body) => {
    if (!host) return Promise.reject(new Error('宿主桥未就绪'))
    return host.serviceRequest({
      method,
      path,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }, [host])

  const refresh = useCallback(async () => {
    try { setState(await jsonCall(request, '/status') as ServiceApiShape) } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }, [request])

  useEffect(() => {
    if (!host) return
    void refresh()
    const t = setInterval(() => void refresh(), 5_000)
    return () => clearInterval(t)
  }, [host, refresh])

  const connect = async (id: string) => {
    setErr('')
    try {
      await jsonCall(request, '/connect', 'POST', { profileId: id })
      await host?.storage.set(LAST_KEY, id)
      await refresh()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }
  const disconnect = async () => {
    try { await jsonCall(request, '/disconnect', 'POST', {}); await refresh() } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }
  const addProfile = async () => {
    const line = window.prompt('SSH 目标（user@host[:port]）')
    if (!line) return
    const [uh, port] = line.split(':')
    const [user, h] = uh.includes('@') ? uh.split('@') : ['', uh]
    try {
      const r = await jsonCall(request, '/profiles', 'POST', {
        profile: { host: h, user: user || 'root', port: port ? Number(port) : undefined },
      }) as { profiles: SshProfile[] }
      setState((s) => ({ ...s, profiles: r.profiles }))
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }

  const s: TunnelStatus = state.status
  const loadRoots = useCallback(async (): Promise<string[] | undefined> => {
    try {
      const raw = await host?.storage.get(ROOTS_KEY)
      if (typeof raw === 'string' && raw.trim()) return JSON.parse(raw) as string[]
    } catch { /* absent on first run */ }
    return undefined
  }, [host])
  const saveRoots = useCallback(async (roots: string[]) => {
    try { await host?.storage.set(ROOTS_KEY, JSON.stringify(roots)) } catch { /* storage full/unavailable */ }
  }, [host])

  return (
    <div style={{ padding: 12, display: 'grid', gap: 10 }}>
      <div className="row" style={{ gap: 8 }}>
        <button className={tab === 'connect' ? 'primary' : ''} onClick={() => setTab('connect')}>连接</button>
        <button className={tab === 'workspace' ? 'primary' : ''} onClick={() => setTab('workspace')}>远程工作区</button>
      </div>
      {tab === 'workspace'
        ? <Workspace request={request} status={s} profiles={state.profiles} onLoadRoots={loadRoots} onRootsChanged={saveRoots} />
        : (
      <>
      <div className="row">
        <strong>ocrc 连接</strong>
        <span className={`pill ${s.tunnel === 'up' ? 'ok' : 'err'}`}>隧道 {s.tunnel === 'up' ? '已连' : s.tunnel === 'starting' ? '建立中' : '未连'}</span>
        {s.tunnel === 'up' && (
          <span className={`pill ${s.engine === 'reachable' ? 'ok' : s.engine === 'unreachable' ? 'err' : ''}`}>
            引擎 {s.engine === 'reachable' ? '可达' : s.engine === 'unreachable' ? '不可达' : '未知'}
          </span>
        )}
      </div>
      {err && <div className="muted" role="alert">{err}</div>}
      <div style={{ display: 'grid', gap: 6 }}>
        {state.profiles.length === 0 && <div className="muted">尚无档案——添加一个 SSH 目标（被控机）。</div>}
        {state.profiles.map((p) => (
          <div key={p.id} className="row" style={{ justifyContent: 'space-between' }}>
            <span>{p.name} <span className="muted">{p.user}@{p.host}:{p.port} → :{p.localPort}</span></span>
            {s.profileId === p.id && s.tunnel !== 'down'
              ? <button onClick={() => void disconnect()}>断开</button>
              : <button className="primary" onClick={() => void connect(p.id)}>连接</button>}
          </div>
        ))}
      </div>
      <div className="row">
        <button onClick={() => void addProfile()}>添加档案</button>
        <button onClick={() => void refresh()}>刷新</button>
      </div>
      <div className="muted" style={{ fontSize: 12 }}>
        隧道落地 127.0.0.1:{state.profiles[0]?.localPort ?? 4096}——openchamber 启动时自动探测该端口，零环境变量。
      </div>
      </>
      )}
    </div>
  )
}
