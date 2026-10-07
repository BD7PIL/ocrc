// components/pane/BrowserPanel.tsx — the browser home (ZCode browser pane
// register, sidecar edition): screenshot polling + percent-coordinate click
// interaction + navigate/back/reload. The headless chromium lives on the
// host (CDP sidecar) — nothing renders in an iframe.
import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, RefreshCw } from 'lucide-react'
import { api } from '$lib/api/client.js'

export function BrowserPanel() {
  const [shot, setShot] = useState<string | null>(null)
  const [url, setUrl] = useState('')
  const [shownUrl, setShownUrl] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const liveRef = useRef(true)

  const pull = () => {
    void api.browserState().then((r) => {
      if (!liveRef.current) return
      if ('error' in r && r.error) { setError(r.error); return }
      setError('')
      if ('screenshot' in r) {
        setShot(`data:image/png;base64,${r.screenshot}`)
        setShownUrl('url' in r && r.url ? r.url : '')
      }
    }).catch(() => {})
  }

  useEffect(() => {
    pull()
    pollRef.current = setInterval(() => { if (document.hidden !== true) pull() }, 2000)
    return () => { liveRef.current = false; if (pollRef.current) clearInterval(pollRef.current) }
  }, [])

  const nav = (u: string) => {
    setBusy(true)
    void api.browserNavigate(u).then(pull).finally(() => setBusy(false))
  }
  const act = (p: Promise<unknown>) => {
    void p.then(pull)
  }

  return (
    <div className="flex h-full flex-col p-2">
      <div className="mb-1.5 flex items-center gap-1">
        <button type="button" className="wb-tool" title="后退" onClick={() => act(api.browserBack())}><ArrowLeft size={13} /></button>
        <button type="button" className="wb-tool" title="刷新" onClick={() => act(api.browserNavigate(shownUrl || url))}><RefreshCw size={12} /></button>
        <input
          className="mono min-w-0 flex-1 rounded-[9px] px-2.5 py-1 outline-none"
          style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: 'var(--ui-2xs)' }}
          placeholder="输入 URL 回车导航"
          value={url || shownUrl}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') nav(url) }}
        />
        <button
          type="button"
          className="rounded-[6px] px-2 py-1 shrink-0"
          style={{ background: 'var(--accent)', color: 'var(--accent-ink)', fontSize: 'var(--ui-2xs)' }}
          disabled={busy}
          onClick={() => nav(url)}
        >
          GO
        </button>
      </div>

      {error && (
        <p className="mb-1.5 rounded-[6px] px-2 py-1.5" style={{ background: 'var(--bg-input)', color: 'var(--warn)', fontSize: 'var(--ui-2xs)' }}>
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-hidden rounded-[9px]" style={{ border: '1px solid var(--border-2)', background: '#101010' }}>
        {shot ? (
          // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
          <img
            src={shot}
            alt="浏览器画面"
            className="w-full select-none"
            draggable={false}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              const xPct = ((e.clientX - rect.left) / rect.width) * 100
              const yPct = ((e.clientY - rect.top) / rect.height) * 100
              act(api.browserClick(xPct, yPct))
            }}
            onWheel={(e) => {
              const pct = (e.deltaY / 400) * 100
              act(api.browserScroll(Math.max(-80, Math.min(80, pct))))
            }}
          />
        ) : (
          <p className="p-4 text-center" style={{ fontSize: 'var(--ui-sm)', color: 'var(--text-3)' }}>
            {error || '输入 URL 开始浏览'}
          </p>
        )}
      </div>
      <p className="mt-1 text-center" style={{ fontSize: 'var(--ui-2xs)', color: 'var(--text-4)' }}>
        点击画面 = 点击该处 · 滚轮 = 滚动 · host 侧车无头浏览器
      </p>
    </div>
  )
}
