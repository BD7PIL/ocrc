// zcode-services/botsService.ts — ocrc-backed IBotsService (N4).
// ocrc channels（tg-default：token/allowUsers/enabled）↔ ZCode BotConfig
// （provider 'telegram'）。读面（getStatus/getConfig/listBots）映射 ocrc
// /api/channels；写面（saveBot/deleteBot/testBot/注册三件套）ocrc 的配置
// 入口在 rc.2 面板 + env——先 reject 命名错误，N4.x 视需要补写回。
import type { IBotsService } from '@zcode/services'
import type { BotConfig } from '@zcode/shared'

interface OcrcChannel {
  id: string
  enabled?: boolean
  allowUsers?: number[]
  credentials?: { token?: string; proxy?: string }
  hasToken?: boolean
  tokenHint?: string
}

function token(): string {
  try { return localStorage.getItem('ocrc.token') ?? '' } catch { return '' }
}

async function channels(): Promise<OcrcChannel[]> {
  const res = await fetch('/api/channels', { headers: { Authorization: `Bearer ${token()}` } })
  if (!res.ok) return []
  return ((await res.json()) as { channels?: OcrcChannel[] }).channels ?? []
}

function toBotConfig(c: OcrcChannel): BotConfig {
  return {
    id: c.id,
    name: c.id === 'tg-default' ? 'ocrc Telegram' : c.id,
    provider: 'telegram',
    enabled: c.enabled ?? false,
    allowedWorkspaces: [],
    allowedCommands: { status: true, new: true, workspace: true, model: true, thoughtLevel: true, reply: true },
    currentOptions: {},
    replyMode: 'assistant_changes',
  } as unknown as BotConfig
}

export function createOcrcBotsService(): any {
  const impl: Record<string, unknown> = {
    syncAppRuntimePreferences: async () => {},
    getStatus: async () => {
      const bots = await channels()
      return {
        botsCount: bots.length,
        enabledBotsCount: bots.filter((b) => b.enabled).length,
        contextsCount: 0,
        botRuntime: [],
      }
    },
    getConfig: async () => ({ version: 3, bots: [] }),
    listBots: async () => {
      const chans = await channels()
      return chans.map(toBotConfig)
    },
    // 写回：BotConfig.enabled → ocrc channel PATCH enabled（token/allowUsers
    // 编辑入口在 rc.2 面板，/z/ 侧先放行启用开关）
    saveBot: async (params: { bot: BotConfig }) => {
      const res = await fetch(`/api/channels/${params.bot.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
        body: JSON.stringify({ enabled: params.bot.enabled ?? false }),
      })
      if (!res.ok) throw new Error(`[ocrc-fork] saveBot failed: ${res.status}`)
      return toBotConfig({ id: params.bot.id, enabled: params.bot.enabled ?? false })
    },
    deleteBot: async (botId: string) => {
      // ocrc 通道不可删除（host 单例），等价语义 = 禁用
      await fetch(`/api/channels/${botId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
        body: JSON.stringify({ enabled: false }),
      })
    },
    testBot: async (botId: string) => {
      const res = await fetch('/api/channels', { headers: { Authorization: `Bearer ${token()}` } })
      const channels = res.ok ? ((await res.json()) as { channels?: Array<{ id: string; enabled?: boolean; hasToken?: boolean }> }).channels ?? [] : []
      const ch = channels.find((c) => c.id === botId)
      return {
        ok: Boolean(ch?.hasToken),
        botId,
        error: ch?.hasToken ? undefined : '通道未配置 token',
      }
    },
  }
  return new Proxy(impl, {
    get(target, prop) {
      if (prop in target) return target[prop as string]
      if (prop === 'then' || prop === 'toJSON') return undefined
      const name = String(prop)
      if (/^(on[A-Z_]|onMessage|subscribe|add|listen|watch)/.test(name)) {
        return (_listener?: unknown) => {
          const un: any = () => {}
          un.dispose = () => {}
          return un
        }
      }
      return (..._args: unknown[]) =>
        Promise.reject(new Error(`[ocrc-fork] botsService.${name} 尚未接入 ocrc`))
    },
  }) as unknown as IBotsService
}
