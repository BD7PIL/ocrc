// zcode-services/fileService.ts — ocrc-backed IFileService (N2 partial).
// ZCode 是 workspace 中心的：登录后 ensureConversationWorkspace 决定壳能否
// 打开默认工作区。ocrc 没有 scratch/conversation workspace 概念——返回最近
// 会话的目录（没有则用 ocrc 仓库目录），purpose 标 conversation 以进「任务」
// 时间线分区。文件读取面走 ocrc 已有 /api/files（N3 设置页时再接）。
interface EnsureResult {
  path: string
  created: boolean
  workspacePurpose: 'conversation'
}

function token(): string {
  try { return localStorage.getItem('ocrc.token') ?? '' } catch { return '' }
}

async function latestSessionDirectory(): Promise<string | null> {
  try {
    const res = await fetch('/api/sessions', { headers: { Authorization: `Bearer ${token()}` } })
    if (!res.ok) return null
    const sessions = (await res.json()) as Array<{ directory?: string }>
    return sessions.find((s) => s.directory)?.directory ?? null
  } catch {
    return null
  }
}

export function createOcrcFileService(): any {
  return {
    ensureConversationWorkspace: async (): Promise<EnsureResult> => {
      const path = (await latestSessionDirectory()) ?? '/home/demo/develop/opencode-plugin/ocrc'
      return { path, created: false, workspacePurpose: 'conversation' }
    },
    createDefaultWorkspace: async () => ({
      path: (await latestSessionDirectory()) ?? '/home/demo/develop/opencode-plugin/ocrc',
    }),
    createScratchWorkspace: async () => ({
      path: (await latestSessionDirectory()) ?? '/home/demo/develop/opencode-plugin/ocrc',
    }),
  }
}
