// zcode-services/pluginsManagementService.ts — ocrc-backed IPluginManagementService（N11-2）。
//
// 读侧映射：引擎的插件语义 = opencode.json 的 `plugin` 数组（PRODUCT.md 共生拓扑），
// 每个条目 → 一行"已安装"插件（enabled 如实）。设置页「已安装」出真数据。
// marketplace/安装/卸载/更新**如实拒绝**——PRODUCT.md 2026-10-07 裁决"插件市场不做"；
// 文案注明真实机制 = 编辑 opencode.json 的 plugin 数组 + 重启引擎（无热加载）。
//
// 行为面拆解：
// - listPlugins / getPluginsOverview：读侧（本文件）
// - getPluginReferenceCatalog / resolveSuggestedPluginReference：对话引用 catalog——
//   ocrc 的 sendText 通道不携带插件引用语义，返回空 catalog（诚实空，不假报错）
// - onDynamicPluginOperationProgress：ghost 事件（withGhosts 兜底）
// - 其余全部 mutation：ghost reject（withGhosts 兜底，带 ocrc 提示）
import { withGhosts } from './ghost.js'

function token(): string {
  try { return localStorage.getItem('ocrc.token') ?? '' } catch { return '' }
}

interface EngineConfigResponse { raw?: string }

async function readEnginePluginEntries(): Promise<Array<string | { name?: string; enabled?: boolean }>> {
  const res = await fetch('/api/settings/opencode-config', { headers: { Authorization: `Bearer ${token()}` } }).catch(() => null)
  if (!res?.ok) return []
  const body = (await res.json()) as EngineConfigResponse
  try {
    const parsed = JSON.parse(body.raw ?? '{}') as { plugin?: Array<string | { name?: string; enabled?: boolean }> }
    return Array.isArray(parsed.plugin) ? parsed.plugin : []
  } catch { return [] }
}

function pluginNameOf(entry: string | { name?: string }): string {
  if (typeof entry === 'string') {
    // 约定俗成三种形态：包名（@scope/pkg / pkg）、本地路径（./x / /x）、github 短链（user/repo#ref）
    const cleaned = entry.replace(/#.*$/, '')
    const last = cleaned.split('/').filter(Boolean).pop() ?? cleaned
    return last || entry
  }
  return entry.name ?? 'unnamed-plugin'
}

export function createOcrcPluginsManagementService(): any {
  const impl: Record<string, unknown> = {
    listPlugins: async () => {
      const entries = await readEnginePluginEntries()
      const plugins = entries.map((entry, i) => {
        const name = pluginNameOf(entry)
        const enabled = typeof entry === 'object' ? entry.enabled !== false : true
        return {
          id: `ocrc-plugin-${i}-${name}`,
          name,
          description: '',
          version: undefined,
          enabled,
          source: typeof entry === 'string' ? entry : JSON.stringify(entry),
          marketplace: 'opencode.json',
          skillCount: 0,
          skillRootCount: 0,
          commandRootCount: 0,
          mcpServerNames: [],
          rootPath: typeof entry === 'string' && /[./]/.test(entry) ? entry : '',
          rootSource: 'user',
          enabledSource: 'user',
        }
      })
      return { plugins, diagnostics: [] }
    },
    getPluginsOverview: async () => {
      const { plugins } = await (impl.listPlugins as any)()
      return {
        marketplaces: [],
        availablePlugins: [],
        installedPlugins: plugins.map((p: any) => ({
          id: p.id,
          name: p.name,
          marketplace: p.marketplace,
          description: p.description,
          version: p.version,
          enabled: p.enabled,
          scope: 'user',
          installPath: p.rootPath || undefined,
          componentTypes: [],
        })),
        restorableBuiltins: [],
        diagnostics: [],
        capability: { supported: true, reason: 'ocrc：插件以 opencode.json 的 plugin 数组为真相源（只读映射；增删请编辑该文件并重启引擎）' },
      }
    },
    getPluginReferenceCatalog: async () => ({ entries: [], diagnostics: [] }),
    resolveSuggestedPluginReference: async (params: { suggestion?: string }) => ({
      resolved: false,
      suggestion: params?.suggestion ?? '',
      diagnostics: [{ code: 'ocrc_plugin_reference_unsupported', message: 'ocrc 的发送通道不携带插件引用语义' }],
    }),
  }
  return withGhosts('pluginManagementService', impl, '（ocrc 裁决不做插件市场——编辑 opencode.json 的 plugin 数组并重启引擎）')
}
