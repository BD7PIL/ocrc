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
  const [intlReady, setIntlReady] = useState(false)

  useEffect(() => {
    applyZCodeTheme()
    setStreamClientId(generateMobileDeviceFingerprint())
    // Root 首绘前的最短 settling——ghost 服务的 loading 态需要一帧
    const t = setTimeout(() => setIntlReady(true), 0)
    return () => clearTimeout(t)
  }, [])

  return (
    <div className="h-dvh min-h-dvh w-screen bg-background text-foreground">
      <AppErrorBoundary>
        <ZCodeIntlProvider settingService={services.settingService} broadcastService={services.broadcastService}>
          {intlReady && (
            <Suspense fallback={<div className="p-8 text-ui-sm text-foreground-subtle">ZCode fork loading…</div>}>
              <Root
                services={services}
                platform={platform}
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
