import { describe, it, expect } from 'vitest'
import { buildWorkspaceApplyScript } from '../../src/core/remote-host'
import { createRemoteToolsV1, registerRemoteToolsV2, REMOTE_TOOL_SPECS, type V2ToolRegistrar, type RemoteToolDeps } from '../../src/plugin/remote-tools'
import type { RemoteHostManager } from '../../src/core/remote-host'
import type { RemotesStore, RemoteHost } from '../../src/core/remotes'
import type { BackendRegistry } from '../../src/core/agent/registry'

describe('buildWorkspaceApplyScript (2.0.0-alpha.3 syncDirectory)', () => {
  it('embeds a quoted remote target and keeps the *.ocrc-bak semantics', () => {
    const s = buildWorkspaceApplyScript('~/workspaces/demo')
    expect(s).toContain(`D="'~/workspaces/demo'"`)
    expect(s).toContain('cp -p "$tgt" "$tgt.ocrc-bak"')
    expect(s).toContain('tar -xzf - -C "$S"')
    expect(s).toContain('sync-workspace: applied')
  })

  it('single-quote escaping keeps hostile targets inert', () => {
    const s = buildWorkspaceApplyScript("/tmp/x'; rm -rf ~; '")
    expect(s).toContain(`D="'/tmp/x'\\''; rm -rf ~; '\\'''"`)
  })
})

// ── stores / manager / registry doubles ───────────────────────────────────────

function fakeRemotes(list: Array<Partial<RemoteHost> & { id: string }>): RemotesStore {
  const all = list.map((r) => ({ port: 22, remotePort: 4199, enabled: true, ...r }) as RemoteHost)
  return {
    list: () => all,
    get: (id) => all.find((r) => r.id === id),
    upsert: (r) => ({ port: 22, remotePort: 4199, enabled: true, ...r }) as RemoteHost,
    update: (id, patch) => {
      const cur = all.find((r) => r.id === id)
      if (!cur) return undefined
      Object.assign(cur, patch)
      return cur
    },
    remove: (id) => {
      const i = all.findIndex((r) => r.id === id)
      if (i < 0) return false
      all.splice(i, 1)
      return true
    },
  }
}

function fakeManager(overrides: Partial<Pick<RemoteHostManager, 'syncDirectory' | 'provision' | 'status'>> = {}): RemoteHostManager {
  return {
    assignPort: async () => 40000,
    inspect: async () => ({}),
    provision: async () => ({ ok: true, detail: 'unused' }),
    start: () => {},
    stop: () => {},
    syncAuth: async () => ({ ok: true, detail: '' }),
    syncConfig: async () => ({ ok: true, detail: '' }),
    syncDirectory: async () => ({ ok: true, detail: 'unused' }),
    status: () => undefined,
    statusAll: () => [],
    ensureAll: () => {},
    dispose: () => {},
    ...overrides,
  }
}

function fakeRegistry(backends: Array<{ id: string }>): BackendRegistry {
  const byId = new Map(backends.map((b) => [b.id, { id: b.id, capabilities: {}, createSession: async () => ({ id: `ses_new_${b.id}` }) }]))
  return {
    list: () => [...byId.keys()].map((id) => ({ id, capabilities: {} })),
    all: () => [...byId.entries()].map(([id, b]) => ({ id, backend: b as never })),
    registerBackend: () => {},
    get: (id) => byId.get(id) as never,
    has: (id) => byId.has(id),
    primaryId: () => backends[0]?.id ?? '',
    activeId: () => backends[0]?.id ?? '',
    active: () => byId.get(backends[0]?.id ?? '') as never,
    idForSession: () => backends[0]?.id ?? '',
    forSession: () => byId.get(backends[0]?.id ?? '') as never,
    tag: () => {},
  }
}

const localDeps = (overrides: Parameters<typeof fakeManager>[0] = {}): RemoteToolDeps => ({
  local: {
    remotes: fakeRemotes([
      { id: 'lab', host: '10.0.0.7', remotePort: 4199 },
      { id: 'off', host: '10.0.0.8', enabled: false },
    ]),
    manager: fakeManager(overrides),
    registry: fakeRegistry([{ id: 'primary' }, { id: 'remote:lab' }]),
  },
})

