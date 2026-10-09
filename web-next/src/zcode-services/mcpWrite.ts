// MCP 写入的共享实现（N8-3）：本地 workspace 走 platform.saveMcpToUserDirectory，
// 带 identity 的远端 workspace 走 mcpSyncService —— 两处同一份映射，避免语义漂移。
//
//   user 级    → POST /api/settings/opencode-config/mcp（全局 mcp map：备份 + 原子写）
//   project 级 → POST /api/settings/project/mcp（项目 .opencode/opencode.json[c]）
//
// 失败如实回 {success:false,error}（调用方 store 目前会把它降级为 logger.warn，
// 但写入是真的——不会再出现"表单关闭、实际没写"）。
export interface McpSavePayload {
  action: 'upsert' | 'delete' | 'set-enabled'
  name: string
  config?: Record<string, unknown>
  enabled?: boolean
  projectPath?: string
}

export interface McpSaveResult {
  success: boolean
  error?: string
}

export async function saveMcpToUserDirectory(payload: McpSavePayload): Promise<McpSaveResult> {
  const auth = (() => { try { return localStorage.getItem('ocrc.token') ?? '' } catch { return '' } })()
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` }
  try {
    let url: string
    let body: Record<string, unknown>
    if (payload.projectPath) {
      url = '/api/settings/project/mcp'
      body = {
        dir: payload.projectPath,
        id: payload.name,
        entry: payload.action === 'delete' ? null : payload.config ?? null,
      }
    } else if (payload.action === 'delete') {
      url = '/api/settings/opencode-config/mcp'
      body = { id: payload.name, delete: true }
    } else if (payload.action === 'set-enabled') {
      url = '/api/settings/opencode-config/mcp'
      body = { id: payload.name, enabled: payload.enabled !== false }
    } else {
      url = '/api/settings/opencode-config/mcp'
      body = { id: payload.name, entry: payload.config }
    }
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
    const out = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
    if (!res.ok || out.ok === false) return { success: false, error: out.error ?? `HTTP ${res.status}` }
    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}
