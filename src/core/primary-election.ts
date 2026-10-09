import { openSync, closeSync, writeSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createLogger } from '../utils/logger.js'
import { ocrcHome } from '../utils/paths.js'

const log = createLogger('election')

/**
 * Who owns the primary lock. Two very different deployments race for the same
 * global resources (web port + Telegram poller):
 *  - `host`: the standalone `ocrc host` process. It owns the transports itself
 *    and the engine it spawns/adopts has NO ocrc plugin inside it.
 *  - `plugin`: an ocrc plugin instance loaded by an opencode process. It owns
 *    the transports only when no host exists (legacy / plugin-mode install).
 *
 * The role is what lets an ocrc plugin inside an engine tell the two apart:
 * seeing a live `host` owner means "attach to that host" (register tools only),
 * not "stand down" and not "start a second Telegram poller".
 */
export type PrimaryRole = 'host' | 'plugin'

export interface PrimaryOwner {
  pid: number
  startedAt: number
  /** Absent on locks written before roles existed — read as `plugin`. */
  role?: PrimaryRole
}

export interface PrimaryLock {
  isPrimary: boolean
  /** Who holds the lock when we are NOT primary (absent when we are). */
  owner?: PrimaryOwner
  release(): void
}

function defaultLockPath(): string {
  return join(ocrcHome(), 'primary.lock')
}

/** Is a process with this pid currently alive? Signal 0 = existence check. */
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

function readOwner(lockPath: string): PrimaryOwner | undefined {
  try {
    if (!existsSync(lockPath)) return undefined
    return JSON.parse(readFileSync(lockPath, 'utf-8')) as PrimaryOwner
  } catch { return undefined }
}

/** Raw lock record, whether or not its owner is still alive. */
export function readPrimaryOwner(lockPath = defaultLockPath()): PrimaryOwner | undefined {
  return readOwner(lockPath)
}

/**
 * The live lock owner, or undefined when the lock is absent, corrupt, or held by
 * a dead pid. This is the "is a host running?" probe behind the plugin's
 * ATTACHED decision (and the host's own duplicate-run warning).
 */
export function currentPrimary(lockPath = defaultLockPath()): PrimaryOwner | undefined {
  const owner = readOwner(lockPath)
  if (!owner || typeof owner.pid !== 'number' || !pidAlive(owner.pid)) return undefined
  return owner
}

function passive(owner?: PrimaryOwner): PrimaryLock {
  return { isPrimary: false, ...(owner ? { owner } : {}), release() { /* nothing to release */ } }
}

/**
 * Elect a single PRIMARY instance via an atomic lock file. opencode 1.17 loads
 * the plugin once per workspace, but the web server and Telegram bot are global
 * singletons — exactly one instance may own them. Creating the lock with O_EXCL
 * ('wx') is the election: the writer wins, everyone else runs PASSIVE. A lock
 * whose owner pid is dead is reclaimed.
 *
 * `role` records WHO won (see {@link PrimaryRole}) so a later caller can decide
 * between "stand down" (another plugin owns it) and "attach" (a host owns it).
 *
 * Note: the stale-lock reclaim path (EEXIST -> dead pid -> unlink -> retry) has
 * a narrow TOCTOU window where two concurrent callers may both unlink. Only one
 * can win the subsequent O_EXCL open, so correctness is preserved, but the
 * function is not formally lock-free in the stale path.
 */
export function tryBecomePrimary(lockPath = defaultLockPath(), opts: { role?: PrimaryRole } = {}): PrimaryLock {
  const role: PrimaryRole = opts.role ?? 'plugin'
  try {
    mkdirSync(dirname(lockPath), { recursive: true })
  } catch (err) {
    log.warn(`election: cannot create lock dir ${dirname(lockPath)}: ${(err as Error).message}`)
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx') // wx = O_CREAT | O_EXCL | O_WRONLY
      writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now(), role }))
      closeSync(fd)
      log.info(`became PRIMARY (pid ${process.pid}, role=${role})`)
      let released = false
      return {
        isPrimary: true,
        release() {
          if (released) return
          released = true
          try {
            if (readOwner(lockPath)?.pid === process.pid) unlinkSync(lockPath)
          } catch { /* ignore */ }
        },
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        log.warn(`election error, running PASSIVE: ${(err as Error).message}`)
        return passive()
      }
      const owner = readOwner(lockPath)
      if (owner && pidAlive(owner.pid)) {
        log.info(`another PRIMARY alive (pid ${owner.pid}, role=${owner.role ?? 'plugin'}), running PASSIVE`)
        return passive(owner)
      }
      log.info('removing stale primary lock, retrying election')
      try { unlinkSync(lockPath) } catch { /* ignore */ }
    }
  }
  return passive()
}
