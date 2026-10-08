// zcode-services/commandsService.ts — ocrc-backed ICommandsService (N3).
// 命令清单 = ocrc /api/commands（引擎 command.list：init/review/… 用户命令），
// 映射成 ZCode userCommands（source:'user'，location global）。命令文件管理面
// ocrc 暂无——write/update/delete 兜底 reject。
import { withGhosts } from './ghost.js'

interface OcrcCommand { name: string; description?: string }

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
  return withGhosts('commandsService', impl, '（ocrc 无命令文件管理面）')
}

