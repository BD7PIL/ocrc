// App — the ZCode fork shell is THE product surface (rc.3 cutover).
// `/` mounts the vendored ZCode UI on ocrc services; `/z/*` stays as the
// bookmark-compatible alias (same component). The rc.2 console (Home/Session/
// Automations/Settings/TokenGallery + command center & dialogs) is retired —
// its palette lives on in styles/persimmon-theme.css.
//
// Outside the shell: `/share/:code` renders the public landing page in front
// of auth (the share code IS the capability), and the shared auth state machine
// drives the PairGate for both surfaces.
import { lazy, Suspense } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router'
import { PairGate } from './components/shell/PairGate.js'
import { ShareLanding } from './pages/ShareLanding.js'
import { useAuthStore } from '$lib/auth.js'

const ZCodeApp = lazy(() => import('./zcode/ZCodeApp.js').then((m) => ({ default: m.ZCodeApp })))

export default function App() {
  // 分享落地页在鉴权门外：分享码即能力凭证，未配对设备也能读
  const shareMatch = typeof location !== 'undefined' ? location.pathname.match(/^\/share\/([A-Za-z0-9_-]+)\/?$/) : null

  const authStatus = useAuthStore((s) => s.status)

  const basename = typeof location !== 'undefined' && location.pathname.startsWith('/next') ? '/next' : ''
  if (shareMatch) {
    return <ShareLanding code={shareMatch[1]!} />
  }

  if (authStatus === 'booting') {
    return (
      <div className="flex h-full items-center justify-center" style={{ background: 'var(--bg)' }}>
        <span className="ocrc-pulse-dot inline-block size-3 rounded-full" style={{ background: 'var(--accent)' }} aria-label="启动中" />
      </div>
    )
  }
  if (authStatus === 'pairing' || authStatus === 'rejected') {
    return <PairGate />
  }

  return (
    <BrowserRouter basename={basename}>
      <Routes>
        {/* 唯一落点：/ 与 /z/*（含旧书签路径）都进 ZCode 壳 */}
        <Route path="*" element={<Suspense fallback={null}><ZCodeApp /></Suspense>} />
      </Routes>
    </BrowserRouter>
  )
}
