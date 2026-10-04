import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { registerRemotes } from '../../../src/transport/web/routes/remotes'

function fakeStore() {
  return {
    list: vi.fn(() => [{ id: 'r1', host: 'box.lan', port: 22, remotePort: 4199, enabled: true, serverPassword: 'sekrit' }]),
    get: vi.fn((id: string) => (id === 'r1' ? { id, host: 'box.lan', port: 22, remotePort: 4199, enabled: true, serverPassword: 'sekrit' } : undefined)),
    upsert: vi.fn((r: any) => ({ id: r.id ?? 'r1', host: r.host, port: 22, remotePort: 4199, enabled: true })),
    update: vi.fn((id: string, patch: any) => ({ id, host: 'box.lan', port: 22, remotePort: 4199, ...patch })),
    remove: vi.fn(() => true),
  } as any
}

function fakeManager(overrides: Record<string, any> = {}) {
  return {
    status: vi.fn(() => ({ id: 'r1', state: 'online', logTail: [] })),
    start: vi.fn(),
    stop: vi.fn(),
    inspect: vi.fn(async () => ({ platform: 'Linux' })),
    provision: vi.fn(async () => ({ ok: true, detail: 'installed' })),
    syncAuth: vi.fn(async () => ({ ok: true, detail: 'credentials synced' })),
    syncConfig: vi.fn(async () => ({ ok: true, detail: 'synced 3 file(s)' })),
    ...overrides,
  } as any
}

function app(store: any, manager: any) {
  const a = new Hono()
  registerRemotes(a, store, manager)
  return a
}

describe('remotes routes — sync-config (0.26.6)', () => {
  it('POST /api/remotes/:id/sync-config returns 200 with the manager detail', async () => {
    const manager = fakeManager()
    const res = await app(fakeStore(), manager).request('/api/remotes/r1/sync-config', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, detail: 'synced 3 file(s)' })
    expect(manager.syncConfig).toHaveBeenCalledWith('r1')
  })

  it('maps manager failure to 502', async () => {
    const manager = fakeManager({ syncConfig: vi.fn(async () => ({ ok: false, detail: 'ssh failed (exit 255)' })) })
    const res = await app(fakeStore(), manager).request('/api/remotes/r1/sync-config', { method: 'POST' })
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ ok: false })
  })

  it('the whole remotes surface stays redacted — serverPassword never leaves the store', async () => {
    const res = await app(fakeStore(), fakeManager()).request('/api/remotes')
    const body = await res.json() as any
    expect(body.remotes[0].serverPassword).toBeUndefined()
    expect(body.remotes[0].hasPassword).toBe(true)
  })
})
