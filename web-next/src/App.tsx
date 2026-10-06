// App — the shell root: auth gate, connection boot, keyboard dispatch, the
// three-pane layout with routes, and the global overlays (command center,
// new-session dialog, PairGate).
import { useEffect } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router'
import { ShellLayout } from './components/shell/ShellLayout.js'
import { CommandCenter } from './components/shell/CommandCenter.js'
import { NewSessionDialog } from './components/shell/NewSessionDialog.js'
import { PairGate } from './components/shell/PairGate.js'
import { ChannelsDialog } from './components/shell/ChannelsDialog.js'
import { HomePage } from './pages/HomePage.js'
import { SessionPage } from './pages/SessionPage.js'
import { AutomationsPage } from './pages/AutomationsPage.js'
import { TokenGallery } from './pages/TokenGallery.js'
import { bootConnection } from './lib/ws/boot.js'
import { registerCommands } from '$lib/shortcuts/commands.js'
import { useAppKeyboard } from './hooks/useAppKeyboard.js'
import { useAuthStore } from '$lib/auth.js'
import { useUi } from './lib/stores/ui.js'

export default function App() {
  const authStatus = useAuthStore((s) => s.status)

  useEffect(() => {
    bootConnection()
  }, [])

  useEffect(() => {
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
  }, [])

  useAppKeyboard()

  if (authStatus === 'booting') {
    return (
      <div className="flex h-full items-center justify-center" style={{ background: 'var(--bg)' }}>
        <span className="ocrc-pulse-dot inline-block size-3 rounded-full" style={{ background: 'var(--accent)' }} aria-label="启动中" />
      </div>
    )
  }

  return (
    <BrowserRouter basename="/next">
      <Routes>
        <Route element={<ShellLayout />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/session/:id" element={<SessionPage />} />
          <Route path="/automations" element={<AutomationsPage />} />
          <Route path="/dev/tokens" element={<TokenGallery />} />
          <Route path="*" element={<HomePage />} />
        </Route>
      </Routes>
      <CommandCenter />
      <NewSessionDialog />
      <ChannelsDialog />
      {(authStatus === 'pairing' || authStatus === 'rejected') && <PairGate />}
    </BrowserRouter>
  )
}
