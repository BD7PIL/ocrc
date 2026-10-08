// zcode-services/gitService.ts — ocrc-backed IGitService（N6 批次 2A：只读面）。
//
// Git 面板此前整个是幽灵服务（每个方法 reject）→ 面板一打开就进错误态。
// 只读面现在接 host 的 /api/git（repoRoot / ahead-behind / numstat / 分支 / identity）
// 与 /api/git/diff。写操作（stage/commit/push/切分支）是批次 3，在那之前如实拒绝
// ——不假装成功。
import { withGhosts } from './ghost.js'

interface OcrcGitInfo {
  isGitAvailable: boolean
  isRepository: boolean
  repoRoot: string
  workspaceInRepoPath: string
  branchName: string | null
  trackingBranchName: string | null
  ahead: number
  behind: number
  isDirty: boolean
  branches: Array<{ name: string; current: boolean }>
  identity: { userName: string | null; userEmail: string | null }
  changes: Array<{ path: string; index: string; worktree: string; additions: number; removed: number }>
}

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

const EMPTY: OcrcGitInfo = {
  isGitAvailable: false, isRepository: false, repoRoot: '', workspaceInRepoPath: '',
  branchName: null, trackingBranchName: null, ahead: 0, behind: 0, isDirty: false,
  branches: [], identity: { userName: null, userEmail: null }, changes: [],
}

async function postGit<T = any>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: 'POST', headers: auth(), body: JSON.stringify(body ?? {}) }).catch((e) => {
    throw new Error(`${path} 网络失败：${(e as Error).message}`)
  })
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(detail.error ?? `${path} ${res.status}`)
  }
  return (await res.json()) as T
}

/** UI 传来的路径可能是绝对路径（GitFileChange.path）——host 只收仓库相对路径。 */
function relPaths(paths: readonly string[]): string[] {
  return paths
    .map((p) => p.replace(/\\/g, '/'))
    .map((p) => (p.startsWith('/') ? p.split('/').slice(-1)[0] === p ? p : p.split('/').slice(-2).join('/') : p))
}

async function info(workspacePath: string): Promise<OcrcGitInfo> {
  if (!workspacePath) return EMPTY
  return getJson<OcrcGitInfo>(`/api/git?directory=${encodeURIComponent(workspacePath)}`, EMPTY)
}

/** porcelain 两列 → ZCode 的 GitChangeKind（M/A/D/R/?/U）。 */
function changeKind(c: { index: string; worktree: string }): string {
  if (c.index === '?' || c.worktree === '?') return 'untracked'
  if (c.index === 'U' || c.worktree === 'U' || (c.index === 'A' && c.worktree === 'A') || (c.index === 'D' && c.worktree === 'D')) return 'conflicted'
  if (c.index === 'R') return 'renamed'
  if (c.index === 'A') return 'added'
  if (c.index === 'D' || c.worktree === 'D') return 'deleted'
  return 'modified'
}

