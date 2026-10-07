import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 0.27 M8 — cross-process bot runtime lock (ZCode channelRuntime register).
 * Atomic tmp+rename acquire, lease heartbeat, pid-liveness stale reclaim.
 * Prevents two ocrc processes (e.g. host + a second debug host) from both
 * long-polling the same bot token — the 409 tug-of-war that used to end in
 * "8 retries then give up".
 */

export interface RuntimeLockInfo {
  pid: number
  host: string
  acquiredAt: number
  leaseExpiresAt: number
}

const LEASE_MS = 15_000

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface RuntimeLock {
  /** Heartbeat + re-assert. Returns false if the lock was taken by someone
   *  else (caller should stop polling). */
  heartbeat(): boolean
  release(): void
}

export function acquireRuntimeLock(path: string, leaseMs = LEASE_MS): RuntimeLock | null {
  mkdirSync(dirname(path), { recursive: true })

  const read = (): RuntimeLockInfo | null => {
    try { return JSON.parse(readFileSync(path, 'utf-8')) as RuntimeLockInfo } catch { return null }
  }

  const tryClaim = (): boolean => {
    try {
      // atomic create-only: O_EXCL semantics via 'wx'
      writeFileSync(path, JSON.stringify(info()), { flag: 'wx' })
      return true
    } catch {
      return false
    }
  }

  const info = (): RuntimeLockInfo => ({
    pid: process.pid,
    host: require_hostname(),
    acquiredAt: Date.now(),
    leaseExpiresAt: Date.now() + leaseMs,
  })

  // fast path: claim an absent/stale lock
  const existing = read()
  if (existing) {
    const pidAlive = existsSync('/proc/' + existing.pid) || alive(existing.pid)
    const leaseValid = existing.leaseExpiresAt > Date.now()
    if (pidAlive && (leaseValid || existing.pid !== process.pid)) {
      if (existing.pid === process.pid) {
        // our own leftover (same process re-entry) — reassert
      } else {
        return null
      }
    }
    // stale: dead pid or expired lease with no live holder → steal by rename
    const tmp = `${path}.${process.pid}.steal`
    writeFileSync(tmp, JSON.stringify(info()))
    rmSync(path, { force: true })
    renameSync(tmp, path)
  } else if (!tryClaim()) {
    // lost a race on first claim — one stale-check retry
    const again = read()
    if (again && alive(again.pid) && again.leaseExpiresAt > Date.now()) return null
    const tmp = `${path}.${process.pid}.steal`
    writeFileSync(tmp, JSON.stringify(info()))
    rmSync(path, { force: true })
    renameSync(tmp, path)
  }

  const handle: RuntimeLock = {
    heartbeat() {
      const cur = read()
      if (cur && cur.pid !== process.pid && alive(cur.pid) && cur.leaseExpiresAt > Date.now()) return false
      writeFileSync(path, JSON.stringify({ ...info(), acquiredAt: cur?.acquiredAt ?? Date.now() }))
      return true
    },
    release() {
      const cur = read()
      if (cur?.pid === process.pid) rmSync(path)
    },
  }

  // keep the lease fresh for the lifetime of the transport
  const hb = setInterval(() => {
    try { if (!handle.heartbeat()) handle.release() } catch { /* best effort */ }
  }, leaseMs / 3)
  hb.unref?.()
  const origRelease = handle.release
  handle.release = () => { clearInterval(hb); origRelease() }

  return handle
}

function require_hostname(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('node:os') as typeof import('node:os')).hostname()
  } catch {
    return 'unknown'
  }
}

