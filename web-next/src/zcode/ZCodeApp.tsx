// zcode/ZCodeApp.tsx — /z/ fork bootstrap, mirrors packages/web/src/main.tsx
// (Apache-2.0, ZCode). 真 ZCode Root 跑在 ocrc 的幽灵 accessor 上；N1+ 逐服务
// 填实。主题默认 zai-dark（与其 WEB_DEFAULT_THEME 一致），偏好存 localStorage
// 'zcode-theme'。
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { AppErrorBoundary, ZCodeIntlProvider, generateMobileDeviceFingerprint, setStreamClientId, setZCodeBrandMessages } from '@zcode/ui'
// ZCode 原生样式表（独立 Tailwind 入口：自带 source 扫描域 + zai 双主题）。
import '../../vendor/zcode/ui/src/styles.css'
// N8-7：移动端壳层适配（安全区 + 触屏 16px 输入字号），ocrc 侧覆盖、不动 vendor。
import './zcode-mobile.css'
// U2 品牌层：任何 IntlProvider 实例渲染前注册（含 ErrorBoundary/分享只读页等
// vendor 内部实例），键级覆盖 vendor 词条。
import { BRAND_MESSAGES } from './brandMessages.js'
setZCodeBrandMessages(BRAND_MESSAGES)
// B9 批次 6：ocrc 域设置分区（模型映射方案 / 项目 .opencode / 技能源 / 全局配置 raw）
// 经 vendor 的 extraSections 注册表挂进 /z/ 设置页——与品牌层同款「模块级注册」形态。
import { registerOcrcSettingsSections } from './settingsSections.js'
registerOcrcSettingsSections()
import { onUnauthorized } from '$lib/auth.js'
import { createGhostAccessor } from './accessor.js'
import { createWebPlatform } from './platform.js'
import { createOcrcWorkspaceSwitcher, type WorkspaceSwitchRequest } from './remoteControl/workspaceSwitcher.js'
import type { WebRemoteControlMobileNavigationIntent } from '@zcode/shared'

const Root = lazy(() =>
  import('@zcode/ui')
    .then((m) => { console.log('[zcode-fork] @zcode/ui resolved, Root =', typeof m.Root); return { default: m.Root } })
    .catch((e) => { console.error('[zcode-fork] @zcode/ui import FAILED:', e); throw e }),
)

// 与 vendor WorkspaceShellLayout 的 WEB_REMOTE_CONTROL_MOBILE_QUERY 保持同一查询串——
// switcher prop 的有无必须与 vendor 自己的移动视口判定同步，官方移动壳的早退
// 分支（isWebRemoteControlShell && isWebRemoteControlMobileViewport）才恰好闭合。
const WEB_REMOTE_CONTROL_MOBILE_QUERY = '(max-width: 767px)'

