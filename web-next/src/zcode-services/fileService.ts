// zcode-services/fileService.ts — ocrc-backed IFileService（N6 批次 2A 补全）。
//
// 此前只有 3 个 workspace 解析方法，接口其余 14 个是 undefined——调用点直接
// TypeError（文件树整个进错误边界）。现在接 host 的文件面：
//   readdir/stat/checkFilesExist → /api/browse、/api/file-stat
//   readTextFile/readFileRange   → /api/file-slice、/api/file-base64（引擎读文件拿不到二进制）
//   searchWorkspaceFiles         → /api/files/search（@ 提及）
//   listWorkspaceFiles*          → /api/files/index（ZCode 的列式 packed 索引，1:1 兼容）
//
// root 追踪：ZCode 的调用点混用「绝对路径」与「相对根路径」，而 host 侧所有文件
// 操作都以 workspace 根做 containment 校验——服务里记住最近一次已知的根，
// 绝对路径在根下就用根，否则用自身目录兜底（仍在 host 的校验内）。
import { withGhosts } from './ghost.js'

interface OcrcSessionSummary { id: string; directory?: string }

let root = ''
const packedCache = new Map<string, { packed: string; at: number }>()

function token(): string {
  try { return localStorage.getItem('ocrc.token') ?? '' } catch { return '' }
}

function auth(): Record<string, string> {
  return { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' }
}

async function getJson<T>(url: string, fallback?: T): Promise<T> {
  const res = await fetch(url, { headers: auth() }).catch(() => null)
  if (!res?.ok) {
    if (fallback !== undefined) return fallback
    const detail = (await res?.json().catch(() => ({}))) as { error?: string } | undefined
    throw new Error(`${url} ${res?.status ?? '网络错误'}${detail?.error ? `：${detail.error}` : ''}`)
  }
  return (await res.json()) as T
}

async function postJson<T>(url: string, body: unknown, fallback?: T): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: auth(), body: JSON.stringify(body ?? {}) }).catch(() => null)
  if (!res?.ok) {
    if (fallback !== undefined) return fallback
    const detail = (await res?.json().catch(() => ({}))) as { error?: string } | undefined
    throw new Error(`${url} ${res?.status ?? '网络错误'}${detail?.error ? `：${detail.error}` : ''}`)
  }
  return (await res.json()) as T
}

async function newestSessionDirectory(): Promise<string> {
  try {
    const sessions = await getJson<OcrcSessionSummary[]>('/api/sessions', [])
    return sessions.find((s) => s.directory)?.directory ?? ''
  } catch {
    return ''
  }
}

/** 绝对路径 → host 的 (directory, path) 二元组，保持 containment 语义。 */
function asRemote(path: string): { directory: string; path: string } {
  if (path.startsWith('/')) {
    if (root && (path === root || path.startsWith(`${root}/`))) {
      return { directory: root, path: path.slice(root.length + 1) || '.' }
    }
    const idx = path.lastIndexOf('/')
    return { directory: idx > 0 ? path.slice(0, idx) : '/', path: path.slice(idx + 1) || '.' }
  }
  return { directory: root, path: path || '.' }
}

