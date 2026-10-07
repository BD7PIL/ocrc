// pages/ShareLanding.tsx — the PUBLIC read-only transcript page (ZCode
// share viewer register). Rendered OUTSIDE the auth gate: the share code IS
// the capability. Fetches the public snapshot and renders the same CardView
// pipeline, read-only.
import { useEffect, useState } from 'react'
import type { StructuredCard } from '$lib/api/types.js'
import { CardView } from '../components/cards/CardView.js'

interface SharePayload {
  title: string
  createdAt: number
  cards: StructuredCard[]
}

export function ShareLanding({ code }: { code: string }) {
  const [data, setData] = useState<SharePayload | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    void fetch(`/api/share/${encodeURIComponent(code)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status === 404 ? '分享不存在或已撤销' : `加载失败 (${r.status})`))))
      .then(setData)
      .catch((e) => setError((e as Error).message))
  }, [code])

  return (
    <div style={{ background: 'var(--bg)', minHeight: '100vh' }}>
      <header
        className="sticky top-0 z-10 flex items-center gap-3 border-b px-5 py-3"
        style={{ background: 'var(--bg-panel)', borderColor: 'var(--border)' }}
      >
        <span className="inline-block size-3.5 rounded-full" style={{ background: 'var(--accent)' }} aria-hidden />
        <span style={{ fontSize: 'var(--ui-lg)', color: 'var(--text)' }}>ocrc 分享</span>
        <span className="label">只读快照</span>
        <span className="mono ml-auto" style={{ fontSize: 'var(--ui-2xs)', color: 'var(--text-4)' }}>
          {data ? new Date(data.createdAt).toLocaleString() : ''}
        </span>
      </header>
      <main className="mx-auto max-w-3xl p-5">
        {error && (
          <p className="rounded-[9px] px-4 py-3" style={{ background: 'var(--bg-elev)', border: '1px solid var(--err)', color: 'var(--err)', fontSize: 'var(--ui-sm)' }}>
            {error}
          </p>
        )}
        {!data && !error && (
          <p style={{ fontSize: 'var(--ui-sm)', color: 'var(--text-3)' }}>加载分享快照…</p>
        )}
        {data && (
          <>
            <h1 className="mb-4" style={{ fontSize: 'var(--ui-lg)', color: 'var(--text)' }}>{data.title || '（未命名会话）'}</h1>
            <div className="flex flex-col gap-3">
              {data.cards.filter((c) => c.kind !== 'thinking' && c.kind !== 'think-stream').map((c, i) => (
                <div key={c.id ?? i} className="cv-card">
                  <CardView card={c} />
                </div>
              ))}
            </div>
            <p className="mt-8 text-center" style={{ fontSize: 'var(--ui-2xs)', color: 'var(--text-4)' }}>
              快照内容定格于分享时刻 · 由 ocrc 生成
            </p>
          </>
        )}
      </main>
    </div>
  )
}
