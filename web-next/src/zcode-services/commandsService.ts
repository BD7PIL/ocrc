// zcode-services/commandsService.ts — ocrc-backed ICommandsService (N3).
// 命令清单 = ocrc /api/commands（引擎 command.list：init/review/… 用户命令），
// 映射成 ZCode userCommands（source:'user'，location global）。命令文件管理面
// ocrc 暂无——write/update/delete 兜底 reject。
interface OcrcCommand { name: string; description?: string }

const SUBSCRIBE_RE = /^(on[A-Z_]|onMessage|subscribe|add|listen|watch)/

function token(): string {
  try { return localStorage.getItem('ocrc.token') ?? '' } catch { return '' }
}

export function createOcrcCommandsService(): any {
  const impl: Record<string, unknown> = {
    list: async () => {
      const res = await fetch('/api/commands', { headers: { Authorization: `Bearer ${token()}` } })
      const raw: OcrcCommand[] = res.ok ? ((await res.json()) as OcrcCommand[]) : []
      const userCommands = raw.map((c) => ({
        id: `ocrc-cmd-${c.name}`,
        name: c.name,
        prompt: c.description ?? '',
        content: c.description ?? '',
        filePath: '',
        description: c.description,
        source: 'user',
        agentSource: 'ocrc',
        location: { kind: 'user' },
        enabled: true,
        scope: 'global',
      }))
      return { commands: userCommands, userCommands, pluginCommands: [], capability: { userScopeAvailable: false } }
    },
    getPrimaryUserCommandsDirectory: async () => ({ path: '' }),
  }
  return new Proxy(impl, {
    get(target, prop) {
      if (prop in target) return target[prop as string]
      if (prop === 'then' || prop === 'toJSON') return undefined
      const name = String(prop)
      if (SUBSCRIBE_RE.test(name)) {
        return (_listener?: unknown) => {
          const un: any = () => {}
          un.dispose = () => {}
          return un
        }
      }
      return (..._args: unknown[]) =>
        Promise.reject(new Error(`[ocrc-fork] commandsService.${name} 尚未接入 ocrc（ocrc 无命令文件管理面）`))
    },
  })
}

