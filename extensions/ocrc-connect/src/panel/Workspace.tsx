import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { RiFileLine, RiFolderLine, RiFolderOpenLine, RiGitBranchLine } from '@remixicon/react'
import type { SshProfile, TunnelStatus } from '../shared/protocol.js'
import { KitBadge, KitBanner, KitButton, KitEmpty, KitField, KitList, KitSelect } from '../shared/kit.js'
import { post, type RequestFn } from '../shared/service-client.js'

interface Entry { name: string; type: 'file' | 'dir'; size?: number }

function joinPath(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, '')}/${name}`
}

function sizeLabel(bytes?: number): string | undefined {
  if (bytes === undefined) return undefined
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** One row of the file tree. A real `<button>` with the kit's row classes —
 *  the host's own row look, plus the semantics a clickable `<div>` never had. */
function TreeRow(props: { icon: ReactNode; name: string; meta?: string; selected?: boolean; depth?: number; onClick: () => void }) {
  return (
    <button
      type="button"
      className="oc-sdk oc-sdk-row"
      aria-selected={props.selected ? 'true' : 'false'}
      style={props.depth ? { paddingLeft: 8 + props.depth * 12 } : undefined}
      title={props.name}
      onClick={props.onClick}
    >
      <span className="oc-icon oc-sdk-muted">{props.icon}</span>
      <span className="oc-sdk-row-main">
        <span className="oc-sdk-row-title">{props.name}</span>
      </span>
      {props.meta && <span className="oc-sdk-row-meta">{props.meta}</span>}
    </button>
  )
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
  const [addRootOpen, setAddRootOpen] = useState(false)
  const [rootDraft, setRootDraft] = useState('')
  const [commitOpen, setCommitOpen] = useState(false)
  const [commitDraft, setCommitDraft] = useState('')

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

  const fetchDir = useCallback(async (dir: string) => {
    setErr('')
    try {
      const r = await post<{ entries: Entry[] }>(request, '/fs/list', { path: dir })
      setEntries(r.entries)
    } catch (e) {
      setEntries([])
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [request])

  // Navigation is `setCwd`; the fetch follows from it. That keeps the tree from
  // double-listing a directory the user just clicked into.
  useEffect(() => { if (cwd) void fetchDir(cwd) }, [cwd, fetchDir])

  const openFile = useCallback(async (path: string, size?: number) => {
    if (size !== undefined && size > 512 * 1024) {
      setErr('文件超过 512 KB——为避免 ssh 传输卡顿，面板不支持直接编辑超大文件')
      return
    }
    setErr('')
    try {
      const r = await post<{ content: string; encoding: string }>(request, '/fs/read', { path })
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
      await post(request, '/fs/write', { path: openPath, content: text })
      setDirty(false)
      setMsg('已保存（原文件备份为 .bak）')
      setTimeout(() => setMsg(''), 2500)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }, [openPath, request, text])

  const refreshGit = useCallback(async () => {
    if (!root) return
    setErr('')
    try {
      const st = await post<{ branch?: string; entries?: Array<{ x: string; y: string; path: string }>; error?: string }>(request, '/git/status', { path: root })
      if (st.error) { setGitBranch(''); setGitEntries([]); return }
      setGitBranch(st.branch ?? '')
      setGitEntries(st.entries ?? [])
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }, [request, root])

  useEffect(() => { void refreshGit() }, [refreshGit])

  const showDiff = useCallback(async () => {
    setErr('')
    try {
      const r = await post<{ diff: string }>(request, '/git/diff', { path: root })
      setDiff(r.diff || '(无差异)')
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }, [request, root])

  const stageAll = useCallback(async () => {
    setErr('')
    try {
      await post(request, '/git/stage', { path: root })
      await refreshGit()
      setMsg('已暂存全部')
      setTimeout(() => setMsg(''), 2000)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }, [request, root, refreshGit])

  const commit = useCallback(async () => {
    const message = commitDraft.trim()
    if (!message) return
    setErr('')
    try {
      const r = await post<{ committed?: boolean }>(request, '/git/commit', { path: root, message })
      setMsg(r.committed ? '已提交' : '没有可提交的变更')
      setCommitOpen(false)
      setCommitDraft('')
      setDiff('')
      await refreshGit()
      setTimeout(() => setMsg(''), 2500)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }, [commitDraft, request, root, refreshGit])

  const addRoot = useCallback(async () => {
    const line = rootDraft.trim()
    if (!line) return
    // Roots are POSIX paths ON THE CONTROLLED HOST — a Windows panel user
    // typing C:\... is the most predictable mistake; surface it instead of
    // silently ignoring the input.
    if (!line.startsWith('/')) {
      setErr('工作区根必须是被控机（Linux）上的绝对路径，以 / 开头 — Windows 盘符路径（C:\\…）不在此处使用。')
      return
    }
    setErr('')
    const next = [...new Set([...roots, line.replace(/\/+$/, '')])]
    setRoots(next)
    setAddRootOpen(false)
    setRootDraft('')
    await props.onRootsChanged?.(next)
  }, [props.onRootsChanged, rootDraft, roots])

  if (status.tunnel !== 'up') {
    return (
      <div className="oc-page">
        <KitEmpty title="需要先建立隧道" body="远程工作区通过 ssh 隧道读写被控机的文件与 git——先在「连接」页连上档案。" />
      </div>
    )
  }

  const parentDir = cwd ? (cwd.split('/').slice(0, -1).join('/') || '/') : ''

  return (
    <div className="oc-page">
      <div className="oc-row">
        <strong>远程工作区</strong>
        <KitBadge label={activeProfile?.name ?? status.profileId ?? ''} tone="primary" />
        {gitBranch && <KitBadge label={gitBranch} tone="neutral" />}
        <span className="oc-push" />
        <KitSelect
          value={root || null}
          options={roots.map((r) => ({ id: r, label: r }))}
          onChange={(id) => { setRoot(id); setCwd(id); setOpenPath(''); setText(''); setDiff('') }}
          placeholder="（未配置工作区根）"
        />
        <KitButton label="+ 根目录" variant="outline" size="sm" onClick={() => setAddRootOpen((v) => !v)} />
        <KitButton label="刷新" variant="ghost" size="sm" onClick={() => void fetchDir(cwd)} />
      </div>

      {msg && <KitBanner tone="success" title={msg} />}
      {err && <KitBanner tone="error" title="操作失败" body={err} />}

      {addRootOpen && (
        <div className="oc-card">
          <KitField
            label="被控机上的工作区绝对路径"
            value={rootDraft}
            onChange={setRootDraft}
            placeholder="/home/user/project"
            helper="必须是被控机（Linux）上的绝对路径，以 / 开头。"
            mono
            error={rootDraft.trim() !== '' && !rootDraft.trim().startsWith('/') ? '需要以 / 开头的 POSIX 路径' : undefined}
          />
          <div className="oc-row">
            <KitButton label="添加" size="sm" disabled={!rootDraft.trim()} onClick={() => void addRoot()} />
            <KitButton label="取消" variant="ghost" size="sm" onClick={() => { setAddRootOpen(false); setRootDraft('') }} />
          </div>
        </div>
      )}

      <div className="oc-row oc-row-nowrap" style={{ alignItems: 'flex-start', gap: 12 }}>
        {/* file tree */}
        <div className="oc-card" style={{ flex: '0 0 280px', padding: 6 }}>
          <div className="oc-sdk-mono oc-sdk-muted oc-xs oc-truncate" title={cwd}>{cwd || '—'}</div>
          {cwd && cwd !== '/' && (
            <TreeRow icon={<RiFolderOpenLine size={14} />} name="上级目录" meta=".." onClick={() => setCwd(parentDir)} />
          )}
          {entries.map((e) => (
            <TreeRow
              key={e.name}
              icon={e.type === 'dir' ? <RiFolderLine size={14} /> : <RiFileLine size={14} />}
              name={e.name}
              meta={sizeLabel(e.size)}
              selected={e.type === 'file' && joinPath(cwd, e.name) === openPath}
              onClick={() => (e.type === 'dir' ? setCwd(joinPath(cwd, e.name)) : void openFile(joinPath(cwd, e.name), e.size))}
            />
          ))}
          {entries.length === 0 && <div className="oc-sdk-muted oc-xs" style={{ padding: 8 }}>（空目录）</div>}
        </div>

        {/* editor */}
        <div className="oc-col oc-grow">
          <div className="oc-row">
            <span className="oc-sdk-mono oc-sdk-muted oc-xs oc-truncate oc-grow" title={openPath}>{openPath || '未打开文件'}</span>
            {dirty && <KitBadge label="未保存" tone="warning" />}
            <KitButton label="保存" size="sm" disabled={!openPath || !dirty} onClick={() => void save()} />
          </div>
          <KitField
            value={text}
            onChange={(v) => { setText(v); setDirty(true) }}
            multiline
            rows={16}
            mono
            placeholder="点左侧文件打开；保存 = 远端 mktemp → 原文件备份 .bak → 原子 mv"
          />
        </div>
      </div>

      {/* git panel */}
      <div className="oc-card">
        <div className="oc-row">
          <strong>Git</strong>
          <RiGitBranchLine size={14} className="oc-icon" />
          <span className="oc-sdk-mono oc-sdk-muted oc-xs oc-grow oc-truncate" title={root}>{root || '（未配置）'}</span>
          <KitButton label="状态" variant="ghost" size="sm" onClick={() => void refreshGit()} />
          <KitButton label="diff" variant="ghost" size="sm" onClick={() => void showDiff()} />
          <KitButton label="暂存全部" variant="outline" size="sm" onClick={() => void stageAll()} />
          <KitButton label="提交" size="sm" disabled={gitEntries.length === 0} onClick={() => setCommitOpen((v) => !v)} />
        </div>

        {commitOpen && (
          <div className="oc-row">
            <div className="oc-grow">
              <KitField
                value={commitDraft}
                onChange={setCommitDraft}
                placeholder="提交信息"
                helper="提交 = 远端 git commit -m <信息>（仅已暂存的变更）。"
              />
            </div>
            <KitButton label="提交" size="sm" disabled={!commitDraft.trim()} onClick={() => void commit()} />
            <KitButton label="取消" variant="ghost" size="sm" onClick={() => { setCommitOpen(false); setCommitDraft('') }} />
          </div>
        )}

        {gitEntries.length > 0 && (
          <KitList
            items={gitEntries.slice(0, 20).map((e, i) => ({ id: `${e.path}-${i}`, title: e.path, leading: `${e.x}${e.y}` }))}
            onSelect={() => { /* status rows are informational */ }}
          />
        )}
        {gitEntries.length > 20 && <div className="oc-sdk-muted oc-xs">…另有 {gitEntries.length - 20} 个变更</div>}
        {diff && <pre className="oc-pre">{diff}</pre>}
      </div>
    </div>
  )
}
