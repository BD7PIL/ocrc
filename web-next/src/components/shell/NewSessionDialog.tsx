// components/shell/NewSessionDialog.tsx — minimal create-session dialog.
// M1 scope: directory + backend + create. The full ZCode-register modal
// (engine chips, DirectoryBrowser, ＋远程连接 wizard) is the M4 rework.
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { api } from '$lib/api/client.js'
import { useSessions } from '../../lib/stores/sessions.js'
import { useUi } from '../../lib/stores/ui.js'

interface BackendRow { id: string; capabilities: Record<string, boolean> }

export function NewSessionDialog() {
  const navigate = useNavigate()
  const { newSessionOpen, setNewSessionOpen, setActiveSession } = useUi()
  const list = useSessions((s) => s.list)
  const [directory, setDirectory] = useState('')
  const [backends, setBackends] = useState<BackendRow[]>([])
  const [backendId, setBackendId] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

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
    // autofocus on open
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [newSessionOpen, list])

  if (!newSessionOpen) return null

  const create = async () => {
    setBusy(true)
    setError('')
    try {
      const { id } = await api.createSession({ directory: directory.trim(), backendId: backendId || undefined })
      const fresh = await api.sessions().catch(() => null)
      if (fresh) useSessions.getState().setList(fresh)
      setNewSessionOpen(false)
      setActiveSession(id)
      void navigate(`/session/${id}`)
    } catch (e) {
      setError((e as Error).message || '创建失败')
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[var(--z-modal)] flex items-start justify-center pt-[14vh]" role="dialog" aria-modal>
      <div
        className="absolute inset-0"
        style={{ background: 'var(--scrim)' }}
        onClick={() => setNewSessionOpen(false)}
      />
      <div
        className="relative w-[min(92vw,460px)] rounded-[14px] p-4 ocrc-rise"
        style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-palette)' }}
      >
        <h2 className="mb-3" style={{ fontSize: 'var(--ui-lg)', color: 'var(--text)' }}>新建任务</h2>

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

        {backends.length > 1 && (
          <>
            <label className="label mb-1 block">引擎</label>
            <div className="mb-3 flex flex-wrap gap-1.5">
              {backends.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  className="rounded-full px-3 py-1"
                  style={{
                    fontSize: 'var(--ui-xs)',
                    border: '1px solid ' + (backendId === b.id ? 'var(--accent-line)' : 'var(--border)'),
                    background: backendId === b.id ? 'var(--accent-2)' : 'transparent',
                    color: backendId === b.id ? 'var(--text)' : 'var(--text-3)',
                  }}
                  onClick={() => setBackendId(b.id)}
                >
                  {b.id === 'opencode' ? '本地' : b.id.startsWith('remote:') ? `远程 · ${b.id.slice(7)}` : b.id}
                </button>
              ))}
            </div>
          </>
        )}

        {error && (
          <p className="mb-3" style={{ fontSize: 'var(--ui-sm)', color: 'var(--err)' }}>{error}</p>
        )}

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
    </div>
  )
}
