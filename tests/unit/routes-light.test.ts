import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerVersion } from '../../src/transport/web/routes/version.js'
import { registerSettingsProject } from '../../src/transport/web/routes/settings-project.js'
import { registerOffPeak } from '../../src/transport/web/routes/offpeak.js'
import { registerSharePublic, registerShareAuthed } from '../../src/transport/web/routes/share.js'
import { registerPolicy } from '../../src/transport/web/routes/policy.js'
import { registerCatalog } from '../../src/transport/web/routes/catalog.js'
import type { OffPeakManager, OffPeakTask } from '../../src/core/offpeak.js'

/**
 * Route-level coverage for registrars that had no direct tests
 * (批次 D). Pattern: fresh Hono app per case + the registrar under
 * test + hand-rolled fakes for its collaborators (same style as
 * tests/unit/web/task-groups.test.ts).
 */

const JSON_HEADERS = { 'content-type': 'application/json' }

function makeProjectDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'ocrc-routes-light-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  return dir
}

// ── version.ts ────────────────────────────────────────────────────────────

describe('version routes', () => {
  it('GET /api/version returns the version-info shape; /api/system returns host fields', async () => {
    const app = new Hono()
    registerVersion(app)

    const v = await (await app.request('/api/version')).json()
    expect(v).toEqual({
      version: expect.any(String),
      commit: expect.any(String),
      uptime: expect.any(String),
      uptimeMs: expect.any(Number),
      node: process.version,
      startedAt: expect.any(String),
      mode: expect.stringMatching(/^host|plugin$/),
    })

    const sys = await (await app.request('/api/system')).json()
    expect(sys).toMatchObject({
      homedir: expect.any(String),
      platform: expect.any(String),
      osRelease: expect.any(String),
      hostname: expect.any(String),
      node: process.version,
      version: v.version,
    })
  })
})

// ── settings-project.ts ───────────────────────────────────────────────────

