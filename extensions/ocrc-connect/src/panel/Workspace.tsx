import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SshProfile, TunnelStatus } from '../shared/protocol.js'
import type { RequestFn } from './service-client.js'

/** JSON helper over the guest-service bridge (propagates non-2xx as errors). */
export async function jsonCall(request: RequestFn, path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<unknown> {
  const r = await request(path, method, body)
  const parsed = JSON.parse(r.body) as unknown
  if (r.status >= 400) throw new Error((parsed as { error?: string }).error ?? `HTTP ${r.status}`)
  return parsed
}

interface Entry { name: string; type: 'file' | 'dir'; size?: number }

function joinPath(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, '')}/${name}`
}

/** The remote-workspace face: file tree (lazy per-directory), editor with
 *  atomic save, git panel. Everything rides the fs/git-over-ssh endpoints —
 *  the panel itself stays dumb: one fetch per interaction, no caching beyond
 *  the open file. Roots come from host.storage (panel-edited allowlist); the
 *  service re-checks them, so a stale panel never widens access. */
export function Workspace(props: {
  request: RequestFn
  status: TunnelStatus
  profiles: SshProfile[]
  onLoadRoots?: () => Promise<string[] | undefined>
  onRootsChanged?: (roots: string[]) => void | Promise<void>
}) {
  const { request, status } = props
  const activeProfile = useMemo(() => props.profiles.find((p) => p.id === status.profileId), [props.profiles, status.profileId])
  const [roots, setRoots] = useState<string[]>([])
  const [root, setRoot] = useState('')
  const [cwd, setCwd] = useState('')
  const [entries, setEntries] = useState<Entry[]>([])
  const [openPath, setOpenPath] = useState('')
  const [text, setText] = useState('')
  const [dirty, setDirty] = useState(false)
  const [gitBranch, setGitBranch] = useState('')
  const [gitEntries, setGitEntries] = useState<Array<{ x: string; y: string; path: string }>>([])
  const [diff, setDiff] = useState('')
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    void (async () => {
      try {
        const stored = await props.onLoadRoots?.()
        const list = stored ?? activeProfile?.allowedRoots ?? []
        setRoots(list)
        if (list.length > 0) {
          setRoot((r) => r || list[0])
          setCwd((c) => c || list[0])
        }
      } catch { /* first-run: no roots yet */ }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProfile?.id])

  const list = useCallback(async (dir: string) => {
    setErr('')
    try {
      const r = await jsonCall(request, '/fs/list', 'POST', { path: dir }) as { entries: Entry[] }
      setEntries(r.entries)
      setCwd(dir)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }, [request])

  useEffect(() => { if (cwd) void list(cwd) }, [cwd, list])

  const openFile = useCallback(async (path: string, size?: number) => {
    if (size !== undefined && size > 512 * 1024) {
      setErr('文件超过 512 KB——为避免 ssh 传输卡顿，面板不支持直接编辑超大文件')
      return
    }
    setErr('')
    try {
      const r = await jsonCall(request, '/fs/read', 'POST', { path }) as { content: string; encoding: string }
      const decoded = r.encoding === 'base64' ? atob(r.content) : r.content
      // base64 → UTF-8 decode (atob gives latin1 bytes)
      const bytes = Uint8Array.from(decoded, (c) => c.charCodeAt(0))
      setText(new TextDecoder().decode(bytes))
      setOpenPath(path)
      setDirty(false)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }, [request])

  const save = useCallback(async () => {
    if (!openPath) return
    setErr('')
    try {
      await jsonCall(request, '/fs/write', 'POST', { path: openPath, content: text })
      setDirty(false)
      setMsg(`已保存（原文件备份为 .bak）`)
      setTimeout(() => setMsg(''), 2500)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }, [openPath, request, text])

  const refreshGit = useCallback(async () => {
    if (!root) return
    setErr('')
    try {
      const st = await jsonCall(request, '/git/status', 'POST', { path: root }) as { branch?: string; entries?: Array<{ x: string; y: string; path: string }>; error?: string }
      if (st.error) { setGitBranch(''); setGitEntries([]); return }
      setGitBranch(st.branch ?? '')
      setGitEntries(st.entries ?? [])
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }, [request, root])

  useEffect(() => { void refreshGit() }, [refreshGit])

  const showDiff = useCallback(async () => {
    setErr('')
    try {
      const r = await jsonCall(request, '/git/diff', 'POST', { path: root }) as { diff: string }
      setDiff(r.diff || '(无差异)')
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }, [request, root])

  const stageAll = useCallback(async () => {
    try { await jsonCall(request, '/git/stage', 'POST', { path: root }); await refreshGit(); setMsg('已暂存全部'); setTimeout(() => setMsg(''), 2000) } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }, [request, root, refreshGit])

  const commit = useCallback(async () => {
    const message = window.prompt('提交信息')
    if (!message) return
    try {
      const r = await jsonCall(request, '/git/commit', 'POST', { path: root, message }) as { committed?: boolean }
      setMsg(r.committed ? '已提交' : '没有可提交的变更')
      setDiff('')
      await refreshGit()
      setTimeout(() => setMsg(''), 2500)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }, [request, root, refreshGit])

  const addRoot = useCallback(async () => {
    const line = window.prompt('被控机上的工作区绝对路径（如 /home/user/project）')
    if (!line) return
    // Roots are POSIX paths ON THE CONTROLLED HOST — a Windows panel user
    // typing C:\... is the most predictable mistake; surface it instead of
    // silently ignoring the input.
    if (!line.startsWith('/')) {
      setErr('工作区根必须是被控机（Linux）上的绝对路径，以 / 开头 — Windows 盘符路径（C:\\…）不在此处使用。')
      return
    }
    const next = [...new Set([...roots, line.replace(/\/+$/, '')])]
    setRoots(next)
    await props.onRootsChanged?.(next)
  }, [roots, props.onRootsChanged])

  if (status.tunnel !== 'up') {
    return <div className="muted" style={{ padding: 12 }}>远程工作区需要先建立隧道（连接页）。</div>
  }

  return (
    <div style={{ display: 'grid', gap: 10, padding: 12 }}>
      <div className="row">
        <strong>远程工作区</strong>
        <span className="pill ok">{activeProfile?.name ?? status.profileId}</span>
        {gitBranch && <span className="pill">⎇ {gitBranch}</span>}
        <select value={root} onChange={(e) => { setRoot(e.target.value); setCwd(e.target.value); setOpenPath(''); setText(''); setDiff('') }} style={{ maxWidth: 260 }}>
          {roots.length === 0 && <option value="">（未配置工作区根）</option>}
          {roots.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <button onClick={() => void addRoot()}>+ 根目录</button>
        <button onClick={() => cwd && void list(cwd)}>刷新</button>
      </div>
      {msg && <div className="muted" style={{ color: 'var(--ok)' }}>{msg}</div>}
      {err && <div className="muted" role="alert" style={{ color: 'var(--err)' }}>{err}</div>}

      <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
        {/* file tree */}
        <div style={{ minWidth: 240, border: '1px solid var(--border-2)', borderRadius: 8, padding: 8 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{cwd || '—'}</div>
          {cwd && cwd !== '/' && (
            <div className="row" style={{ fontSize: 13 }}>
              <button className="link" onClick={() => void list(cwd.split('/').slice(0, -1).join('/') || '/')}>← 上级</button>
            </div>
          )}
          {entries.map((e) => (
            <div key={e.name} className="row" style={{ fontSize: 13, justifyContent: 'flex-start' }}>
              {e.type === 'dir'
                ? <button className="link" onClick={() => void list(joinPath(cwd, e.name))}>📁 {e.name}</button>
                : <button className="link" onClick={() => void openFile(joinPath(cwd, e.name), e.size)}>📄 {e.name}{e.size !== undefined ? <span className="muted"> ({e.size})</span> : null}</button>}
            </div>
          ))}
          {entries.length === 0 && <div className="muted" style={{ fontSize: 12 }}>（空目录）</div>}
        </div>

        {/* editor */}
        <div style={{ flex: 1, display: 'grid', gap: 6 }}>
          <div className="row">
            <span className="muted" style={{ fontSize: 12 }}>{openPath || '未打开文件'}</span>
            {dirty && <span className="pill" style={{ color: 'var(--warn)' }}>未保存</span>}
            <button className="primary" disabled={!openPath || !dirty} onClick={() => void save()}>保存（原子写 + .bak）</button>
          </div>
          <textarea
            value={text}
            onChange={(e) => { setText(e.target.value); setDirty(true) }}
            spellCheck={false}
            style={{ minHeight: 260, fontFamily: 'ui-monospace, monospace', fontSize: 12, background: 'var(--bg-elev2)', color: 'var(--text)', border: '1px solid var(--border-2)', borderRadius: 8, padding: 8 }}
            placeholder="点左侧文件打开；保存 = 远端 mktemp → 原文件备份 .bak → 原子 mv"
          />
        </div>
      </div>

      {/* git panel */}
      <div style={{ border: '1px solid var(--border-2)', borderRadius: 8, padding: 8, display: 'grid', gap: 6 }}>
        <div className="row">
          <strong>Git</strong>
          <span className="muted" style={{ fontSize: 12 }}>{root}</span>
          <button onClick={() => void refreshGit()}>状态</button>
          <button onClick={() => void showDiff()}>diff</button>
          <button onClick={() => void stageAll()}>暂存全部</button>
          <button className="primary" onClick={() => void commit()}>提交</button>
        </div>
        {gitEntries.length > 0 && (
          <div style={{ fontSize: 12, display: 'grid', gap: 2 }}>
            {gitEntries.slice(0, 20).map((e, i) => (
              <div key={`${e.path}-${i}`} className="row" style={{ justifyContent: 'flex-start', fontFamily: 'ui-monospace, monospace' }}>
                <span className="muted">{e.x}{e.y}</span> {e.path}
              </div>
            ))}
            {gitEntries.length > 20 && <div className="muted">…另有 {gitEntries.length - 20} 个变更</div>}
          </div>
        )}
        {diff && <pre style={{ maxHeight: 200, overflow: 'auto', fontSize: 11, background: 'var(--bg-elev2)', padding: 8, borderRadius: 8 }}>{diff}</pre>}
      </div>
    </div>
  )
}
