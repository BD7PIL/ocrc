import { describe, it, expect, afterEach } from 'vitest'
import { tryBecomePrimary, currentPrimary, readPrimaryOwner } from '../../src/core/primary-election'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'ocrc-elect-'))
const lock = join(tmp, 'primary.lock')
afterEach(() => { try { rmSync(lock) } catch { /* ignore */ } })

describe('tryBecomePrimary', () => {
  it('first caller becomes PRIMARY', () => {
    const a = tryBecomePrimary(lock)
    expect(a.isPrimary).toBe(true)
    a.release()
  })

  it('second caller is PASSIVE while a live pid holds the lock', () => {
    const a = tryBecomePrimary(lock)
    const b = tryBecomePrimary(lock) // our own pid is alive
    expect(a.isPrimary).toBe(true)
    expect(b.isPrimary).toBe(false)
    a.release()
  })

  it('reclaims a stale lock whose owner pid is dead', () => {
    writeFileSync(lock, JSON.stringify({ pid: 2147483646, startedAt: 1 })) // not a live pid
    const a = tryBecomePrimary(lock)
    expect(a.isPrimary).toBe(true)
    a.release()
  })

  it('reclaims a corrupt lock file (non-JSON content)', () => {
    writeFileSync(lock, 'not-json-garbage')
    const a = tryBecomePrimary(lock)
    expect(a.isPrimary).toBe(true)
    a.release()
  })

  it('release frees the lock so a later caller can win', () => {
    const a = tryBecomePrimary(lock)
    a.release()
    const b = tryBecomePrimary(lock)
    expect(b.isPrimary).toBe(true)
    b.release()
  })

  it('release is idempotent', () => {
    const a = tryBecomePrimary(lock)
    a.release()
    a.release() // must not throw or corrupt state
    const b = tryBecomePrimary(lock)
    expect(b.isPrimary).toBe(true)
    b.release()
  })
})

// P0-2: the lock records WHO owns it, so an ocrc plugin loaded inside an engine
// can tell "another plugin owns the transports" (stand down) from "a host owns
// them" (attach: register tools, own nothing).
describe('primary lock role', () => {
  it('defaults to role=plugin (every pre-P0 caller is the plugin entry)', () => {
    const a = tryBecomePrimary(lock)
    expect(a.isPrimary).toBe(true)
    expect(readPrimaryOwner(lock)?.role).toBe('plugin')
    a.release()
  })

  it('records the role the winner asked for', () => {
    const a = tryBecomePrimary(lock, { role: 'host' })
    expect(a.isPrimary).toBe(true)
    expect(readPrimaryOwner(lock)).toMatchObject({ pid: process.pid, role: 'host' })
    a.release()
  })

  it('a plugin losing to a live host sees owner.role=host (the ATTACHED signal)', () => {
    const host = tryBecomePrimary(lock, { role: 'host' })
    const plugin = tryBecomePrimary(lock)
    expect(host.isPrimary).toBe(true)
    expect(plugin.isPrimary).toBe(false)
    expect(plugin.owner?.role).toBe('host')
    host.release()
  })

  it('a plugin losing to a live plugin sees owner.role=plugin (stand down)', () => {
    const first = tryBecomePrimary(lock)
    const second = tryBecomePrimary(lock)
    expect(second.isPrimary).toBe(false)
    expect(second.owner?.role).toBe('plugin')
    first.release()
  })

  it('currentPrimary reports a live owner and treats a legacy role-less lock as plugin', () => {
    writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: 1 }))
    expect(currentPrimary(lock)).toMatchObject({ pid: process.pid })
    expect(currentPrimary(lock)?.role).toBeUndefined()
  })

  it('currentPrimary ignores an absent, corrupt, or dead-pid lock', () => {
    expect(currentPrimary(lock)).toBeUndefined()
    writeFileSync(lock, 'garbage')
    expect(currentPrimary(lock)).toBeUndefined()
    writeFileSync(lock, JSON.stringify({ pid: 2147483646, startedAt: 1, role: 'host' }))
    expect(currentPrimary(lock)).toBeUndefined()
  })

  it('a stale host lock does not block a plugin from becoming primary', () => {
    writeFileSync(lock, JSON.stringify({ pid: 2147483646, startedAt: 1, role: 'host' }))
    const a = tryBecomePrimary(lock)
    expect(a.isPrimary).toBe(true)
    expect(readPrimaryOwner(lock)?.role).toBe('plugin')
    a.release()
  })

  it('host release hands the lock to a plugin that then wins', () => {
    const host = tryBecomePrimary(lock, { role: 'host' })
    host.release()
    const plugin = tryBecomePrimary(lock)
    expect(plugin.isPrimary).toBe(true)
    expect(readPrimaryOwner(lock)?.role).toBe('plugin')
    plugin.release()
  })

  it('a losing instance never deletes the winner’s lock on release', () => {
    const host = tryBecomePrimary(lock, { role: 'host' })
    const plugin = tryBecomePrimary(lock)
    plugin.release()
    expect(readFileSync(lock, 'utf-8')).toContain('"role":"host"')
    host.release()
  })
})
