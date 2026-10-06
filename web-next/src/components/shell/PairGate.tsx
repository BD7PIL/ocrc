// components/shell/PairGate.tsx — the unauthenticated landing (M11 register,
// minimal M1 form: paste the pairing link shown on the host / old shell; the
// live-QR surface stays in the Svelte shell until M4).
import { useState } from 'react'
import { exchangePairLink, useAuthStore } from '$lib/auth.js'

export function PairGate() {
  const pairHint = useAuthStore((s) => s.pairHint)
  const [link, setLink] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setBusy(true)
    setError('')
    const msg = await exchangePairLink(link)
    setBusy(false)
    if (msg) setError(msg)
  }

  return (
    <div className="fixed inset-0 z-[var(--z-gate)] flex items-center justify-center" style={{ background: 'var(--bg)' }}>
      <div className="w-[min(92vw,400px)] rounded-[14px] p-6" style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)' }}>
        <div className="mb-4 flex items-center gap-2.5">
          <span className="inline-block size-3.5 rounded-full" style={{ background: 'var(--accent)' }} aria-hidden />
          <span style={{ fontSize: 'var(--ui-lg)', color: 'var(--text)' }}>配对 ocrc</span>
        </div>
        <p className="mb-4" style={{ fontSize: 'var(--ui-sm)', color: 'var(--text-2)' }}>
          在主机上刷新配对二维码（旧壳或 <code className="mono">ocrc pair</code>），把
          <code className="mono"> #pair=…</code> 链接粘贴到这里完成配对。
        </p>
        <input
          className="mb-3 w-full rounded-[9px] px-3 py-2 outline-none"
          style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: 'var(--text-mobile-input-safe)' }}
          placeholder="粘贴配对链接或 pending token"
          value={link}
          onChange={(e) => setLink(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit() }}
        />
        {(error || pairHint) && (
          <p className="mb-3" style={{ fontSize: 'var(--ui-sm)', color: 'var(--err)' }}>{error || pairHint}</p>
        )}
        <button
          type="button"
          className="w-full rounded-[9px] py-2 disabled:opacity-50"
          style={{ background: 'var(--accent)', color: 'var(--accent-ink)', fontSize: 'var(--ui-sm)' }}
          disabled={busy || !link.trim()}
          onClick={() => void submit()}
        >
          {busy ? '配对中…' : '配对'}
        </button>
      </div>
    </div>
  )
}
