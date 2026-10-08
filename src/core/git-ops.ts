/**
 * N6 Git 只读面：/z/ 的 Git 面板要 repoRoot / ahead-behind / numstat / 本地分支 /
 * identity，ocrc 既有的 /api/vcs 只给 branch + porcelain status。
 * 这里用固定参数的 git 调用补齐（无用户输入拼接，execFile 参数数组）。
 * 写操作（stage/commit/push/branch 切换）在批次 3 落地，这里只读。
 */
import { execFile } from 'node:child_process'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'

export interface GitFileChange {
  path: string
  index: string
  worktree: string
  additions: number
  removed: number
}

export interface GitInfo {
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
  changes: GitFileChange[]
}

function run(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 20_000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(String(stdout))
    })
  })
}

async function tryRun(cwd: string, args: string[]): Promise<string | null> {
  try { return await run(cwd, args) } catch { return null }
}

/** numstat 输出 `additions\tdeletions\tpath`（二进制是 `-\t-\tpath`）。 */
function parseNumstat(out: string | null): Map<string, { additions: number; removed: number }> {
  const map = new Map<string, { additions: number; removed: number }>()
  for (const line of (out ?? '').split('\n')) {
    if (!line.trim()) continue
    const [a, d, ...rest] = line.split('\t')
    const path = rest.join('\t').trim()
    if (!path) continue
    map.set(path, {
      additions: Number.parseInt(a ?? '0', 10) || 0,
      removed: Number.parseInt(d ?? '0', 10) || 0,
    })
  }
  return map
}

