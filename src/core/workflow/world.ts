import { execFile } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, normalize, relative, sep } from 'node:path'
import { WORLD_READ_CAPS, WorkflowError, type WorldReadOp } from '../../../vendor/zcode-dwf/dist/dynamic-workflow/src/index.js'

/**
 * world.* reads — the driver's side of Boundary A's read primitives.
 *
 * Two rules from the vendored contract drive the whole shape of this file:
 *
 *  1. **Over the cap = reject, never truncate.** A silently partial world view is
 *     handed to a script that will fan out on it, and the fan-out is the expensive
 *     step. So each op probes cap+1 and throws `WorldReadCapExceeded`.
 *  2. **No shell, fixed argv.** `world.run` takes a literal command plus an args
 *     array (the compiler already refused non-literal commands); we exec it directly
 *     with `execFile` and never interpolate into a shell string.
 *
 * `run` is also the one op with an approval gate (P3): this module takes an optional
 * `approve` hook so the policy lives with the caller, not here.
 */

export interface WorldReadDeps {
  /** Default workspace root; each call may override it (a run carries its own). */
  cwd: string
  /**
   * Approval gate for `world.run`. Returns false to refuse. Absent = allow (the
   * host wires the real gate; tests and snippet evaluation omit it).
   */
  approve?: (cmd: string, args: string[], runId?: string) => Promise<boolean> | boolean
  /** Test seam. */
  execFileImpl?: typeof execFile
}

function capExceeded(op: WorldReadOp, detail: string): WorkflowError {
  return new WorkflowError('WorldReadCapExceeded', `world read \`${op}\` exceeded its cap: ${detail}`)
}

/** Driver-side failures are `DriverError` — the engine's error vocabulary is closed
 *  and only `WorldReadCapExceeded` is specific to this boundary. */
function driverError(op: WorldReadOp, detail: string): WorkflowError {
  return new WorkflowError('DriverError', `world read \`${op}\`: ${detail}`)
}
const badArgs = driverError

/** Resolve a workspace-relative path, refusing anything that escapes the root. */
function safeJoin(cwd: string, p: string): string {
  if (typeof p !== 'string' || !p) throw badArgs('read', 'path must be a non-empty string')
  const abs = isAbsolute(p) ? normalize(p) : normalize(join(cwd, p))
  const rel = relative(cwd, abs)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw badArgs('read', `path escapes the workspace: ${p}`)
  }
  return abs
}

const relOf = (cwd: string, abs: string) => relative(cwd, abs).split(sep).join('/')

/** Run a git command in the workspace, returning stdout (utf-8). */
function git(deps: WorldReadDeps, cwd: string, args: string[], maxBytes: number): Promise<string> {
  const exec = deps.execFileImpl ?? execFile
  return new Promise<string>((resolve, reject) => {
    exec('git', args, { cwd, maxBuffer: maxBytes + 64 * 1024, encoding: 'utf-8' }, (err, stdout) => {
      if (err) { reject(new WorkflowError('DriverError', `git ${args.join(' ')} failed: ${err.message}`)); return }
      resolve(String(stdout ?? ''))
    })
  })
}

/** Minimal glob → RegExp, supporting `**`, `*`, `?` and `{a,b}`. */
function globToRegExp(pattern: string): RegExp {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') { out += '.*'; i++ } else out += '[^/]*'
    } else if (c === '?') out += '[^/]'
    else if ('\\^$.|+()[]'.includes(c)) out += `\\${c}`
    else out += c
  }
  return new RegExp(`^${out}$`)
}

function walk(dir: string, cwd: string, out: string[], limit: number): void {
  let entries: string[]
  try { entries = readdirSafe(dir) } catch { return }
  for (const name of entries) {
    if (name === '.git' || name === 'node_modules') continue
    const abs = join(dir, name)
    let st
    try { st = statSync(abs) } catch { continue }
    if (st.isDirectory()) { walk(abs, cwd, out, limit); if (out.length > limit) return }
    else if (st.isFile()) { out.push(relOf(cwd, abs)); if (out.length > limit) return }
  }
}

