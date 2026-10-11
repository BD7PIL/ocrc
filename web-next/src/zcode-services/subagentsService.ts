// zcode-services/subagentsService.ts — U4：ocrc-backed ISubagentsService。
//
// 数据源（分期一，按自有化总案）：opencode.json 的 `agent` 节。
// - list：引擎合并配置（/api/agents-full，含 global+project、无 model 门槛）为主，
//   项目配置（/api/settings/project/agents）标记哪些条目在本项目落过盘。
// - model 覆盖（setPluginAgentModelOverride / setBuiltInModelOverride）：写项目配置
//   `agent.<name>.model`（merge 语义，保住 prompt/description；opencode 合并序
//   project > global，覆盖全局定义的 agent 也成立）。
// - setEnabled / createAgent / updateAgent / deleteAgent：withGhosts 如实拒绝
//   （分期二再接；vendor AgentSummary 的 ZCode 专有字段不带——硬映射=造假）。
import { withGhosts } from './ghost.js'

type AgentEntry = Record<string, unknown>

function token(): string {
  try { return localStorage.getItem('ocrc.token') ?? '' } catch { return '' }
}

function headers(): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` }
}

/** 引擎 model 串 → vendor ModelSelection。`provider/model` 按第一个 "/" 切
 *  （provider id 不含 "/"）；无 provider 前缀的裸名 → 空 provider（UI 显示为
 *  未完成选择，不造假）。reasoning variant 不编码在 model 串里，如实丢。 */
function parseModelSelection(model: unknown): { providerId: string; modelId: string } | undefined {
  if (typeof model !== 'string' || !model.trim()) return undefined
  const i = model.indexOf('/')
  if (i <= 0) return { providerId: '', modelId: model }
  return { providerId: model.slice(0, i), modelId: model.slice(i + 1) }
}

function selectionToModel(selection: unknown): string | undefined {
  const s = selection as { providerId?: string; modelId?: string } | undefined
  if (!s?.modelId) return undefined
  return s.providerId ? `${s.providerId}/${s.modelId}` : s.modelId
}

/** 引擎条目 → vendor AgentSummary。ZCode 专有字段（color/permissionMode/maxTurns/
 *  skills/mcpServers/…）一律不带：硬映射等于造假。scope/source 如实标 workspace/user
 *  ——ocrc 的 agent 语义全部是「配置文件里用户写的条目」。 */
function toAgentSummary(name: string, entry: AgentEntry, projectEntry: AgentEntry | undefined) {
  const description = typeof entry.description === 'string' ? entry.description : ''
  const prompt = typeof entry.prompt === 'string' ? entry.prompt : ''
  const toolsCfg = entry.tools as Record<string, boolean> | undefined
  const tools = toolsCfg && typeof toolsCfg === 'object'
    ? Object.entries(toolsCfg).filter(([, v]) => v === true).map(([k]) => k)
    : undefined
  return {
    id: name,
    name,
    description,
    systemPrompt: prompt,
    modelSelection: parseModelSelection(entry.model),
    defaultModelSelection: parseModelSelection(entry.model),
    modelSelectionOverride: projectEntry ? parseModelSelection(projectEntry.model) : undefined,
    ...(tools?.length ? { tools } : {}),
    injectAgentsMd: undefined,
    path: `.opencode/opencode.json#agent.${name}`,
    scope: 'workspace' as const,
    source: 'user' as const,
    enabled: entry.disable !== true,
    readOnly: false,
  }
}

export function createOcrcSubagentsService() {
  // model 覆盖命令不带 workspacePath（vendor 参数形状如此）——用最近一次 list 的
  // 工作区落盘。单用户面板，串行使用，竞态面可忽略。
  let lastWorkspacePath = ''
  const currentDir = (p?: string): string => p || lastWorkspacePath

  return withGhosts('subagentsService', {
    async list(params: { workspacePath: string; workspaceIdentity?: string; provider?: unknown; mode?: string }) {
      lastWorkspacePath = params.workspacePath || lastWorkspacePath
      const [engineRes, projectRes] = await Promise.all([
        fetch(`/api/agents-full?dir=${encodeURIComponent(params.workspacePath)}`, { headers: headers() }),
        fetch(`/api/settings/project/agents?dir=${encodeURIComponent(params.workspacePath)}`, { headers: headers() }),
      ])
      if (!engineRes.ok) throw new Error(`GET /api/agents-full ${engineRes.status}`)
      const engine = (await engineRes.json()) as { agents?: Record<string, AgentEntry> }
      const project = projectRes.ok
        ? ((await projectRes.json()) as { agents?: Record<string, AgentEntry> }).agents ?? {}
        : {}
      const entries = engine.agents ?? {}
      const agents = Object.entries(entries).map(([name, e]) => toAgentSummary(name, e, project[name]))
      return {
        agents,
        // ocrc 没有独立「用户级目录」的 agent 面：设置页编辑列表 = 同一份配置条目。
        userAgents: agents,
        pluginAgents: [],
        capability: { userScopeAvailable: false },
        diagnostics: [],
      }
    },

    async setBuiltInModelOverride(params: { agentName: string; modelSelection?: unknown }) {
      return applyModelOverride(currentDir(), params.agentName, params.modelSelection)
    },

    async setPluginAgentModelOverride(params: { agentId: string; modelSelection?: unknown }) {
      return applyModelOverride(currentDir(), params.agentId, params.modelSelection)
    },

    async getPrimaryUserAgentsDirectory(_params: { provider?: unknown }) {
      // ocrc 的 agent 配置落在项目 .opencode/opencode.json——「打开目录」给这个。
      return { path: `${currentDir()}/.opencode` }
    },
  })
}

async function applyModelOverride(dir: string, name: string, selection: unknown): Promise<void> {
  if (!dir) throw new Error('[ocrc] subagents: 尚未 list，缺工作区路径')
  const model = selectionToModel(selection)
  const patch = model ? { model } : null // 清空覆盖 = 删除本项目条目（回落全局/默认）
  const res = await fetch('/api/settings/project/agents', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ dir, id: name, patch }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `POST /api/settings/project/agents ${res.status}`)
  }
}