describe('settings-project routes', () => {
  function makeApp(projectDir?: string) {
    const stateDir = join(mkdtempSync(join(tmpdir(), 'ocrc-routes-state-')), 'state')
    const app = new Hono()
    registerSettingsProject(app, stateDir, projectDir ? () => JSON.stringify({}) : undefined)
    return app
  }

  it('GET /api/settings/project: overview of an empty dir + 400 without dir', async () => {
    const dir = makeProjectDir()
    const app = makeApp(dir)
    expect((await app.request('/api/settings/project')).status).toBe(400)

    const out = await (await app.request(`/api/settings/project?dir=${encodeURIComponent(dir)}`)).json()
    expect(out).toMatchObject({
      dir,
      agentsMd: { exists: false, content: '' },
      projectConfig: { exists: false, content: '' },
      commands: [],
      rules: [],
    })
  })

  it('GET /api/settings/project: 500 when dir does not exist (mkdir failure path)', async () => {
    const app = makeApp()
    const bad = await app.request(`/api/settings/project?dir=${encodeURIComponent('/nonexistent-ocrc-zzz/nope')}`)
    expect(bad.status).toBe(500)
    expect((await bad.json()).error).toBeTruthy()
  })

  it('project file round-trip: 400 on missing params, write then read back, reject escaping paths', async () => {
    const dir = makeProjectDir()
    const app = makeApp(dir)

    expect((await app.request('/api/settings/project/file')).status).toBe(400)
    expect((await app.request('/api/settings/project/file?dir=' + encodeURIComponent(dir))).status).toBe(400)

    const put = await app.request('/api/settings/project/file', {
      method: 'PUT', headers: JSON_HEADERS,
      body: JSON.stringify({ dir, path: 'AGENTS.md', content: '# hi' }),
    })
    expect(put.status).toBe(200)
    expect(await put.json()).toMatchObject({ ok: true })

    const get = await (await app.request(`/api/settings/project/file?dir=${encodeURIComponent(dir)}&path=AGENTS.md`)).json()
    expect(get).toMatchObject({ ok: true, content: '# hi' })

    // PUT with a bad jsonc payload → writeProjectFile validates and 400s
    const badJson = await app.request('/api/settings/project/file', {
      method: 'PUT', headers: JSON_HEADERS,
      body: JSON.stringify({ dir, path: '.opencode/opencode.json', content: '{ nope' }),
    })
    expect(badJson.status).toBe(400)
    expect((await badJson.json()).ok).toBe(false)

    // traversal attempt: contained check rejects `..`
    const escape = await app.request(`/api/settings/project/file?dir=${encodeURIComponent(dir)}&path=${encodeURIComponent('../outside.md')}`)
    expect(await escape.json()).toMatchObject({ ok: false })
  })

  it('model-presets: GET lists presets, POST applies a mapping into project config; 400 without body', async () => {
    const dir = makeProjectDir({ '.opencode/opencode.json': JSON.stringify({}) })
    const app = makeApp(dir)

    expect((await app.request('/api/settings/model-presets')).status).toBe(400)

    const seeded = await app.request(`/api/settings/model-presets?dir=${encodeURIComponent(dir)}`)
    expect(await seeded.json()).toMatchObject({ current: {}, presets: {} })

    const post = await app.request('/api/settings/model-presets', {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ dir, name: 'fast', mapping: { build: 'zai/glm-4.6' } }),
    })
    expect(post.status).toBe(200)
    expect(await post.json()).toMatchObject({ ok: true })

    // applied into the project config + persisted as a preset
    const cfg = JSON.parse(readFileSync(join(dir, '.opencode', 'opencode.json'), 'utf-8'))
    expect(cfg.agent.build.model).toBe('zai/glm-4.6')
    const after = await (await app.request(`/api/settings/model-presets?dir=${encodeURIComponent(dir)}`)).json()
    expect(after.presets.fast).toEqual({ build: 'zai/glm-4.6' })

    const bad = await app.request('/api/settings/model-presets', {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ dir }),
    })
    expect(bad.status).toBe(400)
  })

  it('mcp entries: GET returns current entries, POST upserts and removes; 400 without id', async () => {
    const dir = makeProjectDir({ '.opencode/opencode.json': JSON.stringify({ mcp: { existing: { url: 'https://x' } } }) })
    const app = makeApp(dir)

    expect((await app.request('/api/settings/project/mcp')).status).toBe(400)
    const out = await (await app.request(`/api/settings/project/mcp?dir=${encodeURIComponent(dir)}`)).json()
    expect(out.mcp).toMatchObject({ existing: { url: 'https://x' } })

    const upsert = await app.request('/api/settings/project/mcp', {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ dir, id: 'added', entry: { command: 'foo' } }),
    })
    expect(upsert.status).toBe(200)
    const after = await (await app.request(`/api/settings/project/mcp?dir=${encodeURIComponent(dir)}`)).json()
    expect(Object.keys(after.mcp).sort()).toEqual(['added', 'existing'])

    const remove = await app.request('/api/settings/project/mcp', {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ dir, id: 'added', entry: null }),
    })
    expect(remove.status).toBe(200)
    const cleaned = await (await app.request(`/api/settings/project/mcp?dir=${encodeURIComponent(dir)}`)).json()
    expect(Object.keys(cleaned.mcp)).toEqual(['existing'])

    expect((await app.request('/api/settings/project/mcp', {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ dir }),
    })).status).toBe(400)
  })

  it('agents entries: GET returns agent node, POST patches and removes; 400 without patch', async () => {
    const dir = makeProjectDir({ '.opencode/opencode.json': JSON.stringify({ agent: { build: { model: 'm1', prompt: 'keep me' } } }) })
    const app = makeApp(dir)

    expect((await app.request('/api/settings/project/agents')).status).toBe(400)
    const out = await (await app.request(`/api/settings/project/agents?dir=${encodeURIComponent(dir)}`)).json()
    expect(out.agents).toMatchObject({ build: { model: 'm1' } })

    const patch = await app.request('/api/settings/project/agents', {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ dir, id: 'build', patch: { model: 'm2' } }),
    })
    expect(patch.status).toBe(200)
    const after = await (await app.request(`/api/settings/project/agents?dir=${encodeURIComponent(dir)}`)).json()
    // merge semantics: model updated, sibling keys preserved
    expect(after.agents.build).toEqual({ model: 'm2', prompt: 'keep me' })

    expect((await app.request('/api/settings/project/agents', {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ dir, id: 'build' }),
    })).status).toBe(400)
  })
})

// ── offpeak.ts ────────────────────────────────────────────────────────────

function fakeManager(overrides: Partial<OffPeakManager> = {}): OffPeakManager {
  const task: OffPeakTask = {
    id: 'opt_1', title: 'nightly', prompt: 'do things', permissionMode: 'default',
    directory: undefined, status: 'queued', queuedAt: 1, createdAt: 1, updatedAt: 1,
  }
  return {
    list: vi.fn(() => [task]),
    add: vi.fn((input) => (input.prompt === 'fail' ? null : { ...task, title: input.title })),
    pause: vi.fn(() => ({ ...task, status: 'paused' as const })),
    continueTask: vi.fn(() => ({ ...task, status: 'queued' as const })),
    cancel: vi.fn(() => ({ ...task, status: 'cancelled' as const })),
    remove: vi.fn(() => true),
    ...overrides,
  } as OffPeakManager
}

