// zcode/platform.ts — vendored from packages/web/src/main.tsx createWebPlatform
// (Apache-2.0, ZCode). Web 平台层的合法 stub 集合——他们自己就这样跑 web 模式；
// ocrc 的桌面级能力（选目录、终端、窗口控制）同样显式不可用。
import type { IPlatformService, RemoteTarget, ServerRemoteInfo } from '@zcode/shared'
import { putWebFile } from '../zcode-services/webAttachments.js'

/** web 端的「选文件」：没有本地路径，就发**句柄**。ZCode 的桌面链路把
 *  getPathForFile/selectFiles 的返回值当路径引用零拷贝透传到
 *  sendText.attachments[].ref（不触发 V4 上传，也就不碰 crypto.subtle 校验和——
 *  局域网 http 源上那个 API 不存在）；发送时 zcodeAgentService 用同一个寄存表
 *  把句柄解析回字节。 */
function pickFiles(multiple: boolean): Promise<string[]> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') return resolve([])
    const input = document.createElement('input')
    input.type = 'file'
    if (multiple) input.multiple = true
    input.style.display = 'none'
    document.body.appendChild(input)
    let settled = false
    const finish = (files: FileList | null) => {
      if (settled) return
      settled = true
      input.remove()
      const out: string[] = []
      for (const file of files ?? []) {
        if (/^image\//.test(file.type)) out.push(putWebFile(file))
        // 非图片：ocrc 的发送通道（/api/message）只接受图片附件；这里不收，
        // 让「+」按钮对 pdf/文本给出「没反应不如给说法」——由门/提示承载。
      }
      resolve(out)
    }
    input.addEventListener('change', () => finish(input.files))
    input.addEventListener('cancel', () => finish(null))
    input.click()
  })
}

