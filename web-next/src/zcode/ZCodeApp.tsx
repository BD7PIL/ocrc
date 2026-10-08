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

/** 访问凭证门：/z/ 此前在「该 origin 没有 token」时渲染出一个空黑壳（所有 API 401，
 *  壳拿不到 workspace 就不渲染任何东西）。用户看到的是"打不开"，没有任何线索。
 *  这里给出可操作的入口：粘贴 host 上 ~/.ocrc/token 的内容即可。 */
function ZCodeAuthGate({ onRetry }: { onRetry: (token: string) => void }) {
  const [value, setValue] = useState('')
  return (
    <div className="flex h-dvh items-center justify-center bg-background p-6 text-foreground">
      <div className="w-full max-w-md space-y-3 rounded-lg border border-border bg-surface p-5">
        <div className="text-ui-sm font-medium">需要访问凭证</div>
        <p className="text-ui-xs text-foreground-subtle">
          这个地址（{typeof location !== 'undefined' ? location.origin : ''}）还没有访问 token，所有请求都被拒绝（401）。
          token 在被控端 host 上：<code className="rounded bg-hover px-1">~/.ocrc/token</code>。
          粘贴到下面即可（保存在本浏览器，不发送到别处）。
        </p>
        <input
          className="w-full rounded border border-border bg-background px-3 py-2 text-ui-sm outline-none focus:border-ring"
          placeholder="粘贴 token"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && value.trim()) onRetry(value.trim()) }}
        />
        <button
          type="button"
          disabled={!value.trim()}
          className="rounded bg-primary px-3 py-2 text-ui-sm text-primary-foreground disabled:opacity-50"
          onClick={() => { if (value.trim()) onRetry(value.trim()) }}
        >
          保存并进入
        </button>
        <p className="text-ui-xs text-foreground-subtle">
          也可以在 <a className="underline" href="/">{location.origin}/</a> 用旧控制台的配对入口（扫码/一次性链接）完成配对——
          token 按 origin 存储，换地址（127.0.0.1 ↔ 局域网 IP）就要各自存一次。
        </p>
      </div>
    </div>
  )
}

export function ZCodeApp() {
  const [services] = useState(() => createGhostAccessor())
  const [platform] = useState(() => createWebPlatform())
  const [workspacePath, setWorkspacePath] = useState<string | undefined>(undefined)
  const [settled, setSettled] = useState(false)
  const [unauthorized, setUnauthorized] = useState(false)

  useEffect(() => {
    applyZCodeTheme()
    setStreamClientId(generateMobileDeviceFingerprint())
    // 落地即采纳 URL 片段里的 token（`/z/#token=...`）——旧控制台一直支持这种
    // 直达地址，/z/ 此前不认，导致「拿链接进来」的路径实际不可用（壳渲染了但
    // 每个请求 401）。采纳规则与旧壳一致的加固：本地已有**不同** token 时不覆盖
    // （旧书签不能把轮换后的新凭证复活）；采纳后清掉 hash，避免留在地址栏。
    try {
      const m = (location.hash || '').match(/[#&]token=([^&]+)/)
      if (m && m[1]) {
        const fromHash = decodeURIComponent(m[1]).trim()
        const stored = localStorage.getItem('ocrc.token')
        if (fromHash && (!stored || stored === fromHash)) localStorage.setItem('ocrc.token', fromHash)
        history.replaceState(null, '', location.pathname + location.search)
      }
    } catch { /* 隐私模式/无 localStorage：照常走门 */ }
    // ocrc 没有 workspace 概念的服务——以最近会话的目录作为初始 workspace
    // （ZCode 是 workspace 中心结构，Root 没有它就不渲染壳）。
    const token = (() => { try { return localStorage.getItem('ocrc.token') ?? '' } catch { return '' } })()
    const auth = { Authorization: `Bearer ${token}` }
    void (async () => {
      let sessions: Array<{ id: string; title?: string; lastActiveAt?: number; directory?: string }> = []
      try {
        const res = await fetch('/api/sessions', { headers: auth })
        // 401/403 = 这个 origin 没有有效 token：必须显式告诉用户，不能渲染空壳。
        if (res.status === 401 || res.status === 403) {
          setUnauthorized(true)
          setSettled(true)
          return
        }
        sessions = (await res.json()) as typeof sessions
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
        {unauthorized ? (
          <ZCodeAuthGate
            onRetry={(token) => {
              try { localStorage.setItem('ocrc.token', token) } catch { /* 隐私模式：仍然重载一次试试 */ }
              if (typeof location !== 'undefined') location.reload()
            }}
          />
        ) : (
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
        )}
      </AppErrorBoundary>
    </div>
  )
}
