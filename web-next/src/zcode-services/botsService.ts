// zcode-services/botsService.ts — ocrc-backed IBotsService (N4).
// ocrc /api/channels（tg-default/wechat-default/lark-default/dingtalk-default，
// 凭证制：token / appSecret+appId）↔ ZCode BotConfig。读面全通道投影；写面
// PATCH enabled/credentials/replyGranularity/workspaces（ocrc 路由的准入语义：
// tg token 走 getMe 活校验）。QR 注册三件套/removeBotSecret 依赖 ZCode 自有
// bot 服务端与「单清 secret」API，ocrc 无对应——Proxy 层 reject 命名错误，
// 裁决记录见 vendor/CHECKLIST.md 第 9 节。
import type { IBotsService } from '@zcode/services'
import type { BotConfig } from '@zcode/shared'

interface OcrcChannel {
  id: string
  channel?: string
  enabled?: boolean
  allowUsers?: number[]
  replyGranularity?: 'standard' | 'detailed'
  workspaces?: { mode: 'all' } | { mode: 'custom'; dirs: string[] }
  credentials?: Record<string, string>
  hasToken?: boolean
  tokenHint?: string
  live?: { connected: boolean; username?: string } | null
}

function token(): string {
  try { return localStorage.getItem('ocrc.token') ?? '' } catch { return '' }
}

async function channels(): Promise<OcrcChannel[]> {
  const res = await fetch('/api/channels', { headers: { Authorization: `Bearer ${token()}` } })
  if (!res.ok) return []
  return ((await res.json()) as { channels?: OcrcChannel[] }).channels ?? []
}

// ocrc ChannelKind → ZCode BotProvider（wechat→weixin、lark→feishu；discord/
// webhook 无 ocrc 通道对应不投影，dingtalk 无 vendor provider 也不投影）。
const KIND_TO_PROVIDER: Partial<Record<string, string>> = {
  telegram: 'telegram',
  wechat: 'weixin',
  lark: 'feishu',
}

// saveBot 反向：provider → ocrc 通道 id（ZCode 一个 provider 一个 bot；
// ocrc 每类通道一个 default 单例）。
const PROVIDER_TO_CHANNEL: Record<string, string> = {
  telegram: 'tg-default',
  weixin: 'wechat-default',
  wecom: 'wechat-default',
  feishu: 'lark-default',
  lark: 'lark-default',
  dingtalk: 'dingtalk-default',
}

// 回复粒度：ocrc 二值（standard=隐藏工具过程 / detailed=展示）。
// ZCode 四值按「是否展示执行过程」归并：assistant_changes/summary_changes →
// standard；assistant_toolcalls_changes/streaming_card → detailed。
function replyModeToGranularity(mode: unknown): 'standard' | 'detailed' {
  return mode === 'assistant_toolcalls_changes' || mode === 'streaming_card' ? 'detailed' : 'standard'
}

function toBotConfig(c: OcrcChannel): BotConfig | null {
  const provider = KIND_TO_PROVIDER[c.channel ?? 'telegram']
  if (!provider) return null // dingtalk 等无 vendor provider 的通道不在 /z/ 呈现
  return {
    id: c.id,
    name: c.id === 'tg-default' ? 'ocrc Telegram' : c.id,
    provider,
    enabled: c.enabled ?? false,
    // ocrc 凭证就地存通道（redacted 投影），无独立 credentialRef 寻址——
    // hasToken 用 presence 语义呈现。
    ...(c.hasToken ? { credentialRef: `ocrc-inline:${c.tokenHint ?? 'set'}` } : {}),
    allowedWorkspaces: c.workspaces?.mode === 'custom' ? (c.workspaces as { dirs: string[] }).dirs : [],
    allowedCommands: { status: true, new: true, workspace: true, model: true, thoughtLevel: true, reply: true },
    currentOptions: {},
    replyMode: c.replyGranularity === 'detailed' ? 'assistant_toolcalls_changes' : 'assistant_changes',
    // telegram live 状态映射到 displayName，让 /z/ 列表能看到 bot 用户名
    ...(c.live?.username ? { displayName: c.live.username } : {}),
  } as unknown as BotConfig
}