export function createWebPlatform(): IPlatformService {
  return {
    // N5 裁决（2026-10-08 用户拍板）：/z/ 需要侧栏页脚的远程控制/bots 弹层入口，
    // 但不能整体翻 isDesktop（会带出桌面缩放、窗框、更新器等 web 没有的 UX）。
    // WorkspaceSidebarFooter 的触发器门控单独读这个能力位——桌面能力仍显式不可用。
    webRemoteControlAvailable: true,
    canSelectFilePath: false,
    selectDirectory: () => Promise.resolve(null),
    selectFile: async () => (await pickFiles(false))[0] ?? null,
    selectFiles: async () => await pickFiles(true),
    getPathForFile: (file: File) => (/^image\//.test(file.type) ? putWebFile(file) : null),
    createTempTextAttachment: () =>
      Promise.reject(new Error('Temporary text attachments require a desktop host')),
    onRemoteConnectionLog: () => () => {},
    onRemoteSessionClosed: () => () => {},
    onBotRemoteWorkspaceReconnected: () => () => {},
    activateOrSetWorkspace: () => Promise.resolve({ activated: false }),
    connectRemote(_options: RemoteTarget) {
      return Promise.resolve({
        success: false,
        error: `Remote connect is not supported in Web mode yet: ${_options.kind}`,
      })
    },
    cancelPendingRemoteConnection: (_requestId?: string) => Promise.resolve(),
    disposeRemoteSession: () => Promise.resolve(),
    isDockerAvailable: () => Promise.resolve(false),
    listWSLDistros: () => Promise.resolve([]),
    listDockerContainers: () => Promise.resolve([]),
    listSSHConfigAliases: () => Promise.resolve([]),
    loadMcpFromUserDirectory: () => Promise.resolve({ servers: [] }),
    saveMcpToUserDirectory: () =>
      Promise.resolve({ success: false, error: 'MCP native directory management requires a desktop attachment' }),
    migrateLegacyCommonMcp: () =>
      Promise.resolve({ servers: {}, totalCount: 0, importedCount: 0, migratedCount: 0 } as any),
    openExternal: (url: string) => {
      window.open(url, '_blank', 'noopener,noreferrer')
    },
    openFeedback: async () => {},
    openCommunity: async () => {},
    canOpenCommunity: async () => false,
    openInFileManager: () => Promise.resolve({ success: false, error: 'Not supported in web mode' }),
    openExternalFile: () => Promise.resolve({ success: false, error: 'Not supported in web mode' }),
    registerOAuthState: (_payload: unknown) => {},
    onOAuthCallback: () => () => {},
    onPaymentCallback: () => () => {},
    onShareImport: () => () => {},
    notifyRendererReady: () => {},
    reportTelemetryEvent: async () => {},
    reportArmsCustomEvent: () => Promise.resolve(),
    showTaskNotification: (payload: { title: string; body: string }) => {
      if (document.hasFocus()) return
      if (typeof window.Notification === 'undefined' || window.Notification.permission !== 'granted') return
      try {
        new window.Notification(payload.title, { body: payload.body, silent: true })
      } catch {
        /* 浏览器通知不可用时静默忽略 */
      }
    },
    syncWindowTabs: () => {},
    syncWindowUnreadCount: () => {},
    syncActiveTaskSession: () => {},
    onFocusTab: () => () => {},
    onNewTab: () => () => {},
    onCloseActiveContextRequest: () => () => {},
    onOpenBrowserUrl: () => () => {},
    onNewTask: () => () => {},
    onOpenWorkspace: () => () => {},
    onWindowFullscreenChanged: () => () => {},
    onTaskNotificationClick: () => () => {},
    exportLogs: () => Promise.resolve({ success: false, error: 'Not supported in web mode' }),
    captureWindowScreenshot: () => Promise.resolve(null),
    importChromeBrowserData: (_options: unknown) =>
      Promise.resolve({
        cookies: { imported: 0, skipped: 0, failed: 0 },
        localStorage: { originsImported: 0, originsSkipped: 0, originsFailed: 0, entriesMigrated: 0 } as any,
        error: 'chrome_import_not_supported' as const,
      }),
    clearEmbeddedBrowserData: () =>
      Promise.resolve({ success: true, cleared: { cookies: true, localStorage: true } } as any),
    onUpdateReady: () => () => {},
    onUpdateCheckResult: () => () => {},
    onUpdateStateChanged: () => () => {},
    getUpdateState: () => Promise.resolve({ kind: 'idle', enabled: true } as any),
    downloadUpdate: () => Promise.resolve(),
    cancelUpdateDownload: () => Promise.resolve(),
    getDesktopSessionActivity: () => Promise.resolve({ runningAgentSessionCount: 0 }),
    getDesktopZoomLevel: () => Promise.resolve({ zoomLevel: 0 }),
    onDesktopZoomLevelChanged: () => () => {},
    onPostUpdateReleaseNotes: () => () => {},
    acknowledgePostUpdateReleaseNotes: () => Promise.resolve(),
    skipUpdateVersion: () => Promise.resolve(),
    quitAndInstallUpdate: () => Promise.resolve(),
    getInstalledEditors: () => Promise.resolve([]),
    openInEditor: () => Promise.resolve({ success: false, error: 'Not supported in web mode' }),
    executeDesktopCommand: () => Promise.resolve(),
    setApplicationLocale: (_locale: string) => Promise.resolve(),
    setTitleBarTheme: () => Promise.resolve(),
    getDeviceId: () => {
      const nav = globalThis.navigator as Navigator & { platform?: string }
      const parts = [
        nav?.platform ?? '',
        globalThis.screen?.width !== undefined ? String(globalThis.screen.width) : '',
        globalThis.screen?.height !== undefined ? String(globalThis.screen.height) : '',
        globalThis.screen?.colorDepth !== undefined ? String(globalThis.screen.colorDepth) : '',
      ]
      return parts.filter(Boolean).join('|')
    },
  } as unknown as IPlatformService
}

/** Server info the fork reports to Root — ocrc 没有 /api/server-info workspace 概念，先空。 */
export function emptyServerInfo(): Partial<ServerRemoteInfo> {
  return {}
}
