import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// E1 dual-write rule (docs/research/e1-verdict.md): install writes the V2
// `plugins` array unless the config carries a V1 `plugin` array (1.18.x host);
// uninstall cleans ocrc entries from BOTH keys. openchamber's managed
// materialization may own the V1 key with an object shape — it must survive.

const PKG = '@bd7pil/ocrc'

// The install/uninstall modules read OPENCODE_CONFIG_DIR at import time, so
// point it at a fresh temp home BEFORE importing them.
const home = mkdtempSync(join(tmpdir(), 'ocrc-pluginkey-'))
process.env.OPENCODE_CONFIG_DIR = join(home, '.config', 'opencode')
mkdirSync(process.env.OPENCODE_CONFIG_DIR, { recursive: true })

const { runInstall } = await import('../../../src/cli/install.js')
const { runUninstall } = await import('../../../src/cli/uninstall.js')

const configPath = () => join(process.env.OPENCODE_CONFIG_DIR!, 'opencode.json')
const read = (): Record<string, any> => JSON.parse(readFileSync(configPath(), 'utf-8'))

// Silence install's interactive path: -y + no token env.
beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = ''
  process.env.ALLOWED_USER_IDS = ''
})
afterEach(() => {
  rmSync(configPath(), { force: true })
})

describe('plugin key generation contract (E1 dual-write rule)', () => {
  it('writes the V2 `plugins` array on a config without a V1 key', async () => {
    writeFileSync(configPath(), JSON.stringify({ plugins: ['other-plugin'] }))
    await runInstall({ yes: true })
    const c = read()
    expect(c.plugins).toContain(PKG)
    expect(c.plugins).toContain('other-plugin')
    expect(c.plugin).toBeUndefined()
  })

  it('creates the `plugins` array from scratch', async () => {
    writeFileSync(configPath(), JSON.stringify({ model: 'x' }))
    await runInstall({ yes: true })
    expect(read().plugins).toEqual([PKG])
  })

  it('writes the V1 `plugin` array only when it already exists (1.18.x host)', async () => {
    writeFileSync(configPath(), JSON.stringify({ plugin: ['legacy-plugin'] }))
    await runInstall({ yes: true })
    const c = read()
    expect(c.plugin).toContain(PKG)
    expect(c.plugin).toContain('legacy-plugin')
    expect(c.plugins).toBeUndefined()
  })

  it('is idempotent (present → no rewrite)', async () => {
    writeFileSync(configPath(), JSON.stringify({ plugins: [PKG] }))
    await runInstall({ yes: true })
    expect(read().plugins).toEqual([PKG])
  })

  it('uninstall removes ocrc from `plugins` but leaves siblings', async () => {
    writeFileSync(configPath(), JSON.stringify({ plugins: [PKG, 'omo-slim'] }))
    await runUninstall()
    expect(read().plugins).toEqual(['omo-slim'])
  })

  it('uninstall cleans BOTH keys (legacy dual-key installs)', async () => {
    writeFileSync(configPath(), JSON.stringify({ plugin: [PKG], plugins: [PKG, 'omo-slim'] }))
    await runUninstall()
    const c = read()
    expect(c.plugin).toBeUndefined()
    expect(c.plugins).toEqual(['omo-slim'])
  })

  it('uninstall never touches an openchamber-owned object-shaped `plugin` key', async () => {
    const managed = { '@openchamber/managed-tools': [{ tools: ['websearch'] }] }
    writeFileSync(configPath(), JSON.stringify({ plugin: managed, plugins: [PKG] }))
    await runUninstall()
    const c = read()
    // Object key untouched (not an array — filtered out by design), ocrc gone from plugins.
    expect(c.plugin).toEqual(managed)
    expect(c.plugins).toBeUndefined()
  })
})
