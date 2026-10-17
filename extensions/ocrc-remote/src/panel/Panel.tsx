import { useCallback, useEffect, useState } from 'react'
import type { HostClient } from '@openchamber/sdk'
import { connectThemedHost } from '../shared/host-theme.js'
import { KitBadge, KitBanner, KitButton, KitField, KitSeparator, KitSpinner, KitTabs } from '../shared/kit.js'
import type { ServiceApiShape, SshProfile, TunnelStatus } from '../shared/protocol.js'
import { call, post, type RequestFn } from '../shared/service-client.js'
import { Workspace } from './Workspace.js'
import { ConfigSync } from './ConfigSync.js'
import { HostView } from './HostView.js'
import { RemoteInstance } from './RemoteInstance.js'
import { registerGuestCommands } from './commands.js'

const LAST_KEY = 'lastProfileId'
const ROOTS_KEY = 'workspaceRoots'

const TABS = [
  { id: 'instance', label: '远程实例' },
  { id: 'connect', label: '连接' },
  { id: 'workspace', label: '远程工作区' },
  { id: 'configsync', label: '配置同步' },
]

const EMPTY: ServiceApiShape = { status: { profileId: null, tunnel: 'down', engine: 'unknown' }, profiles: [] }

/** Add-profile form. Inline, never `window.prompt`: the guest sandbox runs
 *  without `allow-modals`, so a prompt is ignored and silently returns null —
 *  which is how "添加档案" used to do nothing at all. */
function ProfileForm(props: { busy: boolean; onCancel: () => void; onSubmit: (p: Partial<SshProfile> & { host: string }) => void }) {
  const [target, setTarget] = useState('')
  const [keyPath, setKeyPath] = useState('')

  const submit = () => {
    const line = target.trim()
    if (!line) return
    const [hostPart, portPart] = line.split(':')
    const [user, host] = hostPart.includes('@') ? hostPart.split('@') : ['', hostPart]
    props.onSubmit({
      host: host.trim(),
      user: user.trim() || undefined,
      port: portPart ? Number(portPart) : undefined,
      keyPath: keyPath.trim() || undefined,
    })
  }

  return (
    <div className="oc-card">
      <KitField
        label="SSH 目标"
        value={target}
        onChange={setTarget}
        placeholder="user@host[:port]"
        helper="被控机的 ssh 地址；端口留空为 22。"
      />
      <KitField
        label="私钥路径（可选）"
        value={keyPath}
        onChange={setKeyPath}
        placeholder="C:\Users\me\.ssh\id_ed25519"
        helper="面板宿主机上的私钥绝对路径，留空走默认 ~/.ssh 密钥——Windows 的 ssh-agent 默认停用，BatchMode 下通常要显式指定。"
        mono
      />
      <div className="oc-row">
        <KitButton label="添加" disabled={!target.trim() || props.busy} size="sm" onClick={submit} />
        <KitButton label="取消" variant="ghost" size="sm" disabled={props.busy} onClick={props.onCancel} />
      </div>
    </div>
  )
}

const tunnelBadge = (s: TunnelStatus) =>
  s.tunnel === 'up' ? { label: '隧道已连', tone: 'success' as const }
    : s.tunnel === 'starting' ? { label: '隧道建立中', tone: 'info' as const }
      : { label: '隧道未连', tone: 'neutral' as const }

const engineBadge = (s: TunnelStatus) =>
  s.engine === 'reachable' ? { label: '引擎可达', tone: 'success' as const }
    : s.engine === 'unreachable' ? { label: '引擎不可达', tone: 'error' as const }
      : { label: '引擎未知', tone: 'neutral' as const }

