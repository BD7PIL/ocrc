// components/shell/NewSessionDialog.tsx — the 新建任务 page (M4-1).
//
// 本地 tab: engine chips (local + already-registered remotes) + directory.
// 远程 tab: SSH target form → 保存并探测 → TWO-STATE presentation per the
// domain model (PRODUCT.md 第零点五条):
//   探测到端口已有 serve → 「接入已有引擎（adopt）」
//   已装 opencode        → 「接入并拉起 serve（spawn）」
//   什么都没有           → provisioning 路径选择（推送本机二进制 = 主路径 /
//                          远端自装 = 官方脚本），logTail 控制台全程可见
// Enabling a remote registers its backend AT RUNTIME (no host restart).
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { Cloud, HardDrive, Loader2 } from 'lucide-react'
import { api } from '$lib/api/client.js'
import { useSessions } from '../../lib/stores/sessions.js'
import { useUi } from '../../lib/stores/ui.js'

interface BackendRow { id: string; capabilities: Record<string, boolean> }

type RemoteStep = 'form' | 'inspected' | 'provisioning' | 'done'

export function NewSessionDialog() {
  const navigate = useNavigate()
  const { newSessionOpen, setNewSessionOpen, setActiveSession } = useUi()
  const list = useSessions((s) => s.list)
  const [tab, setTab] = useState<'local' | 'remote'>('local')

  // local pane state
  const [directory, setDirectory] = useState('')
  const [backends, setBackends] = useState<BackendRow[]>([])
  const [backendId, setBackendId] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // remote pane state
  const [form, setForm] = useState({ name: '', host: '', port: '22', user: '', remotePort: '4199' })
  const [remoteId, setRemoteId] = useState<string | null>(null)
  const [step, setStep] = useState<RemoteStep>('form')
  const [inspection, setInspection] = useState<Record<string, unknown> | null>(null)
  const [provPath, setProvPath] = useState<'push' | 'install'>('push')
  const [logTail, setLogTail] = useState<string[]>([])
  const logTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  useEffect(() => {
    if (!newSessionOpen) return
    setError('')
    setBusy(false)
    const last = list.find((s) => !!s.directory)?.directory
    setDirectory((d) => d || last || '')
    void api.backends().then((b) => {
      setBackends(b.backends)
      setBackendId((cur) => cur || b.activeId)
    }).catch(() => {})
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [newSessionOpen, list])

  if (!newSessionOpen) return null

  // ── local create ──
  const create = async () => {
    setBusy(true)
    setError('')
    try {
      const { id } = await api.createSession({ directory: directory.trim(), backendId: backendId || undefined })
      await refresh()
      setNewSessionOpen(false)
      setActiveSession(id)
      void navigate(`/session/${id}`)
    } catch (e) {
      setError((e as Error).message || '创建失败')
      setBusy(false)
    }
  }

  const refresh = async () => {
    const [fresh, b] = await Promise.all([
      api.sessions().catch(() => null),
      api.backends().catch(() => null),
    ])
    if (fresh) useSessions.getState().setList(fresh)
    if (b) { setBackends(b.backends); setBackendId(b.activeId) }
  }

  // ── remote flow ──
  const probe = async () => {
    setBusy(true)
    setError('')
    try {
      const { remote } = await api.saveRemote({
        host: form.host.trim(),
        port: Number(form.port) || 22,
        user: form.user.trim() || undefined,
        remotePort: Number(form.remotePort) || 4199,
        name: form.name.trim() || undefined,
      })
      setRemoteId(remote.id)
      const { inspection } = await api.inspectRemote(remote.id)
      setInspection(inspection as Record<string, unknown>)
      setStep('inspected')
    } catch (e) {
      setError((e as Error).message || '探测失败')
    } finally {
      setBusy(false)
    }
  }

  const provision = async () => {
    if (!remoteId) return
    setStep('provisioning')
    void pollLogs(remoteId)
    try {
      const r = await api.provisionRemote(remoteId, provPath)
      if (!r.ok) setError(r.detail || '安装失败')
    } catch (e) {
      setError((e as Error).message || '安装失败')
    }
  }

  const enable = async () => {
    if (!remoteId) return
    setBusy(true)
    try {
      await api.setRemoteEnabled(remoteId, true)
      await refresh()
      setStep('done')
      setTab('local') // the new remote:* chip now sits in the engine list
    } catch (e) {
      setError((e as Error).message || '接入失败')
    } finally {
      setBusy(false)
    }
  }

  // logTail polling while provisioning
  const pollLogs = (id: string) => {
    if (logTimer.current) clearInterval(logTimer.current)
    logTimer.current = setInterval(() => {
      void api.remotes().then((r) => {
        const row = r.remotes.find((x) => x.id === id) as { status?: { logTail?: string[] } } | undefined
        if (row?.status?.logTail) setLogTail(row.status.logTail)
      }).catch(() => {})
    }, 1200)
    setTimeout(() => { if (logTimer.current) clearInterval(logTimer.current) }, 180_000)
  }

  return (
    <div className="fixed inset-0 z-[var(--z-modal)] flex items-start justify-center pt-[10vh]" role="dialog" aria-modal>
      <div className="absolute inset-0" style={{ background: 'var(--scrim)' }} onClick={() => setNewSessionOpen(false)} />
      <div
        className="relative flex w-[min(94vw,560px)] flex-col rounded-[14px] p-4 ocrc-rise"
        style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-palette)', maxHeight: '80vh' }}
      >
        <h2 className="mb-3" style={{ fontSize: 'var(--ui-lg)', color: 'var(--text)' }}>新建任务</h2>

        <div className="mb-3 flex gap-0.5 self-start rounded-full p-0.5" style={{ background: 'var(--bg-input)' }}>
          <Seg active={tab === 'local'} onClick={() => setTab('local')}><HardDrive size={12} className="inline" /> 本地</Seg>
          <Seg active={tab === 'remote'} onClick={() => setTab('remote')}><Cloud size={12} className="inline" /> 远程连接</Seg>
        </div>

        {tab === 'local' ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <label className="label mb-1 block">引擎</label>
            <div className="mb-3 flex flex-wrap gap-1.5">
              {backends.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  className="rounded-full px-3 py-1"
                  style={{
                    fontSize: 'var(--ui-xs)',
                    border: `1px solid ${backendId === b.id ? 'var(--accent-line)' : 'var(--border)'}`,
                    background: backendId === b.id ? 'var(--accent-2)' : 'transparent',
                    color: backendId === b.id ? 'var(--text)' : 'var(--text-3)',
                  }}
                  onClick={() => setBackendId(b.id)}
                >
                  {b.id === 'opencode' ? '本地' : b.id.startsWith('remote:') ? `远程 · ${b.id.slice(7)}` : b.id}
                </button>
              ))}
            </div>

            <label className="label mb-1 block">工作目录</label>
            <input
              ref={inputRef}
              className="mb-3 w-full rounded-[9px] px-3 py-2 outline-none"
              style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: 'var(--text-mobile-input-safe)' }}
              placeholder="/path/to/project"
              value={directory}
              onChange={(e) => setDirectory(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void create() }}
            />

            {error && <p className="mb-3" style={{ fontSize: 'var(--ui-sm)', color: 'var(--err)' }}>{error}</p>}

            <div className="flex justify-end gap-2">
              <button type="button" className="demo-btn" onClick={() => setNewSessionOpen(false)}>取消</button>
              <button
                type="button"
                className="rounded-[9px] px-4 py-2 disabled:opacity-50"
                style={{ background: 'var(--accent)', color: 'var(--accent-ink)', fontSize: 'var(--ui-sm)' }}
                disabled={busy || !directory.trim()}
                onClick={() => void create()}
              >
                {busy ? '创建中…' : '创建'}
              </button>
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            {step === 'form' && (
              <>
                <div className="mb-3 grid grid-cols-2 gap-2">
                  <Field label="名称（可选）" value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="my-server" />
                  <Field label="主机" value={form.host} onChange={(v) => setForm({ ...form, host: v })} placeholder="ssh host" />
                  <Field label="SSH 端口" value={form.port} onChange={(v) => setForm({ ...form, port: v })} placeholder="22" />
                  <Field label="用户（可选）" value={form.user} onChange={(v) => setForm({ ...form, user: v })} placeholder="root" />
                  <Field label="引擎端口（远端）" value={form.remotePort} onChange={(v) => setForm({ ...form, remotePort: v })} placeholder="4199" />
                </div>
                {error && <p className="mb-3" style={{ fontSize: 'var(--ui-sm)', color: 'var(--err)' }}>{error}</p>}
                <div className="flex justify-end">
                  <button
                    type="button"
                    className="rounded-[9px] px-4 py-2 disabled:opacity-50"
                    style={{ background: 'var(--accent)', color: 'var(--accent-ink)', fontSize: 'var(--ui-sm)' }}
                    disabled={busy || !form.host.trim()}
                    onClick={() => void probe()}
                  >
                    {busy ? '探测中…' : '保存并探测'}
                  </button>
                </div>
              </>
            )}

            {step !== 'form' && remoteId && (
              <div className="mb-3 rounded-[9px] px-3 py-2" style={{ background: 'var(--bg-input)', border: '1px solid var(--border)' }}>
                <span className="mono" style={{ fontSize: 'var(--ui-2xs)', color: 'var(--text-3)' }}>
                  {form.host}:{form.remotePort} · id {remoteId}
                </span>
              </div>
            )}

            {step === 'inspected' && inspection && (
              <TwoStateCards
                inspection={inspection}
                onAdopt={() => void enable()}
                provPath={provPath}
                setProvPath={setProvPath}
                onProvision={() => void provision()}
                busy={busy}
                error={error}
              />
            )}

            {step === 'provisioning' && (
              <div>
                <p className="mb-2 flex items-center gap-2" style={{ fontSize: 'var(--ui-sm)', color: 'var(--text-2)' }}>
                  <Loader2 size={14} className="animate-spin" /> 安装中（logTail 实时）…
                </p>
                <pre className="mono max-h-44 overflow-y-auto rounded-[9px] p-2" style={{ background: 'var(--bg-code)', fontSize: 'var(--ui-2xs)', color: 'var(--toolout)' }}>
                  {logTail.join('\n') || '…'}
                </pre>
                {error && <p className="mt-2" style={{ fontSize: 'var(--ui-sm)', color: 'var(--err)' }}>{error}</p>}
                <div className="mt-2 flex justify-end">
                  <button type="button" className="demo-btn" onClick={() => void enable()} disabled={busy}>接入</button>
                </div>
              </div>
            )}

            {step === 'done' && (
              <div className="flex flex-col items-center gap-3 py-6">
                <p style={{ fontSize: 'var(--ui-sm)', color: 'var(--ok)' }}>远端已接入（运行时注册，无需重启）</p>
                <button
                  type="button"
                  className="rounded-[9px] px-4 py-2"
                  style={{ background: 'var(--accent)', color: 'var(--accent-ink)', fontSize: 'var(--ui-sm)' }}
                  onClick={() => { setStep('form'); setRemoteId(null); setInspection(null); setLogTail([]) }}
                >
                  再接一台
                </button>
              </div>
            )}

            {step !== 'done' && (
              <div className="mt-3 flex justify-end">
                <button type="button" className="demo-btn" onClick={() => setNewSessionOpen(false)}>关闭</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function Seg({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-full px-3.5 py-1 transition-colors"
      style={{
        fontSize: 'var(--ui-xs)',
        background: active ? 'var(--bg-elev2)' : 'transparent',
        color: active ? 'var(--text)' : 'var(--text-3)',
      }}
    >
      {children}
    </button>
  )
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div>
      <label className="label mb-1 block">{label}</label>
      <input
        className="w-full rounded-[9px] px-2.5 py-1.5 outline-none"
        style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: 'var(--ui-sm)' }}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}

