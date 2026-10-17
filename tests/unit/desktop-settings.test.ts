import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  desktopEntryFor, desktopSettingsPath, mergeDesktopEntry, readDesktopSettings, writeDesktopSettings,
} from '../../src/core/desktop-settings.js'
import type { RemoteInstance } from '../../src/core/remote-instance.js'

/**
 * `--desktop-add` writes into the desktop shell's settings. The rules that keep
 * it from destroying a user's config: refuse while the app runs, back up once,
 * upsert exactly one id, and never write the password.
 */

const instance = (over: Partial<RemoteInstance> = {}): RemoteInstance => ({
  id: 'demo@192.168.26.101', host: '192.168.26.101', user: 'demo', port: 22,
  instancePort: 2610, localPort: 4610, appVersion: '2.3.3', enabled: true,
  uiPassword: 'pw-secret', name: 'EL7 box', ...over,
} as RemoteInstance)

let dir = ''
let file = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ocrc-desktop-'))
  file = join(dir, 'settings.json')
  delete process.env.OPENCHAMBER_DATA_DIR
})

afterEach(() => {
  delete process.env.OPENCHAMBER_DATA_DIR
  rmSync(dir, { recursive: true, force: true })
})

describe('desktopEntryFor', () => {
  it('builds an external instance the desktop shell accepts, without the password', () => {
    const entry = desktopEntryFor(instance())
    expect(entry.remoteOpenchamber.mode).toBe('external')
    expect(entry.remoteOpenchamber.preferredPort).toBe(2610)
    expect(entry.sshCommand).toBe('ssh demo@192.168.26.101')
    expect(entry.auth.openchamberPassword).toEqual({ enabled: true, store: 'never' })
    expect(JSON.stringify(entry)).not.toContain('pw-secret')
    expect(entry.portForwards).toEqual([])
  })

  it('carries a non-default ssh port and an optional reverse relay forward', () => {
    const entry = desktopEntryFor(instance({ port: 2222 }), { reverseRelay: { remotePort: 2711, localPort: 4711 } })
    expect(entry.sshCommand).toBe('ssh demo@192.168.26.101 -p 2222')
    expect(entry.portForwards).toEqual([
      { id: 'demo@192.168.26.101-relay', enabled: true, type: 'remote', localHost: '127.0.0.1', localPort: 4711, remoteHost: '127.0.0.1', remotePort: 2711 },
    ])
  })
})

describe('mergeDesktopEntry', () => {
  it('preserves unrelated keys and other instances', () => {
    const root = {
      desktopSshInstances: [{ id: 'other' }, { id: 'demo@192.168.26.101', nickname: 'old' }],
      desktopDefaultHostId: 'other',
      lightThemeId: 'openchamber-light',
    }
    const merged = mergeDesktopEntry(root, desktopEntryFor(instance()))
    expect(merged.lightThemeId).toBe('openchamber-light')
    expect(merged.desktopDefaultHostId).toBe('other')
    const list = merged.desktopSshInstances as Array<{ id: string; nickname?: string }>
    expect(list.map((i) => i.id).sort()).toEqual(['demo@192.168.26.101', 'other'])
    expect(list.find((i) => i.id === 'demo@192.168.26.101')?.nickname).toBe('EL7 box')
  })

  it('can point the default host at the new entry', () => {
    const merged = mergeDesktopEntry({ desktopSshInstances: [] }, desktopEntryFor(instance()), { setDefault: true })
    expect(merged.desktopDefaultHostId).toBe('demo@192.168.26.101')
  })
})

describe('read/writeDesktopSettings', () => {
  it('an absent file reads as {}', () => {
    expect(readDesktopSettings(file)).toEqual({})
  })

  it('a malformed file is reported, not silently replaced', () => {
    writeFileSync(file, '[1,2,3]')
    expect(() => readDesktopSettings(file)).toThrow(/拒绝改写/)
  })

  it('refuses to write while the desktop app is running', () => {
    writeFileSync(file, JSON.stringify({ desktopSshInstances: [] }))
    const before = readFileSync(file, 'utf-8')
    const result = writeDesktopSettings(file, mergeDesktopEntry(readDesktopSettings(file), desktopEntryFor(instance())), { appRunning: true })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('正在运行')
    expect(readFileSync(file, 'utf-8')).toBe(before)
  })

  it('writes atomically, keeps one backup, and upserts idempotently', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify({ desktopSshInstances: [], foo: 'bar' }, null, 2))
    const entry = desktopEntryFor(instance())

    const first = writeDesktopSettings(file, mergeDesktopEntry(readDesktopSettings(file), entry))
    expect(first.ok).toBe(true)
    expect(existsSync(`${file}.ocrc-bak`)).toBe(true)
    const written = readDesktopSettings(file)
    expect(written.foo).toBe('bar')
    expect((written.desktopSshInstances as unknown[]).length).toBe(1)
    expect(JSON.stringify(written)).not.toContain('pw-secret')

    // Second write with the same id replaces rather than appends.
    const second = writeDesktopSettings(file, mergeDesktopEntry(readDesktopSettings(file), entry))
    expect(second.ok).toBe(true)
    expect((readDesktopSettings(file).desktopSshInstances as unknown[]).length).toBe(1)
  })
})

describe('desktopSettingsPath', () => {
  it('honours OPENCHAMBER_DATA_DIR', () => {
    process.env.OPENCHAMBER_DATA_DIR = dir
    expect(desktopSettingsPath('/nope')).toBe(join(dir, 'settings.json'))
  })
})