export function createOcrcGitService(): Record<string, any> {
  const cached = new Map<string, OcrcGitInfo>()
  async function infoCached(workspacePath: string): Promise<OcrcGitInfo> {
    const hit = cached.get(workspacePath)
    if (hit) return hit
    const fresh = await info(workspacePath)
    cached.set(workspacePath, fresh)
    return fresh
  }

  const refreshSummary = async (workspacePath: string) => {
    cached.delete(workspacePath)
    const i = await infoCached(workspacePath)
    return {
      workspacePath,
      repoRoot: i.repoRoot,
      workspaceInRepoPath: i.workspaceInRepoPath,
      autoRefreshWatchPaths: i.repoRoot ? [{ path: `${i.repoRoot}/.git` }] : [],
      branchName: i.branchName,
      trackingBranchName: i.trackingBranchName,
      headRefType: 'branch',
      ahead: i.ahead,
      behind: i.behind,
      isDirty: i.isDirty,
      isGitAvailable: i.isGitAvailable,
      isRepository: i.isRepository,
    }
  }

  return withGhosts('gitService', {
    getRepositorySummary: async (params: { workspacePath: string }) => {
      const i = await infoCached(params.workspacePath)
      return {
        workspacePath: params.workspacePath,
        repoRoot: i.repoRoot,
        workspaceInRepoPath: i.workspaceInRepoPath,
        // 刷新边界：.git 元数据目录（内容 watcher 由壳自己决定，web 侧不注册）
        autoRefreshWatchPaths: i.repoRoot ? [{ path: `${i.repoRoot}/.git` }] : [],
        branchName: i.branchName,
        trackingBranchName: i.trackingBranchName,
        headRefType: 'branch',
        ahead: i.ahead,
        behind: i.behind,
        isDirty: i.isDirty,
        isGitAvailable: i.isGitAvailable,
        isRepository: i.isRepository,
      }
    },

    getWorkspaceRepositoryInfo: async (params: { workspacePath: string }) => {
      const i = await infoCached(params.workspacePath)
      return {
        workspacePath: params.workspacePath,
        kind: i.isRepository ? 'repository' : 'not-repository',
        isGitAvailable: i.isGitAvailable,
      }
    },

    getLocalBranches: async (params: { workspacePath: string }) => {
      const i = await infoCached(params.workspacePath)
      return {
        headRefType: 'branch',
        currentBranchName: i.branchName,
        branches: i.branches.map((b) => ({ name: b.name, isCurrent: b.current, isRemote: false })),
      }
    },

    getChanges: async (params: { workspacePath: string }) => {
      const i = await infoCached(params.workspacePath)
      return i.changes.map((c) => {
        const kind = changeKind(c)
        return {
          path: `${i.repoRoot}/${c.path}`,
          repoRelativePath: c.path,
          workspaceRelativePath: i.workspaceInRepoPath ? `${i.workspaceInRepoPath}/${c.path}` : c.path,
          x: c.index.trim() || undefined,
          y: c.worktree.trim() || undefined,
          kind,
          section: c.index !== ' ' && c.index !== '?' ? 'staged' : 'unstaged',
          added: c.additions,
          removed: c.removed,
          isStaged: c.index !== ' ' && c.index !== '?',
          isUntracked: kind === 'untracked',
          isConflicted: kind === 'conflicted',
        }
      })
    },

    getDiff: async (params: { workspacePath: string; path?: string; repoRelativePath?: string; staged?: boolean }) => {
      const rel = params.repoRelativePath ?? params.path ?? ''
      const q = new URLSearchParams({ directory: params.workspacePath, file: rel })
      if (params.staged) q.set('staged', '1')
      const res = await getJson<{ patch: string | null; availability: string }>(`/api/git/diff?${q.toString()}`, { patch: null, availability: 'error' })
      return { path: rel, availability: res.availability, patch: res.patch, beforeContent: null, afterContent: null, summary: null }
    },

    getIdentity: async (params: { workspacePath: string }) => {
      const i = await infoCached(params.workspacePath)
      return {
        userName: i.identity.userName,
        userEmail: i.identity.userEmail,
        nameSource: i.identity.userName ? 'local' : null,
        emailSource: i.identity.userEmail ? 'local' : null,
      }
    },

    refresh: async (params: { workspacePath: string }) => {
      cached.delete(params.workspacePath)
      const i = await infoCached(params.workspacePath)
      return { isRepository: i.isRepository, isGitAvailable: i.isGitAvailable }
    },

    // ── 写操作（N7-3）：host 侧固定参数 git，路径白名单校验（无 shell 面）。──
    stagePaths: async (params: { workspacePath: string; paths: string[] }) => {
      await postGit('/api/git/stage', { directory: params.workspacePath, paths: relPaths(params.paths) })
      cached.delete(params.workspacePath)
      return refreshSummary(params.workspacePath)
    },
    unstagePaths: async (params: { workspacePath: string; paths: string[] }) => {
      await postGit('/api/git/stage', { directory: params.workspacePath, paths: relPaths(params.paths), staged: false })
      cached.delete(params.workspacePath)
      return refreshSummary(params.workspacePath)
    },
    discardPaths: async (params: { workspacePath: string; paths: string[] }) => {
      await postGit('/api/git/discard', { directory: params.workspacePath, paths: relPaths(params.paths) })
      cached.delete(params.workspacePath)
      return refreshSummary(params.workspacePath)
    },
    commit: async (params: { workspacePath: string; message: string; paths?: string[] }) => {
      const out = await postGit<{ commit: string }>('/api/git/commit', {
        directory: params.workspacePath, message: params.message, paths: params.paths ? relPaths(params.paths) : undefined,
      })
      cached.delete(params.workspacePath)
      const i = await infoCached(params.workspacePath)
      return { commitHash: out.commit, summary: { workspacePath: params.workspacePath, repoRoot: i.repoRoot, branchName: i.branchName, isDirty: i.isDirty } }
    },
    push: async (params: { workspacePath: string }) => {
      const out = await postGit<{ ok: boolean; error?: string }>('/api/git/push', { directory: params.workspacePath })
      if (!out.ok) throw new Error(out.error ?? 'push failed')
      cached.delete(params.workspacePath)
      const i = await infoCached(params.workspacePath)
      return { branchName: i.branchName, trackingBranchName: i.trackingBranchName, setUpstream: false }
    },
    switchBranch: async (params: { workspacePath: string; targetBranchName: string }) => {
      await postGit('/api/git/branch', { directory: params.workspacePath, branch: params.targetBranchName, create: false })
      cached.delete(params.workspacePath)
      return refreshSummary(params.workspacePath)
    },
    createBranchAndSwitch: async (params: { workspacePath: string; branchName: string }) => {
      await postGit('/api/git/branch', { directory: params.workspacePath, branch: params.branchName, create: true })
      cached.delete(params.workspacePath)
      return refreshSummary(params.workspacePath)
    },
    // 提交信息生成需要一次模型调用（ZCode 走它的 agent）；ocrc 侧不做静默代写。
    generateCommitMessage: async () => { throw new Error('[ocrc-fork] 生成提交信息需要模型调用，/z/ 暂未接（可直接手写提交说明）') },
  })
}
