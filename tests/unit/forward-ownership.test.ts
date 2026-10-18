import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearForwardMarker, describeHolders, findHolder, forwardMarkerPath, listForwardMarkers,
  readForwardMarker, writeForwardMarker,
} from '../../src/core/forward-ownership.js'

/**
 * D7 — a forward leg with no owner is what made the worst incident possible:
 * `pairLink` replaced the desktop shell's entry, the `-R` egress leg went with
 * it, and nothing could tell "nobody holds this leg" from "someone else holds
 * it". These tests pin the two behaviours that fix it: a live holder is found
 * (so we reuse instead of fighting over a port), and a dead one is cleared (so a
 * marker can never block a legitimate restart).
 */

const homes: string[] = []
const tmpHome = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocrc-fwd-'))
  homes.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A pid that is certainly gone: spawn a child, wait for it, use its pid. */
async function deadPid(): Promise<number> {
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' })
  const pid = child.pid ?? 0
  await new Promise((resolve) => child.once('exit', resolve))
  return pid
}

describe('forward ownership markers', () => {
  it('round-trips a marker and finds a live holder', () => {
    const home = tmpHome()
    writeForwardMarker({
      instanceId: 'demo@host', kind: 'ui', pid: process.pid, owner: 'service',
      localPort: 4610, startedAt: Date.now(), host: 'host',
    }, home)
    const found = findHolder('demo@host', 'ui', home)
    expect(found.holder?.pid).toBe(process.pid)
    expect(found.holder?.localPort).toBe(4610)
    expect(found.staleCleared).toBe(false)
  })

  it('clears a marker whose process is gone instead of treating it as a holder', async () => {
    const home = tmpHome()
    const pid = await deadPid()
    writeForwardMarker({ instanceId: 'demo@host', kind: 'relay', pid, owner: 'cli', startedAt: Date.now() }, home)
    const found = findHolder('demo@host', 'relay', home)
    // A stale marker must never block a restart…
    expect(found.holder).toBeUndefined()
    expect(found.staleCleared).toBe(true)
    // …and it is cleaned up while we are here.
    expect(existsSync(forwardMarkerPath('demo@host', 'relay', home))).toBe(false)
  })

  it('keeps legs apart: a ui holder is not a relay holder', () => {
    const home = tmpHome()
    writeForwardMarker({ instanceId: 'i', kind: 'ui', pid: process.pid, owner: 'service', startedAt: Date.now() }, home)
    expect(findHolder('i', 'relay', home).holder).toBeUndefined()
    expect(findHolder('i', 'ui', home).holder?.kind).toBe('ui')
  })

  it('keeps instances apart', () => {
    const home = tmpHome()
    writeForwardMarker({ instanceId: 'a@h', kind: 'ui', pid: process.pid, owner: 'service', startedAt: Date.now() }, home)
    expect(findHolder('b@h', 'ui', home).holder).toBeUndefined()
  })

  it('clear removes only that leg', () => {
    const home = tmpHome()
    writeForwardMarker({ instanceId: 'i', kind: 'ui', pid: process.pid, owner: 'service', startedAt: Date.now() }, home)
    writeForwardMarker({ instanceId: 'i', kind: 'pair', pid: process.pid, owner: 'cli', startedAt: Date.now() }, home)
    clearForwardMarker('i', 'ui', home)
    expect(readForwardMarker('i', 'ui', home)).toBeUndefined()
    expect(readForwardMarker('i', 'pair', home)?.kind).toBe('pair')
  })

  it('sanitizes an instance id so an odd host name cannot escape the directory', () => {
    const home = tmpHome()
    writeForwardMarker({ instanceId: '../evil', kind: 'ui', pid: process.pid, owner: 'cli', startedAt: Date.now() }, home)
    const path = forwardMarkerPath('../evil', 'ui', home)
    expect(path.startsWith(join(home, 'forwards'))).toBe(true)
    expect(path).not.toContain('..')
  })

  it('lists every leg with its liveness, for status', async () => {
    const home = tmpHome()
    const pid = await deadPid()
    writeForwardMarker({ instanceId: 'i', kind: 'ui', pid: process.pid, owner: 'service', localPort: 4610, startedAt: Date.now() }, home)
    writeForwardMarker({ instanceId: 'i', kind: 'relay', pid, owner: 'cli', remotePort: 2711, startedAt: Date.now() }, home)
    const all = listForwardMarkers(home)
    expect(all.map((m) => `${m.kind}:${m.alive}`)).toEqual(['relay:false', 'ui:true'])
    const lines = describeHolders('i', home)
    expect(lines.join('\n')).toContain('ui: pid')
    expect(lines.join('\n')).toContain('陈旧标记')
  })

  it('an unreadable marker is not a holder and does not crash the listing', () => {
    const home = tmpHome()
    mkdirSync(join(home, 'forwards'), { recursive: true })
    writeFileSync(join(home, 'forwards', 'broken.ui.json'), '{nope')
    expect(readForwardMarker('broken', 'ui', home)).toBeUndefined()
    expect(listForwardMarkers(home)).toEqual([])
  })

  it('a marker is written as JSON a human can read', () => {
    const home = tmpHome()
    writeForwardMarker({ instanceId: 'i', kind: 'ui', pid: 4242, owner: 'cli', localPort: 4610, startedAt: 1 }, home)
    const raw = readFileSync(forwardMarkerPath('i', 'ui', home), 'utf-8')
    expect(raw).toContain('"pid": 4242')
    expect(raw.endsWith('\n')).toBe(true)
  })
})