// ── remote_list ───────────────────────────────────────────────────────────────

describe('remote_list handler', () => {
  it('lists only enabled remotes with state and version', async () => {
    const deps = localDeps({
      status: (id) => (id === 'lab' ? { id, state: 'online', localPort: 40123, inspection: { version: '2.0.27', platform: 'linux', arch: 'x86_64' }, logTail: [] } : undefined),
    })
    const tools = createRemoteToolsV1(deps)
    const out = await tools.remote_list.execute({}, {})
    expect(out).toContain('lab: online')
    expect(out).toContain('opencode 2.0.27')
    expect(out).toContain('10.0.0.7:4199')
    expect(out).not.toContain('off')
  })

  it('empty list tells the model where to manage remotes', async () => {
    const deps: RemoteToolDeps = {
      local: { remotes: fakeRemotes([]), manager: fakeManager(), registry: fakeRegistry([{ id: 'primary' }]) },
    }
    const tools = createRemoteToolsV1(deps)
    const out = await tools.remote_list.execute({}, {})
    expect(out).toContain('No enabled ocrc remotes')
    expect(out).toContain('远程主机')
  })
})

// ── remote_sync_workspace ─────────────────────────────────────────────────────

describe('remote_sync_workspace handler', () => {
  it('passes the triple to manager.syncDirectory and returns its detail', async () => {
    let seen: { id: string; opts: { localRoot: string; entries?: string[]; remoteTarget: string } } | undefined
    const deps = localDeps({
      syncDirectory: async (id, opts) => {
        seen = { id, opts }
        return { ok: true, detail: 'synced 3 file(s) to ~/ws' }
      },
    })
    const tools = createRemoteToolsV1(deps)
    const out = await tools.remote_sync_workspace.execute({ remote_id: 'lab', local_root: '/tmp/proj', remote_target: '~/ws' }, {})
    expect(seen).toEqual({ id: 'lab', opts: { localRoot: '/tmp/proj', entries: undefined, remoteTarget: '~/ws' } })
    expect(out).toBe('synced 3 file(s) to ~/ws')
  })

  it('splits space-separated entries', async () => {
    let seen: { id: string; opts: { entries?: string[] } } | undefined
    const deps = localDeps({
      syncDirectory: async (id, opts) => { seen = { id, opts }; return { ok: true, detail: 'ok' } },
    })
    const tools = createRemoteToolsV1(deps)
    await tools.remote_sync_workspace.execute({ remote_id: 'lab', local_root: '/p', remote_target: '~/w', entries: 'src docs' }, {})
    expect(seen?.opts.entries).toEqual(['src', 'docs'])
  })

  it('missing args read as plain tool failures, not throws', async () => {
    const tools = createRemoteToolsV1(localDeps())
    expect(await tools.remote_sync_workspace.execute({}, {})).toContain('remote_id is required')
    expect(await tools.remote_sync_workspace.execute({ remote_id: 'lab' }, {})).toContain('local_root is required')
    expect(await tools.remote_sync_workspace.execute({ remote_id: 'lab', local_root: '/p' }, {})).toContain('remote_target is required')
  })
})

// ── remote_provision ──────────────────────────────────────────────────────────

describe('remote_provision handler', () => {
  it('defaults to path auto and returns the manager detail (drift included)', async () => {
    let seenPath: string | undefined
    const deps = localDeps({
      provision: async (_id, path) => {
        seenPath = path
        return { ok: true, detail: 'drift: remote 1.18.32 != pin 2.0.27' }
      },
    })
    const tools = createRemoteToolsV1(deps)
    const out = await tools.remote_provision.execute({ remote_id: 'lab' }, {})
    expect(seenPath).toBe('auto')
    expect(out).toContain('drift: remote 1.18.32 != pin 2.0.27')
  })

  it('rejects unknown paths', async () => {
    const tools = createRemoteToolsV1(localDeps())
    const out = await tools.remote_provision.execute({ remote_id: 'lab', path: 'sideload' }, {})
    expect(out).toContain('path must be auto | push | install')
  })
})

// ── remote_create_session ─────────────────────────────────────────────────────