export async function gitInfo(workspacePath: string): Promise<GitInfo> {
  const empty: GitInfo = {
    isGitAvailable: false, isRepository: false, repoRoot: '', workspaceInRepoPath: '',
    branchName: null, trackingBranchName: null, ahead: 0, behind: 0, isDirty: false,
    branches: [], identity: { userName: null, userEmail: null }, changes: [],
  }
  if (!workspacePath) return empty

  const repoRoot = await tryRun(workspacePath, ['rev-parse', '--show-toplevel'])
  if (repoRoot === null) {
    // Distinguish "git missing" from "not a repo" for the UI's empty state.
    const version = await tryRun(workspacePath, ['--version'])
    return { ...empty, isGitAvailable: version !== null }
  }
  const root = repoRoot.trim()
  const branchName = (await tryRun(workspacePath, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim() ?? null
  const tracking = (await tryRun(workspacePath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']))?.trim() ?? null
  let ahead = 0
  let behind = 0
  if (tracking) {
    const counts = (await tryRun(workspacePath, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']))?.trim()
    const [b, a] = (counts ?? '').split(/\s+/)
    behind = Number.parseInt(b ?? '0', 10) || 0
    ahead = Number.parseInt(a ?? '0', 10) || 0
  }

  const status = (await tryRun(workspacePath, ['status', '--porcelain=v1'])) ?? ''
  const unstaged = parseNumstat(await tryRun(workspacePath, ['diff', '--numstat']))
  const staged = parseNumstat(await tryRun(workspacePath, ['diff', '--cached', '--numstat']))
  const changes: GitFileChange[] = []
  for (const line of status.split('\n')) {
    if (!line.trim()) continue
    const index = line[0] ?? ' '
    const worktree = line[1] ?? ' '
    let path = line.slice(3)
    if (path.includes(' -> ')) path = path.split(' -> ').pop() ?? path
    path = path.replace(/^"|"$/g, '')
    const nums = unstaged.get(path) ?? staged.get(path) ?? { additions: 0, removed: 0 }
    changes.push({ path, index, worktree, additions: nums.additions, removed: nums.removed })
  }

  const branchOut = (await tryRun(workspacePath, ['branch', '--format=%(refname:short)\t%(HEAD)'])) ?? ''
  const branches = branchOut.split('\n').filter(Boolean).map((l) => {
    const [name = '', head = ''] = l.split('\t')
    return { name, current: head.trim() === '*' }
  })

  const userName = (await tryRun(workspacePath, ['config', 'user.name']))?.trim() ?? null
  const userEmail = (await tryRun(workspacePath, ['config', 'user.email']))?.trim() ?? null

  return {
    isGitAvailable: true,
    isRepository: true,
    repoRoot: root,
    workspaceInRepoPath: workspacePath.startsWith(root) ? workspacePath.slice(root.length + 1) : '',
    branchName: branchName && branchName !== 'HEAD' ? branchName : null,
    trackingBranchName: tracking,
    ahead,
    behind,
    isDirty: changes.length > 0,
    branches,
    identity: { userName: userName || null, userEmail: userEmail || null },
    changes,
  }
}

export async function gitDiff(workspacePath: string, path: string, opts: { staged?: boolean } = {}): Promise<{ patch: string | null; availability: string }> {
  if (!workspacePath || !path) return { patch: null, availability: 'path-missing' }
  const args = ['diff', '--no-color']
  if (opts.staged) args.push('--cached')
  args.push('--', path)
  const patch = await tryRun(workspacePath, args)
  if (patch === null) return { patch: null, availability: 'error' }
  if (!patch.trim()) return { patch: null, availability: 'no-changes' }
  return { patch, availability: 'available' }
}

// ── 写操作（N7-3）。全部走固定参数 execFile（无 shell、无字符串拼接）；
//    路径必须是仓库内相对路径，越界一律拒绝。push 依赖用户自己的凭证配置。 ──

const SAFE_PATH = /^(?!\/)(?!\.\.)[\w.\-/@+]{1,500}$/

function assertSafePaths(paths: readonly string[]): void {
  if (!paths.length) throw new Error('paths required')
  for (const p of paths) {
    if (!SAFE_PATH.test(p) || p.includes('..')) throw new Error(`非法路径：${p}`)
  }
}

export async function gitStage(
  cwd: string,
  paths: readonly string[],
  staged: boolean,
): Promise<void> {
  assertSafePaths(paths)
  const args = staged ? ['add', '--'] : ['reset', '--']
  await run(cwd, [...args, ...paths])
}

export async function gitDiscard(cwd: string, paths: readonly string[]): Promise<void> {
  assertSafePaths(paths)
  const status = await run(cwd, ['status', '--porcelain=v1'])
  const untracked = new Set(
    status.split('\n').filter((l) => l.startsWith('??')).map((l) => l.slice(3).trim()),
  )
  const tracked = paths.filter((p) => !untracked.has(p))
  const unlisted = paths.filter((p) => untracked.has(p))
  if (tracked.length) await run(cwd, ['checkout', '--', ...tracked])
  // 未跟踪文件的 discard 语义 = 删除（ZCode 一致）。`git rm` 只认已跟踪文件，
  // 所以未跟踪的走 fs 删除；路径已过 assertSafePaths，且只删 git 确认过未跟踪的那几个。
  for (const p of unlisted) {
    try { await unlink(join(cwd, p)) } catch { /* 已不存在 = 目标状态已达成 */ }
  }
}

export async function gitCommit(cwd: string, message: string, paths?: readonly string[]): Promise<{ commit: string; output?: string }> {
  if (!message.trim()) throw new Error('commit message required')
  if (message.includes('\0')) throw new Error('commit message 含非法字符')
  if (paths?.length) await gitStage(cwd, paths, true)
  const out = await run(cwd, ['commit', '-m', message])
  const commit = (await tryRun(cwd, ['rev-parse', '--short', 'HEAD']))?.trim() ?? ''
  return { commit, output: out.trim().split('\n')[0] ?? '' }
}

export async function gitPush(cwd: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await run(cwd, ['push'])
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message.split('\n')[0] }
  }
}

export async function gitSwitchBranch(cwd: string, branch: string, create: boolean): Promise<void> {
  // 分支名走引用规则白名单：拒绝空白/~/^/:/?/*/[/\\ 与 ..，防引用歧义。
  if (!/^(?!\/)(?!\.\.)[^\s~^:?*\[\\]{1,200}$/.test(branch) || branch.endsWith('.lock') || branch.includes('..')) {
    throw new Error(`非法分支名：${branch}`)
  }
  await run(cwd, create ? ['checkout', '-b', branch] : ['checkout', branch])
}
