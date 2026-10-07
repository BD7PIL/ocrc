// zcode/ZCodeApp.tsx — /z/ fork bootstrap, mirrors packages/web/src/main.tsx
// (Apache-2.0, ZCode). 真 ZCode Root 跑在 ocrc 的幽灵 accessor 上；N1+ 逐服务
// 填实。主题默认 zai-dark（与其 WEB_DEFAULT_THEME 一致），偏好存 localStorage
// 'zcode-theme'。
import { lazy, Suspense, useEffect, useState } from 'react'
import { AppErrorBoundary, ZCodeIntlProvider, generateMobileDeviceFingerprint, setStreamClientId } from '@zcode/ui'
// ZCode 原生样式表（独立 Tailwind 入口：自带 source 扫描域 + zai 双主题）。
import '../../vendor/zcode/ui/src/styles.css'
import { createGhostAccessor } from './accessor.js'
import { createWebPlatform } from './platform.js'

const Root = lazy(() =>
  import('@zcode/ui')
    .then((m) => { console.log('[zcode-fork] @zcode/ui resolved, Root =', typeof m.Root); return { default: m.Root } })
    .catch((e) => { console.error('[zcode-fork] @zcode/ui import FAILED:', e); throw e }),
)

function resolveThemePreference(): 'zai-dark' | 'zai-light' {
  try {
    const saved = localStorage.getItem('zcode-theme')
    if (saved === 'zai-light' || saved === 'light') return 'zai-light'
  } catch {
    /* private mode */
  }
  return 'zai-dark'
}

export function applyZCodeTheme(): void {
  const theme = resolveThemePreference()
  const resolved = theme === 'zai-light' ? 'light' : 'dark'
  document.documentElement.classList.toggle('dark', resolved === 'dark')
  document.documentElement.classList.toggle('theme-zai-light', theme === 'zai-light')
  document.documentElement.classList.toggle('theme-zai-dark', theme === 'zai-dark')
}

export function ZCodeApp() {
  const [services] = useState(() => createGhostAccessor())
  const [platform] = useState(() => createWebPlatform())
  const [workspacePath, setWorkspacePath] = useState<string | undefined>(undefined)
  const [settled, setSettled] = useState(false)

  useEffect(() => {
    applyZCodeTheme()
    setStreamClientId(generateMobileDeviceFingerprint())
    // ocrc 没有 workspace 概念的服务——以最近会话的目录作为初始 workspace
    // （ZCode 是 workspace 中心结构，Root 没有它就不渲染壳）。
    const token = (() => { try { return localStorage.getItem('ocrc.token') ?? '' } catch { return '' } })()
    const auth = { Authorization: `Bearer ${token}` }
    void (async () => {
      let sessions: Array<{ id: string; title?: string; lastActiveAt?: number; directory?: string }> = []
      try {
        sessions = await (await fetch('/api/sessions', { headers: auth })).json()
      } catch { /* 列表拿不到就不选 workspace，壳走无初始目录分支 */ }
      const dir = sessions.find((s) => s.directory)?.directory
      if (dir) setWorkspacePath(dir)
      setSettled(true)
      // N5 跨页草稿回收（后台跑，不挡壳渲染）：shell 每次引导都会预热一个
      // 「New session」草稿，跨页加载无人回收，侧栏无限累积。清掉历史遗留的
      // 空草稿（三重守卫：默认标题 + 5 分钟不新鲜 + 0 消息——用户刚建的/
      // 改名的不动）。本次加载自己的新草稿尚未创建，不受影响。
      const staleCutoff = Date.now() - 5 * 60_000
      for (const s of sessions) {
        if (!/^New session - /.test(s.title ?? '')) continue
        if ((s.lastActiveAt ?? 0) > staleCutoff) continue
        try {
          const history = await (await fetch(`/api/session/${s.id}?limit=1`, { headers: auth })).json()
          if ((history?.cards ?? []).length > 0) continue
          await fetch(`/api/sessions/${s.id}/delete`, { method: 'POST', headers: auth })
        } catch { /* 单个失败不影响引导 */ }
      }
    })().catch(() => setSettled(true))
  }, [])

  return (
    <div className="h-dvh min-h-dvh w-screen bg-background text-foreground">
      <AppErrorBoundary>
        <ZCodeIntlProvider settingService={services.settingService} broadcastService={services.broadcastService}>
          {settled && (
            <Suspense fallback={<div className="p-8 text-ui-sm text-foreground-subtle">ZCode fork loading…</div>}>
              <Root
                services={services}
                platform={platform}
                initialWorkspaceAbsPath={workspacePath}
                // ocrc 没有跨启动的 tab 持久化——关闭恢复机制，让
                // hasCompletedInitialRestore 立即完成、initialWorkspace 引导生效
                restoreSession={false}
                preferDirectoryBrowser
                supportsEmbeddedBrowser={false}
                allowRemoteWorkspace={false}
              />
            </Suspense>
          )}
        </ZCodeIntlProvider>
      </AppErrorBoundary>
    </div>
  )
}