async function patchChannel(id: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`/api/channels/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    // ocrc 路由对非法 token/参数回 400 + 中文原因（如 getMe 活校验失败）——透传
    const detail = await res.json().catch(() => null) as { error?: string } | null
    throw new Error(detail?.error ?? `[ocrc-fork] saveBot failed: ${res.status}`)
  }
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
    // BotsDialog 的列表读 getConfig().bots（不是 listBots）——必须投影同一份
    // 通道数据，否则弹层永远「还没有配置机器人」。
    getConfig: async () => {
      const chans = await channels()
      return { version: 3, bots: chans.map(toBotConfig).filter((b): b is BotConfig => b !== null) }
    },
    listBots: async () => {
      const chans = await channels()
      return chans.map(toBotConfig).filter((b): b is BotConfig => b !== null)
    },
    // 写回（可映射全量）：enabled + credentialValue（tg→token，lark→appSecret，
    // wechat→appSecret？ocrc wechat 凭证键随 rc.2 面板——仅 tg/lark 有把握，
    // 其余 provider 的凭证走原 reject）+ replyMode→replyGranularity +
    // allowedWorkspaces→workspaces（空数组=all，非空=custom dirs）。
    saveBot: async (params: { bot: BotConfig; credentialValue?: string }) => {
      const bot = params.bot
      const channelId = PROVIDER_TO_CHANNEL[bot.provider as string] ?? bot.id
      const body: Record<string, unknown> = { enabled: bot.enabled ?? false }
      if (bot.replyMode) body.replyGranularity = replyModeToGranularity(bot.replyMode)
      if (Array.isArray(bot.allowedWorkspaces)) {
        body.workspaces = bot.allowedWorkspaces.length > 0
          ? { mode: 'custom', dirs: bot.allowedWorkspaces }
          : { mode: 'all' }
      }
      if (params.credentialValue?.trim()) {
        if (channelId === 'tg-default') body.credentials = { token: params.credentialValue.trim() }
        else if (channelId === 'lark-default') {
          body.credentials = {
            appSecret: params.credentialValue.trim(),
            ...(bot.feishuAppId ? { appId: bot.feishuAppId } : {}),
          }
        } else {
          throw new Error(`[ocrc-fork] ${bot.provider} 凭证写入未接 ocrc（N4.x：随 rc.2 面板凭证键对齐）`)
        }
      }
      await patchChannel(channelId, body)
      const chans = await channels()
      const updated = chans.find((c) => c.id === channelId)
      return toBotConfig(updated ?? { id: channelId, enabled: bot.enabled })
    },
    deleteBot: async (botId: string) => {
      // ocrc 通道不可删除（host 单例），等价语义 = 禁用
      await patchChannel(botId, { enabled: false })
    },
    testBot: async (botId: string) => {
      const chans = await channels()
      const ch = chans.find((c) => c.id === botId)
      const hasToken = Boolean(ch?.hasToken)
      const liveOk = ch?.live ? ch.live.connected : true
      return {
        ok: hasToken && liveOk,
        botId,
        error: !hasToken ? '通道未配置凭证' : !liveOk ? '凭证已配置但通道未连上' : undefined,
      }
    },
    // listWorkspaceRefs：/z/ bot 表单的工作区候选——ocrc 无工作区注册表，
    // 返回空数组让 UI 走「无候选」分支（allowedWorkspaces 留空 = all）。
    listWorkspaceRefs: async () => [],
    // BotsDialog 的 refresh 用 Promise.all 聚合——getBotStates reject 会炸掉
    // 整个对话框加载，必须回空数组而不是走 Proxy reject。
    getBotStates: async () => [],
    resetBotState: async () => {},
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
