import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRemotesStore, redactRemote, generateServerPassword, type RemoteHost , redactProxyUrl } from '../../src/core/remotes'

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), 'ocrc-remotes-'))
  const path = join(dir, 'remotes.json')
  return { dir, path, store: createRemotesStore(path) }
}

describe('RemotesStore', () => {
  let env: ReturnType<typeof tmpStore>
  beforeEach(() => { env = tmpStore() })
  afterEach(() => rmSync(env.dir, { recursive: true, force: true }))

  it('upsert generates a password, normalizes defaults, and persists 0600', async () => {
    const saved = env.store.upsert({ host: 'box.lan', user: ' demo ' })
    expect(saved.id).toBeTruthy()
    expect(saved.user).toBe('demo')
    expect(saved.port).toBe(22)
    expect(saved.remotePort).toBe(4199)
    expect(saved.enabled).toBe(true)
    expect(saved.serverPassword).toBeTruthy()

    // Debounced write — give it a beat, then assert on-disk mode + content.
    await new Promise((r) => setTimeout(r, 200))
    expect(existsSync(env.path)).toBe(true)
    expect(statSync(env.path).mode & 0o777).toBe(0o600)
    const raw = JSON.parse(readFileSync(env.path, 'utf-8')) as { remotes: RemoteHost[] }
    expect(raw.remotes).toHaveLength(1)
    expect(raw.remotes[0].host).toBe('box.lan')
  })

  it('upsert with an existing id updates in place and can clear the password', () => {
    const a = env.store.upsert({ id: 'r1', host: 'a.lan' })
    const b = env.store.upsert({ id: 'r1', host: 'b.lan', serverPassword: '' })
    expect(env.store.list()).toHaveLength(1)
    expect(b.host).toBe('b.lan')
    expect(b.serverPassword).toBeUndefined()
    expect(a.id).toBe(b.id)
  })

  it('update/remove round-trip and unknown ids are undefined/false', () => {
    const r = env.store.upsert({ id: 'r2', host: 'c.lan', remotePort: 5000 })
    const upd = env.store.update('r2', { remotePort: 5001, name: ' box ' })
    expect(upd?.remotePort).toBe(5001)
    expect(upd?.name).toBe('box')
    expect(env.store.update('nope', { enabled: false })).toBeUndefined()
    expect(env.store.remove('r2')).toBe(true)
    expect(env.store.remove('r2')).toBe(false)
    expect(env.store.get(r.id)).toBeUndefined()
  })

  it('redactRemote drops the secret but reports its presence', () => {
    const r = env.store.upsert({ id: 'r3', host: 'd.lan' })
    const red = redactRemote(r) as Record<string, unknown>
    expect(red.serverPassword).toBeUndefined()
    expect(red.hasPassword).toBe(true)
    expect(red.host).toBe('d.lan')
  })

  it('generateServerPassword is url-safe and non-empty', () => {
    const pw = generateServerPassword()
    expect(pw.length).toBeGreaterThan(10)
    expect(pw).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(pw).not.toBe(generateServerPassword())
  })
})


describe('redactProxyUrl (0.27)', () => {
  it('scrubs userinfo but keeps the URL usable for display', () => {
    const out = redactProxyUrl('http://user:sekrit@gw.corp:3128')
    expect(out).not.toContain('sekrit')
    expect(out).toContain('***@gw.corp:3128')
  })
  it('leaves clean URLs and non-URLs untouched', () => {
    expect(redactProxyUrl('http://gw.corp:3128')).toBe('http://gw.corp:3128/')
    expect(redactProxyUrl('gw.corp:3128')).toBe('gw.corp:3128')
    expect(redactProxyUrl(undefined)).toBeUndefined()
  })
})
