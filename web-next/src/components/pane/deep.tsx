// components/pane/deep.tsx — the M3-2 deep panels: file browse + viewer, git
// (status + lazy per-file patch), tool output page, subagent live transcript.
// Session directory comes from the session summary; APIs are session-scoped.
import { useEffect, useRef, useState } from 'react'
import { ArrowUp, File as FileIcon, Folder, GitBranch } from 'lucide-react'
import { api, type FileEntryRow } from '$lib/api/client.js'
import { ansiToHtml } from '$lib/ansi.js'
import { MarkdownView } from '../markdown/MarkdownView.js'
import { CardView } from '../cards/CardView.js'
import { useFeeds, cardsOf } from '$lib/stores/feeds.js'
import { peekSession } from '$lib/ws/boot.js'

function Empty({ text }: { text: string }) {
  return <p className="p-4 text-center" style={{ fontSize: 'var(--ui-sm)', color: 'var(--text-3)' }}>{text}</p>
}

function useSessionDirectory(sessionId: string | null): string | undefined {
  const [dir, setDir] = useState<string | undefined>()
  useEffect(() => {
    if (!sessionId) return setDir(undefined)
    void import('$lib/stores/sessions.js').then(({ useSessions }) => {
      const s = useSessions.getState().list.find((x) => x.id === sessionId)
      setDir(s?.directory)
    })
  }, [sessionId])
  return dir
}

// ── 文件浏览（browse 目录游走；点文件开查看器页签）───────────────────────
export function FileBrowse({ directory, onOpenFile }: { sessionId?: string; directory: string | undefined; onOpenFile: (path: string) => void }) {
  const [cwd, setCwd] = useState<string>('')
  const [entries, setEntries] = useState<FileEntryRow[]>([])
  const [error, setError] = useState('')

  useEffect(() => { setCwd(directory ?? '') }, [directory])
  useEffect(() => {
    if (!directory || !cwd) return
    void api.browse(directory, cwd).then((r) => { setEntries(r.files ?? []); setError('') }).catch((e) => setError((e as Error).message))
  }, [directory, cwd])

  if (!directory) return <Empty text="会话没有工作目录" />
  const up = cwd && cwd !== directory
  return (
    <div className="p-2">
      <div className="mb-1.5 flex items-center gap-1">
        <button
          type="button"
          className="flex items-center gap-1 rounded-[6px] px-1.5 py-1 text-left transition-colors disabled:opacity-30"
          style={{ fontSize: 'var(--ui-2xs)', color: 'var(--text-3)' }}
          disabled={!up}
          onClick={() => setCwd(cwd.slice(0, cwd.lastIndexOf('/')) || directory)}
        >
          <ArrowUp size={11} /> 上一级
        </button>
        <span className="mono min-w-0 flex-1 truncate" style={{ fontSize: 'var(--ui-2xs)', color: 'var(--text-4)' }} title={cwd}>{cwd}</span>
      </div>
      {error && <p style={{ fontSize: 'var(--ui-xs)', color: 'var(--err)' }}>{error}</p>}
      <div className="flex flex-col">
        {entries.map((e) => (
          <button
            key={e.path}
            type="button"
            className="flex items-center gap-2 rounded-[6px] px-2 py-1.5 text-left transition-colors"
            style={{ fontSize: 'var(--ui-sm)', color: e.type === 'directory' ? 'var(--text)' : 'var(--text-2)' }}
            onClick={() => (e.type === 'directory' ? setCwd(e.path) : onOpenFile(e.path))}
          >
            {e.type === 'directory' ? <Folder size={13} strokeWidth={1.75} style={{ color: 'var(--text-3)', flexShrink: 0 }} /> : <FileIcon size={13} strokeWidth={1.75} style={{ color: 'var(--text-4)', flexShrink: 0 }} />}
            <span className="min-w-0 flex-1 truncate">{e.name}</span>
          </button>
        ))}
        {entries.length === 0 && !error && <Empty text="（空目录）" />}
      </div>
    </div>
  )
}

// ── 文件查看器页签 ─────────────────────────────────────────────────────────
export function FileViewer({ sessionId, directory, path }: { sessionId: string; directory: string | undefined; path: string }) {
  const [content, setContent] = useState<string | null>(null)
  const [type, setType] = useState<string>('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const realDir = directory ?? useSessionDirectory(sessionId)

  useEffect(() => {
    if (!realDir || !path) return
    void api.fileContent(realDir, path).then((r) => { setContent(r.content); setType(r.type) }).catch((e) => setError((e as Error).message))
  }, [realDir, path])

  const isMd = type === 'markdown' || path.endsWith('.md')
  const truncated = (content?.length ?? 0) > 200_000

  return (
    <div className="p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="mono min-w-0 flex-1 truncate" style={{ fontSize: 'var(--ui-2xs)', color: 'var(--text-3)' }} title={path}>{path}</span>
        <button
          type="button"
          style={{ fontSize: 'var(--ui-2xs)', color: copied ? 'var(--ok)' : 'var(--text-3)' }}
          onClick={() => { void navigator.clipboard.writeText(content ?? '').then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }) }}
        >
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      {error && <p style={{ fontSize: 'var(--ui-sm)', color: 'var(--err)' }}>{error}</p>}
      {!content && !error && <Empty text="加载中…" />}
      {content !== null && (
        truncated
          ? <pre className="mono overflow-x-auto rounded-[9px] p-3" style={{ background: 'var(--bg-code)', fontSize: 'var(--ui-2xs)', color: 'var(--toolout)' }}>{content.slice(0, 200_000)}…（截断）</pre>
          : isMd
            ? <MarkdownView text={content} />
            : <pre className="mono overflow-x-auto rounded-[9px] p-3" style={{ background: 'var(--bg-code)', fontSize: 'var(--ui-2xs)', color: 'var(--text)' }}>{content}</pre>
      )}
    </div>
  )
}