describe('remote_create_session handler', () => {
  it('creates on the remote:<id> backend and tags it', async () => {
    const registry = fakeRegistry([{ id: 'primary' }, { id: 'remote:lab' }])
    let tagged: [string, string] | undefined
    registry.tag = (sid, bid) => { tagged = [sid, bid] }
    const deps: RemoteToolDeps = { local: { remotes: fakeRemotes([{ id: 'lab', host: 'h' }]), manager: fakeManager(), registry } }
    const tools = createRemoteToolsV1(deps)
    const out = await tools.remote_create_session.execute({ remote_id: 'lab', directory: '/home/u/work', title: 'demo' }, {})
    expect(out).toContain('ses_new_remote:lab')
    expect(out).toContain('/home/u/work')
    expect(tagged).toEqual(['ses_new_remote:lab', 'remote:lab'])
  })

  it('unknown remote id reads as a normal failure with a hint', async () => {
    const tools = createRemoteToolsV1(localDeps())
    const out = await tools.remote_create_session.execute({ remote_id: 'nope', directory: '/x' }, {})
    expect(out).toContain('no backend remote:nope')
    expect(out).toContain('is the remote enabled?')
  })
})

// ── spec shape + V2 mounting ──────────────────────────────────────────────────

describe('V2 registration (E2-verified contract)', () => {
  it('specs cover the four names with required args declared', () => {
    expect(REMOTE_TOOL_SPECS.map((s) => s.name)).toEqual(['remote_list', 'remote_sync_workspace', 'remote_provision', 'remote_create_session', 'remote_sync_auth'])
    const sync = REMOTE_TOOL_SPECS.find((s) => s.name === 'remote_sync_workspace')!
    expect(Object.keys(sync.args).sort()).toEqual(['entries', 'local_root', 'remote_id', 'remote_target'])
    expect(sync.args.remote_id.required).toBe(true)
  })

  it('registerRemoteToolsV2 adds four tools with namespace ocrc and {output} execute', async () => {
    const added: Array<Record<string, unknown>> = []
    const registrar: V2ToolRegistrar = {
      transform: async (fn) => {
        await fn({
          add: (t) => added.push(t as Record<string, unknown>),
          update: () => {},
          remove: () => {},
          list: () => [],
        })
      },
    }
    await registerRemoteToolsV2(registrar, localDeps())
    expect(added.map((t) => t.name)).toEqual(['remote_list', 'remote_sync_workspace', 'remote_provision', 'remote_create_session', 'remote_sync_auth'])
    for (const t of added) {
      expect((t.options as { namespace?: string }).namespace).toBe('ocrc')
      expect(t.output).toEqual({ output: { type: 'string' } })
      expect(typeof t.execute).toBe('function')
    }
  })

  it('v2 execute returns {output} with the handler result', async () => {
    const added: Array<Record<string, unknown>> = []
    const registrar: V2ToolRegistrar = {
      transform: async (fn) => {
        await fn({ add: (t) => added.push(t as Record<string, unknown>), update: () => {}, remove: () => {}, list: () => [] })
      },
    }
    await registerRemoteToolsV2(registrar, localDeps({ status: (id) => (id === 'lab' ? { id, state: 'online', logTail: [] } : undefined) }))
    const list = added.find((t) => t.name === 'remote_list')!
    const res = await (list.execute as (args: unknown, ctx: unknown) => Promise<{ output: string }>)({}, {})
    expect(res.output).toContain('lab: online')
  })
})

// ── ATTACHED mounting: handlers proxy to the host API ─────────────────────────

