// zcode-services/mcpSyncService.ts — ocrc-backed IMcpSyncService（N6 批次 2C）。
//
// ocrc 的 MCP 面：`GET /api/mcp`（引擎配置里的 MCP 服务器，带 configured/disabled 状态）
// 与项目级 CRUD（`GET/POST /api/settings/project/mcp`）。读侧全接；写「用户目录级」
// 需要改全局 opencode 配置，ocrc 的 structured 写只有 provider 一族——如实拒绝，
// 让设置页用项目级入口（那是 ocrc 支持的语义）。
import { withGhosts } from './ghost.js'

interface OcrcMcpServer { name: string; type?: string; status?: string }
interface OcrcProjectMcp { mcp?: Record<string, Record<string, unknown>> }

function token(): string {
  try { return localStorage.getItem('ocrc.token') ?? '' } catch { return '' }
}

function auth(): Record<string, string> {
  return { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' }
}

async function getJson<T>(url: string, fallback: T): Promise<T> {
  const res = await fetch(url, { headers: auth() }).catch(() => null)
  if (!res || !res.ok) return fallback
  return (await res.json()) as T
}

/** 引擎目录记录 → ZCode 的 NativeMcpServerRecord（UI 只读 name/scope/config/enabled）。 */
function toRecord(s: OcrcMcpServer, scope: 'user' | 'project', projectPath?: string): Record<string, unknown> {
  return {
    source: 'native',
    scope,
    name: s.name,
    enabled: s.status !== 'disabled',
    ...(projectPath ? { projectPath } : {}),
    config: {
      type: s.type ?? 'local',
      // 引擎目录只回 name/type/status（命令与 env 属敏感面），UI 的列表行只吃这些
      ...(s.type === 'remote' ? {} : {}),
    },
  }
}

export function createOcrcMcpSyncService(): Record<string, any> {
  return withGhosts('mcpSyncService', {
    loadMcpFromUserDirectory: async (_request?: { workspacePath?: string }) => {
      const servers = await getJson<OcrcMcpServer[]>('/api/mcp', [])
      return { servers: (servers ?? []).map((s) => toRecord(s, 'user')) }
    },

    /** workspace 运行态列表：ocrc 的 /api/mcp 给的就是「配置态 + 引擎可见性」。 */
    listWorkspaceMcpServerStatuses: async (params: { workspacePath?: string }) => {
      const [servers, project] = await Promise.all([
        getJson<OcrcMcpServer[]>('/api/mcp', []),
        params?.workspacePath
          ? getJson<OcrcProjectMcp>(`/api/settings/project/mcp?dir=${encodeURIComponent(params.workspacePath)}`, {})
          : Promise.resolve<OcrcProjectMcp>({}),
      ])
      const projectNames = Object.keys(project.mcp ?? {})
      return {
        mode: 'config' as const,
        servers: [
          ...(servers ?? []).map((s) => ({ name: s.name, status: s.status ?? 'configured', source: 'engine' })),
          ...projectNames.map((name) => ({ name, status: 'configured', source: 'project' })),
        ],
      }
    },

    saveMcpToUserDirectory: async () => {
      throw new Error('[ocrc-fork] 用户目录级 MCP 写入需要改全局 opencode 配置，/z/ 暂只提供项目级（POST /api/settings/project/mcp）')
    },
    listLocalUserMcpCandidates: async () => ({ candidates: [] }),
    listRemoteUserMcpStatuses: async () => ({ statuses: [] }),
    exportMcpServers: async () => ({ servers: [] }),
    checkRemoteUserMcpWriteAccess: async () => ({ allowed: false, reason: 'remote sync not supported' }),
    importMcpServers: async () => { throw new Error('[ocrc-fork] MCP 导入未接 ocrc') },
  })
}
