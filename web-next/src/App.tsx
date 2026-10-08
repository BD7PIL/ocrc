// App — the shell root: auth gate, connection boot, keyboard dispatch, the
// three-pane layout with routes, and the global overlays (command center,
// new-session dialog, PairGate).
// N-series: `/z/*` mounts the vendored ZCode fork (see zcode/) in parallel —
// `/` stays the rc.2 panel until the fork reaches parity.
import { lazy, Suspense, useEffect } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router'
import { ShellLayout } from './components/shell/ShellLayout.js'
import { CommandCenter } from './components/shell/CommandCenter.js'
import { NewSessionDialog } from './components/shell/NewSessionDialog.js'
import { PairGate } from './components/shell/PairGate.js'
import { ChannelsDialog } from './components/shell/ChannelsDialog.js'
import { HomePage } from './pages/HomePage.js'
import { SessionPage } from './pages/SessionPage.js'
import { AutomationsPage } from './pages/AutomationsPage.js'
import { SettingsPage } from './pages/SettingsPage.js'
import { TokenGallery } from './pages/TokenGallery.js'
import { ShareLanding } from './pages/ShareLanding.js'
import { bootConnection } from './lib/ws/boot.js'
import { registerCommands } from '$lib/shortcuts/commands.js'
import { useAppKeyboard } from './hooks/useAppKeyboard.js'
import { useAuthStore } from '$lib/auth.js'
import { useUi } from './lib/stores/ui.js'

const ZCodeApp = lazy(() => import('./zcode/ZCodeApp.js').then((m) => ({ default: m.ZCodeApp })))

export default function App() {
  // 分享落地页在鉴权门外：分享码即能力凭证，未配对设备也能读
  const shareMatch = typeof location !== 'undefined' ? location.pathname.match(/^\/share\/([A-Za-z0-9_-]+)\/?$/) : null
  // N 系列：/z/* 是 vendored ZCode fork 的专属路由——旧面板的全局键盘、
  // 浮层与 WS 引导全部不挂载，避免两套快捷键互相截获（Ctrl+K 实测被旧
  // 命令面板抢走）。
  const isZRoute = typeof location !== 'undefined' && /\/z(\/|$)/.test(location.pathname)

  const authStatus = useAuthStore((s) => s.status)

  useEffect(() => {
    if (isZRoute) return
    bootConnection()
  }, [isZRoute])

  useEffect(() => {
    if (isZRoute) return
    registerCommands([
      { id: 'session.new', label: '新建任务', keys: 'Ctrl+N', run: () => useUi.getState().setNewSessionOpen(true) },
      { id: 'shell.search', label: '搜索', keys: 'Ctrl+K', run: () => useUi.getState().setPalette(true) },
      { id: 'shell.toggleLeft', label: '折叠 / 展开左栏', keys: 'Ctrl+B', run: () => useUi.getState().toggleLeftPanel() },
      {
        id: 'shell.escape', label: '关闭浮层', keys: 'Escape',
        enabled: () => useUi.getState().paletteOpen || useUi.getState().newSessionOpen,
        run: () => {
          const s = useUi.getState()
          if (s.paletteOpen) s.setPalette(false)
          if (s.newSessionOpen) s.setNewSessionOpen(false)
        },
      },
    ])
  }, [isZRoute])

  if (!isZRoute) useAppKeyboard()

  const basename = typeof location !== 'undefined' && location.pathname.startsWith('/next') ? '/next' : ''
  // 分享落地页在鉴权门外：分享码即能力凭证，未配对设备也能读
  if (shareMatch) {
    return <ShareLanding code={shareMatch[1]!} />
  }

  // 鉴权门对两个壳是**同一个**：/z/ 此前自己造了一套「粘 token」的门，和旧壳的
  // 配对协议（#pair= 一次性令牌 / QR）机制与视觉都不同——一套产品两套凭证体验是错的。
  // 现在 / 与 /z/* 都走 lib/auth.ts 的状态机 + 同一个 PairGate；`#token=` 采纳、
  // `#pair=` 换取、401 降级全在同一处（模块初始化时执行，与路由无关）。
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
        {/* N-series fork: the real ZCode UI on ocrc services */}
        <Route path="/z/*" element={<Suspense fallback={null}><ZCodeApp /></Suspense>} />
        <Route element={<ShellLayout />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/session/:id" element={<SessionPage />} />
          <Route path="/automations" element={<AutomationsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/dev/tokens" element={<TokenGallery />} />
          <Route path="*" element={<HomePage />} />
        </Route>
      </Routes>
      {!isZRoute && (
        <>
          <CommandCenter />
          <NewSessionDialog />
          <ChannelsDialog />
        </>
      )}
    </BrowserRouter>
  )
}
