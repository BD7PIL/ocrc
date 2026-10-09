// zcode-services/mcpSyncService.ts — ocrc-backed IMcpSyncService（N6 批次 2C；N8-3 接上写）。
//
// ocrc 的 MCP 面：`GET /api/mcp`（引擎配置里的 MCP 服务器）+ 项目级 CRUD
// （`GET/POST /api/settings/project/mcp`）+ 用户级结构化写
// （`POST /api/settings/opencode-config/mcp`，N8-3）。读列表会并上全局配置里
// 已写、引擎尚未重载的条目——opencode 不热重载配置，不并的话写入在界面上
// 看起来「没保存」。
import { withGhosts } from './ghost.js'
import { saveMcpToUserDirectory } from './mcpWrite.js'

interface OcrcMcpServer { name: string; type?: string; status?: string }
interface OcrcProjectMcp { mcp?: Record<string, Record<string, unknown>> }
interface OcrcGlobalMcp { mcp?: Record<string, Record<string, unknown>> }

/** 引擎可见条目 → ZCode 记录，再补上只在全局配置里、引擎还没重载的条目。 */
function mergeUserMcp(servers: OcrcMcpServer[], globalMcp: OcrcGlobalMcp): Array<Record<string, unknown>> {
  const seen = new Set(servers.map((s) => s.name))
  const out = servers.map((s) => toRecord(s, 'user'))
  for (const [name, entry] of Object.entries(globalMcp.mcp ?? {})) {
    if (seen.has(name)) continue
    out.push(toRecord({
      name,
      type: (entry as { type?: string })?.type,
      status: (entry as { enabled?: boolean })?.enabled === false ? 'disabled' : 'configured',
    }, 'user'))
  }
  return out
}

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
    /** 用户级 MCP：引擎可见列表 + 全局配置里已写但引擎还没重载的条目（写入后
     *  立刻可见，不用等重启——opencode 不热重载配置）。 */
    loadMcpFromUserDirectory: async (_request?: { workspacePath?: string }) => {
      const [servers, globalMcp] = await Promise.all([
        getJson<OcrcMcpServer[]>('/api/mcp', []),
        getJson<OcrcGlobalMcp>('/api/settings/opencode-config/mcp', {}),
      ])
      return { servers: mergeUserMcp(servers ?? [], globalMcp) }
    },

    /** workspace 运行态列表：ocrc 的 /api/mcp 给的就是「配置态 + 引擎可见性」，
     *  再并上全局配置里待重载的条目与项目配置里的条目。 */
    listWorkspaceMcpServerStatuses: async (params: { workspacePath?: string }) => {
      const [servers, project, globalMcp] = await Promise.all([
        getJson<OcrcMcpServer[]>('/api/mcp', []),
        params?.workspacePath
          ? getJson<OcrcProjectMcp>(`/api/settings/project/mcp?dir=${encodeURIComponent(params.workspacePath)}`, {})
          : Promise.resolve<OcrcProjectMcp>({}),
        getJson<OcrcGlobalMcp>('/api/settings/opencode-config/mcp', {}),
      ])
      const engineNames = new Set((servers ?? []).map((s) => s.name))
      const projectNames = Object.keys(project.mcp ?? {})
      const userOnly = Object.entries(globalMcp.mcp ?? {})
        .filter(([name]) => !engineNames.has(name))
        .map(([name, entry]) => ({
          name,
          status: (entry as { enabled?: boolean })?.enabled === false ? 'disabled' : 'configured',
          source: 'user',
        }))
      return {
        mode: 'config' as const,
        servers: [
          ...(servers ?? []).map((s) => ({ name: s.name, status: s.status ?? 'configured', source: 'engine' })),
          ...userOnly,
          ...projectNames.map((name) => ({ name, status: 'configured', source: 'project' })),
        ],
      }
    },

    /** identity 路径与 platform 路径共用同一份写入映射（mcpWrite.ts）。 */
    saveMcpToUserDirectory: async (payload: Parameters<typeof saveMcpToUserDirectory>[0]) => {
      const out = await saveMcpToUserDirectory(payload)
      if (!out.success) throw new Error(out.error ?? 'MCP 保存失败')
    },
    listLocalUserMcpCandidates: async () => ({ candidates: [] }),
    listRemoteUserMcpStatuses: async () => ({ statuses: [] }),
    exportMcpServers: async () => ({ servers: [] }),
    checkRemoteUserMcpWriteAccess: async () => ({ allowed: false, reason: 'remote sync not supported' }),
    importMcpServers: async () => { throw new Error('[ocrc-fork] MCP 导入未接 ocrc') },
  })
}