const readdirSafe = (dir: string): string[] => readdirSync(dir)

export interface WorldReader {
  /** `cwd` overrides the reader's default root — the run's workspace; `runId` is
   *  handed to the approval gate so a decision can be attributed to its run. */
  read(op: WorldReadOp, args: unknown[], cwd?: string, runId?: string): Promise<unknown>
}

export function createWorldReader(deps: WorldReadDeps): WorldReader {
  const caps = WORLD_READ_CAPS
  const str = (v: unknown, op: WorldReadOp, what: string): string => {
    if (typeof v !== 'string' || !v) throw badArgs(op, `${what} must be a non-empty string`)
    return v
  }

  return {
    async read(op, args, cwdOverride, runId) {
      const cwd = cwdOverride ?? deps.cwd
      switch (op) {
        case 'glob': {
          const pattern = str(args[0], op, 'pattern')
          const re = globToRegExp(pattern)
          const all: string[] = []
          walk(cwd, cwd, all, caps.globMaxFiles)
          const matches = all.filter((p) => re.test(p)).sort()
          if (matches.length > caps.globMaxFiles) throw capExceeded(op, `${matches.length} files > ${caps.globMaxFiles}`)
          return matches
        }

        case 'read': {
          const abs = safeJoin(cwd, str(args[0], op, 'path'))
          let st
          try { st = statSync(abs) } catch { throw driverError(op, `no such file: ${String(args[0])}`) }
          if (st.isDirectory()) throw badArgs(op, `${args[0]} is a directory`)
          return readFileSync(abs, 'utf-8')
        }

        case 'grep': {
          const pattern = str(args[0], op, 'pattern')
          const glob = args[1] === undefined ? undefined : str(args[1], op, 'glob')
          const re = new RegExp(pattern)
          const fileRe = glob ? globToRegExp(glob) : undefined
          const all: string[] = []
          walk(cwd, cwd, all, 20_000)
          const matches: Array<{ path: string; line: number; text: string }> = []
          for (const rel of all) {
            if (fileRe && !fileRe.test(rel)) continue
            let text: string
            try { text = readFileSync(join(cwd, rel), 'utf-8') } catch { continue }
            const lines = text.split('\n')
            for (let i = 0; i < lines.length; i++) {
              if (!re.test(lines[i])) continue
              matches.push({ path: rel, line: i + 1, text: lines[i] })
              if (matches.length > caps.grepMaxMatches) {
                throw capExceeded(op, `more than ${caps.grepMaxMatches} matches`)
              }
              if (JSON.stringify(matches).length > caps.grepMaxSerializedBytes) {
                throw capExceeded(op, `serialized result exceeded ${caps.grepMaxSerializedBytes} bytes`)
              }
            }
          }
          return matches
        }

        case 'git-changed-files': {
          const base = args[0] === undefined ? undefined : str(args[0], op, 'base')
          const out = base
            ? await git(deps, cwd, ['diff', '--name-only', base], caps.gitDiffMaxBytes)
            : await git(deps, cwd, ['status', '--porcelain'], caps.gitDiffMaxBytes)
          return out.split('\n')
            .map((l) => (base ? l : l.slice(3)).trim())
            .filter(Boolean)
        }

        case 'git-diff': {
          const base = args[0] === undefined ? undefined : str(args[0], op, 'base')
          const path = args[1] === undefined ? undefined : str(args[1], op, 'path')
          const argv = ['diff', ...(base ? [base] : []), ...(path ? ['--', path] : [])]
          const out = await git(deps, cwd, argv, caps.gitDiffMaxBytes)
          if (Buffer.byteLength(out, 'utf-8') > caps.gitDiffMaxBytes) {
            throw capExceeded(op, `diff exceeded ${caps.gitDiffMaxBytes} bytes`)
          }
          return out
        }

        case 'git-status': {
          const out = await git(deps, cwd, ['status', '--porcelain=v1', '--branch'], caps.gitDiffMaxBytes)
          const lines = out.split('\n').filter(Boolean)
          const branchLine = lines.find((l) => l.startsWith('## '))
          const branch = branchLine?.slice(3).split('...')[0]?.trim()
          const staged: string[] = []
          const unstaged: string[] = []
          const untracked: string[] = []
          for (const l of lines.filter((x) => !x.startsWith('## '))) {
            const code = l.slice(0, 2)
            const file = l.slice(3).trim()
            if (code === '??') { untracked.push(file); continue }
            if (code[0] !== ' ' && code[0] !== '?') staged.push(file)
            if (code[1] !== ' ') unstaged.push(file)
          }
          return {
            ...(branch && branch !== 'HEAD (no branch)' ? { branch } : {}),
            clean: staged.length === 0 && unstaged.length === 0 && untracked.length === 0,
            staged, unstaged, untracked,
          }
        }

        case 'git-log': {
          const count = args[0] === undefined ? caps.gitLogDefaultCount : Number(args[0])
          if (!Number.isFinite(count) || count < 1) throw badArgs(op, `count must be a positive number, got ${String(args[0])}`)
          if (count > caps.gitLogMaxCount) throw capExceeded(op, `count ${count} > ${caps.gitLogMaxCount}`)
          const out = await git(deps, cwd, ['log', `-n${Math.floor(count)}`, '--pretty=format:%H%x1f%s%x1f%an%x1f%aI'], caps.gitDiffMaxBytes)
          return out.split('\n').filter(Boolean).map((l) => {
            const [hash, subject, author, date] = l.split('\x1f')
            return { hash, subject, author, date }
          })
        }

        case 'run': {
          const cmd = str(args[0], op, 'cmd')
          const argv = (args[1] ?? []) as unknown[]
          if (!Array.isArray(argv) || argv.some((a) => typeof a !== 'string')) {
            throw badArgs(op, 'args must be an array of strings')
          }
          const opts = (args[2] ?? {}) as { timeoutMs?: number }
          const timeoutMs = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0
            ? opts.timeoutMs
            : caps.runDefaultTimeoutMs

          if (deps.approve && !(await deps.approve(cmd, argv as string[], runId))) {
            throw driverError(op, `world.run \`${cmd}\` was not approved`)
          }

          const exec = deps.execFileImpl ?? execFile
          return await new Promise((resolve, reject) => {
            exec(cmd, argv as string[], {
              cwd,
              timeout: timeoutMs,
              maxBuffer: caps.runStdoutMaxBytes + caps.runStderrMaxBytes + 64 * 1024,
              encoding: 'utf-8',
            }, (err, stdout, stderr) => {
              const out = String(stdout ?? '')
              const errOut = String(stderr ?? '')
              // Cap = reject (cap+1 probe), same discipline as the reads above.
              if (Buffer.byteLength(out, 'utf-8') > caps.runStdoutMaxBytes) {
                reject(capExceeded(op, `stdout exceeded ${caps.runStdoutMaxBytes} bytes`)); return
              }
              if (Buffer.byteLength(errOut, 'utf-8') > caps.runStderrMaxBytes) {
                reject(capExceeded(op, `stderr exceeded ${caps.runStderrMaxBytes} bytes`)); return
              }
              const e = err as (Error & { code?: number | string }) | null
              // A nonzero exit is a returned outcome, not a failure — the script
              // branches on it. Only a spawn/timeout error is a real error.
              if (e && typeof e.code !== 'number') {
                reject(driverError(op, `world.run \`${cmd}\` failed: ${e.message}`)); return
              }
              resolve({ exitCode: typeof e?.code === 'number' ? e.code : 0, stdout: out, stderr: errOut })
            })
          })
        }

        default:
          throw driverError(op, `unknown op`)
      }
    },
  }
}