function decodeBase64(base64: string): Uint8Array {
  const bin = atob(base64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function createOcrcFileService(): Record<string, any> {
  async function ensureRoot(): Promise<string> {
    if (root) return root
    root = await newestSessionDirectory()
    return root
  }

  return withGhosts('fileService', {
    ensureConversationWorkspace: async () => {
      root = (await newestSessionDirectory()) || root
      return { path: root, created: false, workspacePurpose: 'conversation' as const }
    },
    createDefaultWorkspace: async () => ({ path: (root = (await newestSessionDirectory()) || root) }),
    createScratchWorkspace: async (_params: { name: string }) => ({ path: (root = (await newestSessionDirectory()) || root) }),

    readdir: async (params: { path: string; includeHidden?: boolean }) => {
      await ensureRoot()
      const remote = asRemote(params.path)
      if (remote.directory && remote.directory !== '/') root = remote.directory
      const body = await getJson<{ files: Array<{ name: string; path: string; type: string }> }>(
        `/api/browse?directory=${encodeURIComponent(remote.directory)}&path=${encodeURIComponent(remote.path)}`,
        { files: [] },
      )
      return (body.files ?? []).filter((f) => params.includeHidden !== false || !f.name.startsWith('.'))
    },

    stat: async (params: { path: string }) => {
      await ensureRoot()
      const remote = asRemote(params.path)
      const body = await postJson<{ files: Array<{ path: string; exists: boolean; type: string; size?: number; mtimeMs?: number }> }>(
        '/api/file-stat', { directory: remote.directory, paths: [remote.path] }, { files: [] },
      )
      const f = body.files[0]
      return {
        path: params.path,
        type: f?.type === 'directory' ? 'directory' : 'file',
        size: f?.size,
        mtimeMs: f?.mtimeMs,
        exists: f?.exists ?? false,
      }
    },

    checkFilesExist: async (params: { paths: string[] }) => {
      await ensureRoot()
      if (!params.paths.length) return []
      const remote = asRemote(params.paths[0]!)
      const body = await postJson<{ files: Array<{ path: string; exists: boolean }> }>(
        '/api/file-stat', { directory: remote.directory, paths: params.paths.map((p) => asRemote(p).path) }, { files: [] },
      )
      return params.paths.map((p, i) => ({ path: p, exists: body.files[i]?.exists ?? false }))
    },

    resolvePath: async (params: { path: string }) => {
      const r = await ensureRoot()
      if (params.path.startsWith('/')) return params.path
      return r ? `${r}/${params.path}` : params.path
    },

    readTextFile: async (params: { path: string; offset?: number; length?: number }) => {
      await ensureRoot()
      const remote = asRemote(params.path)
      const q = new URLSearchParams({ directory: remote.directory, path: remote.path })
      q.set('offset', String(params.offset ?? 0))
      if (params.length !== undefined) q.set('length', String(params.length))
      const body = await getJson<{ content?: string; offset?: number; bytesRead?: number; totalBytes?: number; truncated?: boolean; isBinary?: boolean }>(
        `/api/file-slice?${q.toString()}`,
      )
      return {
        path: params.path,
        content: body.content ?? '',
        offset: body.offset ?? 0,
        bytesRead: body.bytesRead ?? 0,
        totalBytes: body.totalBytes ?? 0,
        truncated: body.truncated ?? false,
        isBinary: body.isBinary ?? false,
      }
    },

    readMediaPreview: async (params: { path: string; maxBytes?: number }) => {
      await ensureRoot()
      const remote = asRemote(params.path)
      const q = new URLSearchParams({ directory: remote.directory, path: remote.path })
      if (params.maxBytes !== undefined) q.set('maxBytes', String(params.maxBytes))
      const body = await getJson<{ dataBase64: string; totalBytes: number; mediaType: string }>(
        `/api/file-base64?${q.toString()}`,
      )
      return { path: params.path, mediaType: body.mediaType, dataBase64: body.dataBase64, totalBytes: body.totalBytes }
    },

    readBinaryPreview: async (params: { path: string; maxBytes?: number }) => {
      await ensureRoot()
      const remote = asRemote(params.path)
      const q = new URLSearchParams({ directory: remote.directory, path: remote.path })
      if (params.maxBytes !== undefined) q.set('maxBytes', String(params.maxBytes))
      const body = await getJson<{ dataBase64: string; totalBytes: number }>(`/api/file-base64?${q.toString()}`)
      return { path: params.path, dataBase64: body.dataBase64, totalBytes: body.totalBytes }
    },

    readFileRange: async (params: { path: string; offset: number; length: number }) => {
      const r = await ensureRoot()
      const remote = asRemote(params.path)
      const q = new URLSearchParams({
        directory: remote.directory || r,
        path: remote.path,
        offset: String(params.offset),
        length: String(params.length),
      })
      const body = await getJson<{ dataBase64: string }>(`/api/file-base64?${q.toString()}`)
      return decodeBase64(body.dataBase64)
    },

    searchWorkspaceFiles: async (params: { rootPath: string; query: string; limit?: number }) => {
      if (params.rootPath) root = params.rootPath
      const r = await ensureRoot()
      if (!r) return []
      const q = new URLSearchParams({ directory: r, q: params.query ?? '' })
      if (params.limit !== undefined) q.set('limit', String(params.limit))
      const body = await getJson<{ files: Array<{ name: string; path: string; relativePath: string; type: 'file' | 'directory' }> }>(
        `/api/files/search?${q.toString()}`, { files: [] },
      )
      return body.files ?? []
    },

    listWorkspaceFilesLength: async (params: { rootPath: string }) => {
      const r = params.rootPath || (await ensureRoot())
      if (!r) return 0
      const body = await getJson<{ length: number }>(`/api/files/index?directory=${encodeURIComponent(r)}&lengthOnly=1`, { length: 0 })
      return body.length ?? 0
    },

    /** 打包索引整包拉一次并短 TTL 缓存，按 offset/length 切片返回——
     *  客户端的分块协议原样满足（它只关心拿到定长片段）。 */
    listWorkspaceFilesRange: async (params: { rootPath: string; offset: number; length: number }) => {
      const r = params.rootPath || (await ensureRoot())
      if (!r) return ''
      const cached = packedCache.get(r)
      let packed: string
      if (cached && Date.now() - cached.at < 30_000) {
        packed = cached.packed
      } else {
        const body = await getJson<{ packed?: string }>(`/api/files/index?directory=${encodeURIComponent(r)}`, { packed: '' })
        packed = body.packed ?? ''
        packedCache.set(r, { packed, at: Date.now() })
      }
      return packed.slice(params.offset, params.offset + params.length)
    },

    // `.zcodeignore` 是 ZCode 的文件索引配置；ocrc 的列表走内置排除规则，不读它。
    // 读接口给说明性模板让设置页能渲染，写接口如实拒绝——不写一个没人读的文件假装生效。
    readWorkspaceFileSearchIgnore: async () => ({
      content: [
        '# ocrc 不使用 .zcodeignore：文件索引由 host 的内置排除规则决定',
        '# （.git / node_modules / dist / build / vendor / __pycache__ …）',
        '',
      ].join('\n'),
      source: 'template' as const,
    }),
    applyWorkspaceFileSearchIgnoreTransform: async () => {
      throw new Error('[ocrc-fork] ocrc 的文件索引不用 .zcodeignore，忽略规则由 host 决定')
    },
    writeWorkspaceFileSearchIgnore: async () => {
      throw new Error('[ocrc-fork] ocrc 的文件索引不用 .zcodeignore，忽略规则由 host 决定')
    },
  })
}