function useIsMobileViewport(): boolean {
  const [mobile, setMobile] = useState(
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(WEB_REMOTE_CONTROL_MOBILE_QUERY).matches,
  )
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(WEB_REMOTE_CONTROL_MOBILE_QUERY)
    const onChange = (e: MediaQueryListEvent) => setMobile(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return mobile
}

function resolveThemePreference(): 'zai-dark' | 'zai-light' {
  try {
    const saved = localStorage.getItem('zcode-theme')
    if (saved === 'zai-light' || saved === 'light') return 'zai-light'
    // 语义与 vendor useTheme 对齐：认 'system'（跟随 prefers-color-scheme）。
    // 写路径归 vendor setTheme 单一写者——这里只做 Root chunk 加载前的防闪预涂。
    if (saved === 'system') {
      return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'zai-dark' : 'zai-light'
    }
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
  // ?session= 深链：引导时直接激活指定会话（需要同时给对 workspace 才会被 Root 接住）。
  const [initialSessionId] = useState(() => {
    try { return new URLSearchParams(window.location.search).get('session') ?? undefined } catch { return undefined }
  })
  const [settled, setSettled] = useState(false)
  // ── 官方移动壳接线（W2）：switcher 只在移动视口传。桌面零变化——vendor 的
  // isWebRemoteControlShell/Root/Sidebar 族全部以「prop 是否存在」为开关（无
  // viewport 条件），无条件传会翻转桌面九项行为（分享链、分屏、CUA、自动化/
  // 插件页可达性等），移动视口门控是硬约束。
  const isMobileViewport = useIsMobileViewport()
  // 跨工作区切换 = Root 重挂（vendor 的活动工作区权威 state 是 Root 内部闭包，
  // 无对外 API；重挂重新走引导，didBootstrapInitialWorkspaceRef 是实例级的），
  // 与 ?session= 深链同一条已验证通路。ocrc 服务层单例在 Root 之外，重挂不断流。
  const [switchRequest, setSwitchRequest] = useState<WorkspaceSwitchRequest | null>(null)
  const activePathRef = useRef<string | undefined>(undefined)
  const [switcher] = useState(() =>
    createOcrcWorkspaceSwitcher({
      getActiveWorkspacePath: () => activePathRef.current,
      onRequestSwitch: (req) => setSwitchRequest(req),
    }),
  )
  useEffect(() => {
    const effective = switchRequest?.workspacePath ?? workspacePath
    if (effective) activePathRef.current = effective
  }, [workspacePath, switchRequest])
  // 重挂请求覆盖引导解析值；无请求时维持原深链/引导行为。
  const initialWorkspaceAbsPath = switchRequest?.workspacePath ?? workspacePath
  const initialTaskId = switchRequest?.taskId ?? initialSessionId
  const mobileNavigationIntent: WebRemoteControlMobileNavigationIntent | undefined =
    switchRequest?.intent ?? (initialSessionId ? 'chat' : undefined)

  useEffect(() => {
    applyZCodeTheme()
    setStreamClientId(generateMobileDeviceFingerprint())
    // `#token=` 采纳与 `#pair=` 换取都在 lib/auth.ts 的模块初始化里做（与路由无关），
    // 那里也是旧壳的同一条路径——/z/ 不再自己实现一份。
    // ocrc 没有 workspace 概念的服务——以最近会话的目录作为初始 workspace
    // （ZCode 是 workspace 中心结构，Root 没有它就不渲染壳）。
    const token = (() => { try { return localStorage.getItem('ocrc.token') ?? '' } catch { return '' } })()
    const auth = { Authorization: `Bearer ${token}` }
    void (async () => {
      let sessions: Array<{ id: string; title?: string; lastActiveAt?: number; directory?: string }> = []
      try {
        const res = await fetch('/api/sessions', { headers: auth })
        // 401 = 这个 origin 的 token 无效/缺失。交给**共享的**鉴权层处理：它会把
        // 状态机推到 'pairing'，App 随之渲染与旧壳完全相同的 PairGate（不再自造门）。
        if (res.status === 401 || res.status === 403) {
          onUnauthorized()
          setSettled(true)
          return
        }
        sessions = (await res.json()) as typeof sessions
      } catch { /* 列表拿不到就不选 workspace，壳走无初始目录分支 */ }
      // 深链会话优先以其目录为初始 workspace；否则取最近会话的目录。
      const deep = initialSessionId ? sessions.find((s) => s.id === initialSessionId) : undefined
      const dir = deep?.directory ?? sessions.find((s) => s.directory)?.directory
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
    <div className="zcode-shell-root h-dvh min-h-dvh w-screen bg-background text-foreground">
      <AppErrorBoundary>
        <ZCodeIntlProvider settingService={services.settingService} broadcastService={services.broadcastService}>
          {settled && (
            <Suspense fallback={<div className="p-8 text-ui-sm text-foreground-subtle">ocrc 加载中…</div>}>
              <Root
                key={switchRequest?.nonce ?? 0}
                services={services}
                platform={platform}
                initialWorkspaceAbsPath={initialWorkspaceAbsPath}
                initialTaskId={initialTaskId}
                // ocrc 没有跨启动的 tab 持久化——关闭恢复机制，让
                // hasCompletedInitialRestore 立即完成、initialWorkspace 引导生效
                restoreSession={false}
                preferDirectoryBrowser
                supportsEmbeddedBrowser={false}
                allowRemoteWorkspace={false}
                {...(isMobileViewport
                  ? {
                      webRemoteControlWorkspaceSwitcher: switcher,
                      ...(mobileNavigationIntent ? { initialWebRemoteControlMobileNavigationIntent: mobileNavigationIntent } : {}),
                    }
                  : {})}
              />
            </Suspense>
          )}
        </ZCodeIntlProvider>
      </AppErrorBoundary>
    </div>
  )
}
