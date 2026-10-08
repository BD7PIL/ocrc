// zcode-services/systemService.ts — ocrc-backed ISystemService（N6 批次 2A）。
//
// 这个服务小但位置关键：DirectoryBrowser 用 info().homedir 当起始路径，
// 缺失时目录选择器直接掉进 errorSystem 空态（实测）。终端是产品裁决不做项
// （PRODUCT.md 第五条），如实回空列表让 UI 隐藏入口。
function token(): string {
  try { return localStorage.getItem('ocrc.token') ?? '' } catch { return '' }
}

interface OcrcSystemInfo {
  homedir: string
  platform: string
  osRelease?: string
  hostname?: string
  node?: string
  version?: string
}

let cached: OcrcSystemInfo | null = null

export function createOcrcSystemService(): Record<string, any> {
  return {
    info: async (): Promise<{ homedir: string; platform: string }> => {
      if (cached) return { homedir: cached.homedir, platform: cached.platform }
      const res = await fetch('/api/system', { headers: { Authorization: `Bearer ${token()}` } }).catch(() => null)
      if (!res?.ok) throw new Error(`/api/system ${res?.status ?? '网络错误'}`)
      cached = (await res.json()) as OcrcSystemInfo
      return { homedir: cached.homedir, platform: cached.platform }
    },
    /** 集成的终端壳：ocrc 不做终端页签（产品裁决）——空列表 = UI 不给入口。 */
    listIntegratedTerminalShells: async () => [] as Array<{ id: string; label: string }>,
    /** 内网探测是桌面壳的能力（探本机是否能到某地址）；web 端无从代劳。 */
    probeIntranet: async () => ({ ok: false, reason: 'ocrc web 端不支持内网探测' }) as Record<string, unknown>,
  }
}