/** The transport×lifecycle two-state presentation (PRODUCT.md 第零点五条). */
function TwoStateCards({ inspection, onAdopt, provPath, setProvPath, onProvision, busy, error }: {
  inspection: Record<string, unknown>
  onAdopt: () => void
  provPath: 'push' | 'install'
  setProvPath: (v: 'push' | 'install') => void
  onProvision: () => void
  busy: boolean
  error: string
}) {
  const installed = !!inspection.opencodePath
  const listening = !!inspection.portListening
  const version = typeof inspection.version === 'string' ? inspection.version : ''

  if (listening) {
    return (
      <StateCard
        dot="var(--ok)"
        title="探测到已有引擎在运行"
        detail={version ? `opencode ${version} — 直接接入（adopt，host 只驾驶不接管生命周期）` : '端口已有 serve — 直接接入（adopt）'}
        action="接入已有引擎"
        onAction={onAdopt}
        busy={busy}
      />
    )
  }
  if (installed) {
    return (
      <StateCard
        dot="var(--accent)"
        title={`已装 opencode${version ? ` ${version}` : ''}，端口未监听`}
        detail="接入并拉起 serve（spawn 态：引擎随隧道共生，host 断则远端引擎停）"
        action="接入并拉起"
        onAction={onAdopt}
        busy={busy}
      />
    )
  }
  return (
    <div>
      <p className="mb-2" style={{ fontSize: 'var(--ui-sm)', color: 'var(--text-2)' }}>远端没有 opencode — 选择安装路径：</p>
      <div className="mb-3 flex flex-col gap-1.5">
        <PathOption
          selected={provPath === 'push'}
          onClick={() => setProvPath('push')}
          title="推送本机二进制（推荐，远端零联网依赖）"
          detail="scp 推送本机缓存的官方工件（pin 版本）"
        />
        <PathOption
          selected={provPath === 'install'}
          onClick={() => setProvPath('install')}
          title="远端自装（官方安装脚本）"
          detail="curl opencode.ai/install — 需要远端能上网"
        />
      </div>
      {error && <p className="mb-2" style={{ fontSize: 'var(--ui-sm)', color: 'var(--err)' }}>{error}</p>}
      <div className="flex justify-end">
        <button
          type="button"
          className="rounded-[9px] px-4 py-2"
          style={{ background: 'var(--accent)', color: 'var(--accent-ink)', fontSize: 'var(--ui-sm)' }}
          disabled={busy}
          onClick={onProvision}
        >
          安装
        </button>
      </div>
    </div>
  )
}