describe('attached mounting (host-proxy handlers)', () => {
  it('remote_list hits /api/remotes with the host token and formats enabled only', async () => {
    const calls: string[] = []
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(String(url))
      return new Response(JSON.stringify({ remotes: [
        { id: 'lab', host: 'h', port: 22, remotePort: 4199, enabled: true, status: { state: 'online' } },
        { id: 'x', host: 'h', port: 22, remotePort: 4199, enabled: false, status: null },
      ] }), { status: 200 })
    }) as typeof fetch
    try {
      const tools = createRemoteToolsV1({ attached: { baseUrl: 'http://127.0.0.1:4092', resolveToken: () => 'tok', version: 'test' } })
      const out = await tools.remote_list.execute({}, {})
      expect(calls[0]).toBe('http://127.0.0.1:4092/api/remotes')
      expect(out).toContain('lab: online')
      expect(out).not.toContain('x:')
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('remote_create_session posts backendId+directory to /api/session', async () => {
    const bodies: unknown[] = []
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(init?.body)
      return new Response(JSON.stringify({ id: 'ses_r1', backendId: 'remote:lab' }), { status: 200 })
    }) as typeof fetch
    try {
      const tools = createRemoteToolsV1({ attached: { baseUrl: 'http://h', resolveToken: () => 'tok', version: 'test' } })
      const out = await tools.remote_create_session.execute({ remote_id: 'lab', directory: '/r/work' }, {})
      expect(bodies[0]).toEqual(JSON.stringify({ backendId: 'remote:lab', directory: '/r/work' }))
      expect(out).toContain('ses_r1 created on remote:lab')
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('sync_workspace proxies and surfaces the host detail', async () => {
    const bodies: unknown[] = []
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(init?.body)
      return new Response(JSON.stringify({ ok: true, detail: 'synced 2 file(s)' }), { status: 200 })
    }) as typeof fetch
    try {
      const tools = createRemoteToolsV1({ attached: { baseUrl: 'http://h', resolveToken: () => 'tok', version: 'test' } })
      const out = await tools.remote_sync_workspace.execute({ remote_id: 'lab', local_root: '/p', remote_target: '~/w', entries: 'a b' }, {})
      expect(bodies[0]).toEqual(JSON.stringify({ localRoot: '/p', remoteTarget: '~/w', entries: ['a', 'b'] }))
      expect(out).toBe('synced 2 file(s)')
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

// ── smoke: the v1 tool() face survives vitest's plain environment ─────────────

describe('v1 tool face sanity', () => {
  it('exposes all four tools with descriptions', () => {
    const tools = createRemoteToolsV1(localDeps())
    expect(Object.keys(tools).sort()).toEqual(['remote_create_session', 'remote_list', 'remote_provision', 'remote_sync_auth', 'remote_sync_workspace'])
    for (const t of Object.values(tools)) expect(t.description.length).toBeGreaterThan(20)
  })
})

// ── batch 5: remote_sync_auth (fifth tool) ────────────────────────────────────

describe('remote_sync_auth handler (batch 5)', () => {
  it('calls manager.syncAuth and returns its detail', async () => {
    let seenId: string | undefined
    const deps = localDeps({
      syncAuth: async (id) => { seenId = id; return { ok: true, detail: 'credentials synced' } },
    })
    const tools = createRemoteToolsV1(deps)
    const out = await tools.remote_sync_auth.execute({ remote_id: 'lab' }, {})
    expect(seenId).toBe('lab')
    expect(out).toBe('credentials synced')
  })

  it('missing remote_id reads as a plain failure', async () => {
    const tools = createRemoteToolsV1(localDeps())
    expect(await tools.remote_sync_auth.execute({}, {})).toContain('remote_id is required')
  })

  it('v2 registration includes remote_sync_auth with namespace ocrc', async () => {
    const added: Array<Record<string, unknown>> = []
    const registrar: V2ToolRegistrar = {
      transform: async (fn) => {
        await fn({ add: (t) => added.push(t as Record<string, unknown>), update: () => {}, remove: () => {}, list: () => [] })
      },
    }
    await registerRemoteToolsV2(registrar, localDeps())
    const auth = added.find((t) => t.name === 'remote_sync_auth')
    expect(auth).toBeDefined()
    expect((auth!.options as { namespace?: string }).namespace).toBe('ocrc')
  })

  it('attached mounting posts to the host sync-auth route', async () => {
    const urls: string[] = []
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url))
      return new Response(JSON.stringify({ ok: true, detail: 'credentials synced' }), { status: 200 })
    }) as typeof fetch
    try {
      const tools = createRemoteToolsV1({ attached: { baseUrl: 'http://h', resolveToken: () => 'tok', version: 'test' } })
      const out = await tools.remote_sync_auth.execute({ remote_id: 'lab' }, {})
      expect(urls[0]).toBe('http://h/api/remotes/lab/sync-auth')
      expect(out).toBe('credentials synced')
    } finally {
      globalThis.fetch = origFetch
    }
  })
})