describe('offpeak routes', () => {
  it('GET /api/offpeak reports tasks + window openness', async () => {
    const app = new Hono()
    registerOffPeak(app, fakeManager(), { start: '00:00', end: '23:59' })
    const out = await (await app.request('/api/offpeak')).json()
    expect(out).toMatchObject({ windowOpen: true, window: { start: '00:00', end: '23:59' } })
    expect(out.tasks).toHaveLength(1)
  })

  it('POST /api/offpeak happy path forwards optional fields to the manager', async () => {
    const manager = fakeManager()
    const app = new Hono()
    registerOffPeak(app, manager, { start: '00:00', end: '23:59' })

    const res = await app.request('/api/offpeak', {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({
        title: 'nightly', prompt: 'run tests', permissionMode: 'yolo',
        modelSelection: { providerID: 'zai', modelID: 'glm-4.6' },
        directory: '/w', boundSessionId: 'ses_a', goal: 'all green',
      }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ task: { title: 'nightly' } })
    expect(manager.add).toHaveBeenCalledWith({
      title: 'nightly', prompt: 'run tests', permissionMode: 'yolo',
      modelSelection: { providerID: 'zai', modelID: 'glm-4.6' },
      directory: '/w', boundSessionId: 'ses_a', goal: 'all green',
    })
  })

  it('POST /api/offpeak errors: 400 without title/prompt, 400 on malformed modelSelection, 400 when manager rejects', async () => {
    const app = new Hono()
    registerOffPeak(app, fakeManager(), { start: '00:00', end: '23:59' })

    expect((await app.request('/api/offpeak', {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ title: 'x' }),
    })).status).toBe(400)

    expect((await app.request('/api/offpeak', {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ title: 'x', prompt: 'y', modelSelection: { providerID: 1 } }),
    })).status).toBe(400)

    const rejected = await app.request('/api/offpeak', {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ title: 'x', prompt: 'fail' }),
    })
    expect(rejected.status).toBe(400)
    expect(await rejected.json()).toMatchObject({ error: 'invalid offpeak task' })
  })

  it('PATCH /api/offpeak/:id dispatches pause/continue/cancel; 400 without action; 404 when the action cannot apply', async () => {
    const manager = fakeManager({ pause: vi.fn(() => undefined) })
    const app = new Hono()
    registerOffPeak(app, manager, { start: '00:00', end: '23:59' })

    const paused = await app.request('/api/offpeak/opt_1', {
      method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ action: 'pause' }),
    })
    expect(paused.status).toBe(404) // manager.pause → undefined
    expect((await paused.json()).error).toBeTruthy()

    for (const [action, method] of [['continueTask', 'continue'], ['cancel', 'cancel']] as const) {
      const res = await app.request('/api/offpeak/opt_1', {
        method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ action: method }),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ task: { id: 'opt_1' } })
      expect(manager[action]).toHaveBeenCalledWith('opt_1')
    }

    expect((await app.request('/api/offpeak/opt_1', {
      method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({}),
    })).status).toBe(400)
    // unknown action name → task undefined → the route 404s (action present)
    expect((await app.request('/api/offpeak/opt_1', {
      method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ action: 'wat' }),
    })).status).toBe(404)
    // absent action → 400
  })

  it('DELETE /api/offpeak/:id echoes the manager remove result', async () => {
    const app = new Hono()
    registerOffPeak(app, fakeManager({ remove: vi.fn(() => false) }), { start: '00:00', end: '23:59' })
    const out = await (await app.request('/api/offpeak/opt_missing', { method: 'DELETE' })).json()
    expect(out).toMatchObject({ ok: false })
  })
})

// ── share.ts ──────────────────────────────────────────────────────────────

function fakeShares() {
  const entry = {
    code: 'abc123def456', title: 'demo', sessionId: 'ses_a',
    createdAt: 42, cards: [{ kind: 'text', text: 'hi' }],
  }
  return {
    entry,
    create: vi.fn(() => entry),
    get: vi.fn((code: string) => (code === entry.code ? entry : undefined)),
    remove: vi.fn((code: string) => code === entry.code),
    list: vi.fn(() => [entry]),
  }
}

