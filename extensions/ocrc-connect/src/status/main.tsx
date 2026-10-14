import { useEffect, useState } from 'react'
import { connectHost } from '@openchamber/sdk'

/** Work Status section — compact tunnel/engine health via the service bridge. */
export function StatusMain() {
  const [line, setLine] = useState('ocrc 隧道：查询中…')
  const [tone, setTone] = useState<'ok' | 'err' | ''>('')
  useEffect(() => {
    let alive = true
    let host: Awaited<ReturnType<typeof connectHost>> | undefined
    void (async () => {
      try { host = connectHost() } catch { /* bridge never came up */ }
    })()
    const tick = async () => {
      if (!host) { setLine('ocrc 隧道：服务未运行'); setTone('err'); return }
      try {
        const r = await host.serviceRequest({ method: 'GET', path: '/status' })
        if (!alive) return
        const body = JSON.parse(r.body) as { status: { tunnel: string; engine: string } }
        const t = body.status
        setLine(`ocrc 隧道：${t.tunnel === 'up' ? `已连 · 引擎${t.engine === 'reachable' ? '可达' : '不可达'}` : t.tunnel === 'starting' ? '建立中' : '未连'}`)
        setTone(t.tunnel === 'up' ? (t.engine === 'reachable' ? 'ok' : 'err') : t.tunnel === 'starting' ? '' : 'err')
      } catch {
        if (alive) { setLine('ocrc 隧道：服务未运行'); setTone('err') }
      }
    }
    void tick()
    const t = setInterval(() => void tick(), 10_000)
    return () => { alive = false; clearInterval(t) }
  }, [])
  return (
    <div style={{ padding: '10px 12px' }}>
      <span className={`pill ${tone}`}>{line}</span>
    </div>
  )
}
