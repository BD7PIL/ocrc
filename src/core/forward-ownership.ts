/**
 * D7 — who owns a forward.
 *
 * The root cause of the worst incident in this work was not a bug in any one
 * spawn: it was that a forward leg had **no owner**. `pairLink` replaced the
 * desktop shell's instance entry, the `-R` egress leg went with it, and nothing
 * could tell "nobody is holding this leg" from "someone else is holding it" —
 * the peer simply lost its egress and every call failed with ECONNREFUSED.
 *
 * The fix is a marker, not a lock server: whoever spawns a forward writes
 * `<ocrcHome>/forwards/<instanceId>.<kind>.json` with its pid, port and role, and
 * removes it when the process exits. Two consequences, both cheap:
 *
 *   · **Before spawning, look.** A live marker for the same (instance, kind)
 *     means someone already holds that leg — reuse it instead of fighting over
 *     the port (`ExitOnForwardFailure` turns a second `-L` into a reconnect loop).
 *   · **When something fails, say who.** A busy local port now reports the holder
 *     instead of an opaque ssh error, which is what the user needs to decide
 *     whether to stop the other holder or move the port.
 *
 * A stale marker (dead pid, or a pid we cannot check) is treated as "free" and
 * cleaned up on the next look: a marker that outlives its process must never
 * block a legitimate restart.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ocrcHome } from '../utils/paths.js'

/** Which leg of the topology a forward is. */
export type ForwardKind = 'ui' | 'relay' | 'pair'

export interface ForwardMarker {
  instanceId: string
  kind: ForwardKind
  pid: number
  /** Control-side port the leg binds (for `ui`/`pair`) or the relay listener it
   *  feeds (for `relay`). */
  localPort?: number
  /** Peer-side port, when the leg creates one (`relay`). */
  remotePort?: number
  /** Who spawned it — the two owners behave differently on exit. */
  owner: 'service' | 'cli' | 'unknown'
  startedAt: number
  host?: string
}

export function forwardMarkerDir(home = ocrcHome()): string {
  return join(home, 'forwards')
}

export function forwardMarkerPath(instanceId: string, kind: ForwardKind, home = ocrcHome()): string {
  // Dots are legal inside a host name (`192.0.2.10`) but a name that is
  // *only* dots would climb out of the directory — strip leading dots rather
  // than allowlisting a character that can form `..`.
  const safe = instanceId.replace(/[^A-Za-z0-9._@-]/g, '-').replace(/^\.+/, '_') || '_'
  return join(forwardMarkerDir(home), `${safe}.${kind}.json`)
}

function isAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    // Signal 0 asks "may I signal it" without signalling: ESRCH = gone, EPERM =
    // alive but not ours (still a holder we must not fight).
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function writeForwardMarker(marker: ForwardMarker, home = ocrcHome()): void {
  try {
    mkdirSync(forwardMarkerDir(home), { recursive: true })
    writeFileSync(forwardMarkerPath(marker.instanceId, marker.kind, home), `${JSON.stringify(marker, null, 2)}\n`)
  } catch {
    /* markers are diagnostics + a guard, never a reason to fail a start */
  }
}

export function clearForwardMarker(instanceId: string, kind: ForwardKind, home = ocrcHome()): void {
  try {
    rmSync(forwardMarkerPath(instanceId, kind, home), { force: true })
  } catch {
    /* best effort */
  }
}

export function readForwardMarker(instanceId: string, kind: ForwardKind, home = ocrcHome()): ForwardMarker | undefined {
  const path = forwardMarkerPath(instanceId, kind, home)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as ForwardMarker
  } catch {
    return undefined
  }
}

export interface HolderLookup {
  /** A live holder of that leg, when there is one. */
  holder?: ForwardMarker
  /** True when a marker existed but its process is gone (cleaned up here). */
  staleCleared: boolean
}

/** Look before spawning: a live holder means "reuse it", a stale one means "go". */
export function findHolder(instanceId: string, kind: ForwardKind, home = ocrcHome()): HolderLookup {
  const marker = readForwardMarker(instanceId, kind, home)
  if (!marker) return { staleCleared: false }
  if (isAlive(marker.pid)) return { holder: marker, staleCleared: false }
  clearForwardMarker(instanceId, kind, home)
  return { staleCleared: true }
}

/** Every marker on disk with its liveness, for `status`/diagnostics. */
export function listForwardMarkers(home = ocrcHome()): Array<ForwardMarker & { alive: boolean }> {
  const dir = forwardMarkerDir(home)
  if (!existsSync(dir)) return []
  const out: Array<ForwardMarker & { alive: boolean }> = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    try {
      const marker = JSON.parse(readFileSync(join(dir, name), 'utf-8')) as ForwardMarker
      out.push({ ...marker, alive: isAlive(marker.pid) })
    } catch {
      /* unreadable marker: not a holder */
    }
  }
  return out.sort((a, b) => `${a.instanceId}.${a.kind}`.localeCompare(`${b.instanceId}.${b.kind}`))
}

/** One line a human can act on: who holds which leg of this instance. */
export function describeHolders(instanceId: string, home = ocrcHome()): string[] {
  const kinds: ForwardKind[] = ['ui', 'relay', 'pair']
  const lines: string[] = []
  for (const kind of kinds) {
    const marker = readForwardMarker(instanceId, kind, home)
    if (!marker) continue
    const alive = isAlive(marker.pid)
    lines.push(`${kind}: pid ${marker.pid}（${marker.owner}${marker.localPort ? `，本地 :${marker.localPort}` : ''}${marker.remotePort ? `，远程 :${marker.remotePort}` : ''}）${alive ? '' : '——进程已不在（陈旧标记）'}`)
  }
  return lines
}