describe('share routes', () => {
  it('public GET /api/share/:code returns the snapshot; 400 on malformed code; 404 on unknown code', async () => {
    const shares = fakeShares()
    const app = new Hono()
    registerSharePublic(app, shares as any)

    const out = await (await app.request('/api/share/abc123def456')).json()
    expect(out).toMatchObject({ title: 'demo', createdAt: 42, cards: [{ kind: 'text', text: 'hi' }] })

    expect((await app.request('/api/share/bad!code')).status).toBe(400)
    expect((await app.request('/api/share/zzzzzzzzzzzz')).status).toBe(404)
  })

  it('authed POST /api/share snapshots via the backend; 400 without sessionId; 400 when history is empty', async () => {
    const shares = fakeShares()
    const backend = { getHistory: vi.fn().mockResolvedValue([{ kind: 'text', text: 'c1' }]) }
    const app = new Hono()
    registerShareAuthed(app, shares as any, { forSession: () => backend } as any)

    const res = await app.request('/api/share', {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ sessionId: 'ses_a', title: 'demo' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ code: 'abc123def456', url: '/share/abc123def456', count: 1 })
    expect(shares.create).toHaveBeenCalledWith('ses_a', 'demo', [{ kind: 'text', text: 'c1' }])

    expect((await app.request('/api/share', {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({}),
    })).status).toBe(400)

    const emptyBackend = { getHistory: vi.fn().mockRejectedValue(new Error('gone')) }
    const emptyApp = new Hono()
    registerShareAuthed(emptyApp, shares as any, { forSession: () => emptyBackend } as any)
    const empty = await emptyApp.request('/api/share', {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ sessionId: 'ses_gone' }),
    })
    expect(empty.status).toBe(400) // history failure → [] → nothing to share
    expect(await empty.json()).toMatchObject({ error: '会话没有可分享的转写' })
  })

  it('authed DELETE /api/share/:code echoes the store remove result', async () => {
    const shares = fakeShares()
    const app = new Hono()
    registerShareAuthed(app, shares as any, {} as any)

    expect(await (await app.request('/api/share/abc123def456', { method: 'DELETE' })).json()).toMatchObject({ ok: true })
    expect(await (await app.request('/api/share/nope00000000', { method: 'DELETE' })).json()).toMatchObject({ ok: false })
  })
})

// ── policy.ts ─────────────────────────────────────────────────────────────

function fakeState() {
  const store: Record<string, string | undefined> = {}
  return {
    normalizeSessionId: (id: string) => id,
    getSessionApprovalPolicy: vi.fn((id: string) => store[id]),
    setSessionApprovalPolicy: vi.fn((id: string, policy: string | undefined) => { store[id] = policy }),
  } as any
}

describe('policy routes', () => {
  it('GET /api/session/:id/policy defaults to "default"; POST stores edit/yolo; default clears the override', async () => {
    const state = fakeState()
    const app = new Hono()
    registerPolicy(app, state)

    expect(await (await app.request('/api/session/ses_a/policy')).json()).toMatchObject({ policy: 'default' })

    for (const policy of ['edit', 'yolo'] as const) {
      const res = await app.request('/api/session/ses_a/policy', {
        method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ policy }),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ ok: true, policy })
    }

    const cleared = await app.request('/api/session/ses_a/policy', {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ policy: 'default' }),
    })
    expect(await cleared.json()).toMatchObject({ ok: true, policy: 'default' })
    expect(state.setSessionApprovalPolicy).toHaveBeenLastCalledWith('ses_a', undefined)
  })

  it('POST /api/session/:id/policy rejects anything outside default|edit|yolo with 400', async () => {
    const app = new Hono()
    registerPolicy(app, fakeState())
    const res = await app.request('/api/session/ses_a/policy', {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ policy: 'yolo-plus' }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'policy must be default|edit|yolo' })
  })
})

// ── catalog.ts ────────────────────────────────────────────────────────────

function fakeBackend(overrides: Record<string, unknown> = {}) {
  return {
    id: 'opencode',
    getAgents: vi.fn().mockResolvedValue([{ name: 'build' }]),
    getModels: vi.fn().mockResolvedValue([{ id: 'glm-4.6' }]),
    ...overrides,
  } as any
}

describe('catalog routes', () => {
  it('GET /api/agents and /api/models fall back to the active backend; ?backend= selects explicitly', async () => {
    const active = fakeBackend()
    const other = fakeBackend({ getAgents: vi.fn().mockResolvedValue([{ name: 'plan' }]) })
    const reg = {
      active: () => active,
      get: (id: string) => (id === 'other' ? other : undefined),
    } as any
    const app = new Hono()
    registerCatalog(app, reg)

    expect(await (await app.request('/api/agents')).json()).toEqual([{ name: 'build' }])
    expect(await (await app.request('/api/models')).json()).toEqual([{ id: 'glm-4.6' }])
    expect(await (await app.request('/api/agents?backend=other')).json()).toEqual([{ name: 'plan' }])
  })

  it('GET /api/agents-full proxies the full agent node; 400 "unsupported" when the backend lacks it', async () => {
    const active = fakeBackend({ getAgentsFull: vi.fn().mockResolvedValue([{ name: 'build', mode: 'all' }]) })
    const app = new Hono()
    registerCatalog(app, { active: () => active, get: () => undefined } as any)

    const out = await (await app.request('/api/agents-full?dir=/w')).json()
    expect(out).toMatchObject({ agents: [{ name: 'build', mode: 'all' }] })
    expect(active.getAgentsFull).toHaveBeenCalledWith('/w')

    const bare = new Hono()
    registerCatalog(bare, { active: () => fakeBackend(), get: () => undefined } as any)
    const res = await bare.request('/api/agents-full')
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'unsupported' })
  })
})