function StateCard({ dot, title, detail, action, onAction, busy }: {
  dot: string; title: string; detail: string; action: string; onAction: () => void; busy: boolean
}) {
  return (
    <div className="rounded-[9px] p-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border)' }}>
      <div className="flex items-center gap-2">
        <span className="size-2 rounded-full" style={{ background: dot }} aria-hidden />
        <span style={{ fontSize: 'var(--ui-sm)', color: 'var(--text)' }}>{title}</span>
      </div>
      <p className="mt-1" style={{ fontSize: 'var(--ui-xs)', color: 'var(--text-3)' }}>{detail}</p>
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          className="rounded-[9px] px-4 py-1.5 disabled:opacity-50"
          style={{ background: 'var(--accent)', color: 'var(--accent-ink)', fontSize: 'var(--ui-sm)' }}
          disabled={busy}
          onClick={onAction}
        >
          {action}
        </button>
      </div>
    </div>
  )
}

function PathOption({ selected, onClick, title, detail }: { selected: boolean; onClick: () => void; title: string; detail: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className="rounded-[9px] px-3 py-2 text-left transition-colors"
      style={{
        border: `1px solid ${selected ? 'var(--accent-line)' : 'var(--border)'}`,
        background: selected ? 'var(--accent-2)' : 'transparent',
      }}
      onClick={onClick}
    >
      <p style={{ fontSize: 'var(--ui-sm)', color: 'var(--text)' }}>{title}</p>
      <p style={{ fontSize: 'var(--ui-2xs)', color: 'var(--text-3)' }}>{detail}</p>
    </button>
  )
}