// ── Git：分支 + 每文件 ±行 + 懒加载 patch ──────────────────────────────────
export function GitPanel({ sessionId }: { sessionId: string | null }) {
  const [data, setData] = useState<{ branch?: string; status: Array<{ file: string; additions?: number; deletions?: number; status?: string }> } | null>(null)
  const [openFile, setOpenFile] = useState<string | null>(null)
  const [patch, setPatch] = useState<string>('')
  const [loadingDiff, setLoadingDiff] = useState(false)

  useEffect(() => {
    if (!sessionId) return
    let alive = true
    void api.vcs(sessionId).then((v) => { if (alive) setData(v) }).catch(() => { if (alive) setData({ status: [] }) })
    return () => { alive = false }
  }, [sessionId])

  if (!sessionId) return <Empty text="Git 面板跟随当前会话" />
  if (!data) return <Empty text="加载中…" />
  if (!data.branch && data.status.length === 0) return <Empty text="这里没有 Git 仓库（或没有变更）" />

  const openDiff = (file: string) => {
    if (openFile === file) { setOpenFile(null); return }
    setOpenFile(file)
    setPatch('')
    setLoadingDiff(true)
    void api.vcsDiff(sessionId, file).then((r) => setPatch(r.patch ?? '')).catch(() => setPatch('（diff 获取失败）')).finally(() => setLoadingDiff(false))
  }

  return (
    <div className="p-3">
      {data.branch && (
        <p className="mb-2 flex items-center gap-1.5" style={{ fontSize: 'var(--ui-sm)', color: 'var(--text-2)' }}>
          <GitBranch size={13} strokeWidth={1.75} style={{ color: 'var(--text-3)' }} /> {data.branch}
        </p>
      )}
      <div className="flex flex-col gap-0.5">
        {data.status.map((f) => (
          <div key={f.file}>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left transition-colors"
              style={{ fontSize: 'var(--ui-sm)' }}
              onClick={() => openDiff(f.file)}
            >
              <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--text-2)' }} title={f.file}>{f.file.split('/').pop()}</span>
              {f.additions ? <span style={{ fontSize: 'var(--ui-2xs)', color: 'var(--ok)' }}>+{f.additions}</span> : null}
              {f.deletions ? <span style={{ fontSize: 'var(--ui-2xs)', color: 'var(--err)' }}>−{f.deletions}</span> : null}
            </button>
            {openFile === f.file && (
              loadingDiff
                ? <p className="px-2 py-1" style={{ fontSize: 'var(--ui-2xs)', color: 'var(--text-4)' }}>加载 diff…</p>
                : <pre className="diff-patch">{patch.split('\n').map((l, i) => <div key={i} className={l.startsWith('+') ? 'add' : l.startsWith('-') ? 'rem' : ''}>{l || ' '}</div>)}</pre>
            )}
          </div>
        ))}
        {data.status.length === 0 && <Empty text="工作区干净" />}
      </div>
    </div>
  )
}

// ── 工具输出页签（messageRaw → partId 匹配；运行中 2s 轮询）────────────────
export function ToolOutput({ sessionId, messageId, partId }: { sessionId: string; messageId: string; partId: string }) {
  const [text, setText] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = () => {
      void api.messageRaw(sessionId, messageId).then((r) => {
        if (!alive) return
        const part = (r.parts ?? []).find((p) => p.id === partId || p.callID === partId)
        const output = part?.state?.output ?? part?.output ?? (typeof part?.text === 'string' ? part.text : null)
        const isRunning = part?.state?.status === 'running' || part?.state?.status === 'pending'
        setText(output != null ? String(output) : '（无输出）')
        setRunning(!!isRunning)
        if (isRunning) timer = setTimeout(tick, 2000)
      }).catch(() => { if (alive) setText('（输出获取失败）') })
    }
    tick()
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [sessionId, messageId, partId])

  return (
    <div className="p-3">
      <div className="mb-2 flex items-center gap-2">
        {running && <span className="ocrc-pulse-dot size-1.5 rounded-full" style={{ background: 'var(--accent)' }} aria-hidden />}
        <span style={{ fontSize: 'var(--ui-2xs)', color: 'var(--text-4)' }}>{running ? '运行中' : '输出'}</span>
      </div>
      {text === null
        ? <Empty text="加载中…" />
        : <pre className="mono overflow-x-auto rounded-[9px] p-3" style={{ background: 'var(--bg-code)', fontSize: 'var(--ui-2xs)', color: 'var(--text)', maxHeight: '70vh', overflowY: 'auto' }} dangerouslySetInnerHTML={{ __html: ansiToHtml(text) }} />}
    </div>
  )
}

// ── 子会话实时转写（peek 订阅：不 prune、不改 viewedId）───────────────────
export function SubagentTranscript({ childId }: { childId: string }) {
  const feed = useFeeds((s) => s.feeds[childId])
  const cards = cardsOf(feed)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => { peekSession(childId) }, [childId])
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [cards.length])

  if (!feed || cards.length === 0) return <Empty text="子会话转写加载中…" />
  return (
    <div ref={scrollRef} className="max-h-full overflow-y-auto p-3">
      <div className="flex flex-col gap-2.5">
        {cards.map((c) => <CardView key={c.id} card={c} />)}
      </div>
    </div>
  )
}