export function Panel() {
  const [host, setHost] = useState<HostClient | null>(null)
  const [offline, setOffline] = useState(false)
  const [err, setErr] = useState('')
  const [tab, setTab] = useState('connect')
  const [state, setState] = useState<ServiceApiShape>(EMPTY)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let disposed = false
    let unregister: (() => void) | undefined
    try {
      const h = connectThemedHost()
      // 斜杠命令必须和 connectHost 同步注册：宿主在提交 `/ocrc-host` 时（没有
      // 挂载中的面板就现挂一个隐藏帧）立刻会问处理者，晚一步就是「命令没反应」。
      unregister = registerGuestCommands(h)
      if (!disposed) setHost(h)
    } catch (e) {
      if (!disposed) setErr(e instanceof Error ? e.message : String(e))
    }
    return () => { disposed = true; unregister?.() }
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
    if (!host) return
    try {
      setState(await call<ServiceApiShape>(request, '/status'))
      setOffline(false)
    } catch {
      // A service that is not running answers as an error too. That is a state
      // to report, not a failure the user has to dismiss.
      setOffline(true)
    }
  }, [host, request])

  useEffect(() => {
    if (!host) return
    void refresh()
    const t = setInterval(() => void refresh(), 5_000)
    return () => clearInterval(t)
  }, [host, refresh])

  const connect = async (id: string) => {
    setErr('')
    try {
      await post(request, '/connect', { profileId: id })
      await host?.storage.set(LAST_KEY, id)
      await refresh()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }

  const disconnect = async () => {
    setErr('')
    try { await post(request, '/disconnect', {}); await refresh() } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }

  const addProfile = async (draft: Partial<SshProfile> & { host: string }) => {
    setErr('')
    try {
      const r = await post<{ profiles: SshProfile[] }>(request, '/profiles', { profile: draft })
      setState((s) => ({ ...s, profiles: r.profiles }))
      setAdding(false)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }

  const removeProfile = async (id: string) => {
    setErr('')
    try {
      const r = await call<{ profiles: SshProfile[] }>(request, `/profiles/${id}`, 'DELETE')
      setState((s) => ({ ...s, profiles: r.profiles }))
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }

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

  const s = state.status

  return (
    <div className="oc-page">
      <KitTabs items={TABS} activeId={tab} onChange={setTab} trackBackground />

      {/* Every tab stays mounted. A background refresh or a tab switch must not
          throw away a half-written commit message or a navigated-into tree. */}
      <div hidden={tab !== 'instance'}>
        <RemoteInstance request={request} host={host} />
      </div>

      <div hidden={tab !== 'connect'} className="oc-col">
        <div className="oc-row">
          <strong>ocrc 连接</strong>
          <KitBadge {...tunnelBadge(s)} />
          {s.tunnel === 'up' && <KitBadge {...engineBadge(s)} />}
        </div>

        {err && <KitBanner tone="error" title="操作失败" body={err} />}
        {offline && <KitBanner tone="info" title="ocrc 服务未运行" body="连接扩展的 service 进程没有应答，档案与隧道都不可用。" />}

        {state.profiles.length === 0 && !adding && (
          <div className="oc-sdk-muted oc-sm">尚无档案——添加一个 SSH 目标（被控机）。</div>
        )}

        {state.profiles.map((p) => {
          const active = s.profileId === p.id && s.tunnel !== 'down'
          return (
            <div key={p.id} className="oc-card">
              <div className="oc-row">
                <strong>{p.name}</strong>
                <span className="oc-sdk-mono oc-sdk-muted oc-sm">{p.user}@{p.host}:{p.port} → 127.0.0.1:{p.localPort}</span>
                {active && <KitBadge label="当前" tone="primary" />}
                <span className="oc-push" />
                {active
                  ? <KitButton label="断开" variant="outline" size="sm" onClick={() => void disconnect()} />
                  : <KitButton label="连接" size="sm" onClick={() => void connect(p.id)} />}
                {!active && <KitButton label="删除" variant="ghost" size="sm" onClick={() => void removeProfile(p.id)} />}
              </div>
              {(p.allowedRoots ?? []).length > 0 && (
                <div className="oc-sdk-mono oc-sdk-muted oc-xs">允许访问：{(p.allowedRoots ?? []).join(' · ')}</div>
              )}
            </div>
          )
        })}

        {adding
          ? (
            <ProfileForm
              busy={busy}
              onCancel={() => setAdding(false)}
              onSubmit={(draft) => { setBusy(true); void addProfile(draft).finally(() => setBusy(false)) }}
            />
          )
          : (
            <div className="oc-row">
              <KitButton label="添加档案" variant="outline" size="sm" onClick={() => setAdding(true)} />
              {busy && <KitSpinner size="sm" label="提交中" />}
            </div>
          )}

        {/* 换位后这一页的落点：面板控制一切——只要有 ssh，就有引擎、运行时与配置。 */}
        <HostView request={request} status={s} profiles={state.profiles} host={host} />

        <KitSeparator />
        <div className="oc-sdk-muted oc-xs">
          隧道落地在面板宿主的 127.0.0.1:{state.profiles[0]?.localPort ?? 4096}——面板宿主启动 openchamber 时要用{' '}
          <span className="oc-sdk-mono">OPENCODE_PORT={state.profiles[0]?.localPort ?? 4096}</span>（或 <span className="oc-sdk-mono">OPENCODE_HOST</span>）
          指向它，引擎才会接在隧道那端；不给这个变量，openchamber 会自己拉一个本机引擎（被控端零改动，但面板宿主得有 v2 引擎）。
        </div>
      </div>

      <div hidden={tab !== 'workspace'}>
        <Workspace request={request} status={s} profiles={state.profiles} onLoadRoots={loadRoots} onRootsChanged={saveRoots} />
      </div>

      <div hidden={tab !== 'configsync'}>
        <ConfigSync request={request} status={s} profiles={state.profiles} />
      </div>
    </div>
  )
}
