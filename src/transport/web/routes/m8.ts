import type { Hono } from 'hono'
import type { BackendRegistry } from '../../../core/agent/registry.js'
import type { SessionState } from '../../../core/state.js'
import {
  listWorkspaceEntries, packWorkspaceEntries, readFileBase64, readTextSlice,
  searchWorkspaceEntries, statPaths,
} from '../../../core/file-ops.js'

/**
 * M8: skills / files / worktree sandboxes — thin proxies over the active
 * backend. `directory` defaults to the active workspace when the client
 * doesn't pin one.
 */
export function registerM8(app: Hono, reg: BackendRegistry, state: SessionState) {
  // Hono's Context.query has overloads that fight structural typing — any here.
  const dir = (c: any): string => {
    const q = String(c.req?.query('directory') ?? '')
    if (q) return q
    const active = state.getActiveWorkspace()
    return active ?? ''
  }

  app.get('/api/skills', async (c) => {
    const b = reg.active()
    if (!b.getSkills) return c.json({ skills: [] })
    const d = dir(c)
    return c.json({ skills: await b.getSkills(d || undefined) })
  })

  app.get('/api/browse', async (c) => {
    const b = reg.active()
    if (!b.listFiles) return c.json({ files: [] })
    const d = dir(c)
    return c.json({ files: await b.listFiles(d || undefined, c.req.query('path') ?? '.') })
  })

  app.get('/api/file-content', async (c) => {
    const b = reg.active()
    if (!b.readFile) return c.json({ error: 'unsupported' }, 400)
    try {
      const d = dir(c)
      return c.json(await b.readFile(d || undefined, c.req.query('path') ?? '.'))
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  app.get('/api/worktrees', async (c) => {
    const b = reg.active()
    if (!b.listWorktreeSandboxes) return c.json({ worktrees: [] })
    const d = dir(c)
    return c.json({ worktrees: await b.listWorktreeSandboxes(d || undefined) })
  })

  app.post('/api/worktrees', async (c) => {
    const b = reg.active()
    if (!b.createWorktreeSandboxes) return c.json({ error: 'unsupported' }, 400)
    const body = (await c.req.json().catch(() => ({}))) as { name?: string }
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return c.json({ error: 'name required' }, 400)
    const d = dir(c)
    const created = await b.createWorktreeSandboxes(d || undefined, name)
    return c.json(created ? { worktree: created } : { error: 'create failed' }, created ? 200 : 500)
  })

  app.delete('/api/worktrees', async (c) => {
    const b = reg.active()
    const name = c.req.query('name') ?? ''
    if (!b.removeWorktreeSandboxes || !name) return c.json({ ok: false }, 400)
    const d = dir(c)
    return c.json({ ok: await b.removeWorktreeSandboxes(d || undefined, name) })
  })

  // ── N6 文件面：/z/ 的文件树 / 预览 / @ 提及。走 host 本地文件系统（与工作区同机），
  //    路径经 containment 校验；读引擎拿不到二进制，这里必须自己读盘。────────────
  app.post('/api/file-stat', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { directory?: string; paths?: string[] }
    const root = body.directory || dir(c)
    const paths = Array.isArray(body.paths) ? body.paths.filter((p): p is string => typeof p === 'string') : []
    if (!root) return c.json({ error: 'directory required' }, 400)
    return c.json({ files: await statPaths(root, paths) })
  })

  app.get('/api/file-slice', async (c) => {
    const root = dir(c)
    const path = c.req.query('path') ?? ''
    if (!root || !path) return c.json({ error: 'directory and path required' }, 400)
    const offset = Number.parseInt(c.req.query('offset') ?? '0', 10) || 0
    const rawLen = c.req.query('length')
    const length = rawLen === undefined ? undefined : Math.max(0, Number.parseInt(rawLen, 10) || 0)
    try {
      return c.json(await readTextSlice(root, path, offset, length))
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  /** Media/binary preview: engine file reads are text-only, so the host reads the bytes.
   *  offset/length make it serve PDF-style range reads too. */
  app.get('/api/file-base64', async (c) => {
    const root = dir(c)
    const path = c.req.query('path') ?? ''
    if (!root || !path) return c.json({ error: 'directory and path required' }, 400)
    const maxBytes = Number.parseInt(c.req.query('maxBytes') ?? '', 10) || undefined
    const offset = Number.parseInt(c.req.query('offset') ?? '0', 10) || 0
    const rawLen = c.req.query('length')
    const length = rawLen === undefined ? undefined : Math.max(0, Number.parseInt(rawLen, 10) || 0)
    try {
      return c.json(await readFileBase64(root, path, maxBytes, offset, length))
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  app.get('/api/files/search', async (c) => {
    const root = dir(c)
    if (!root) return c.json({ error: 'directory required' }, 400)
    const limit = Number.parseInt(c.req.query('limit') ?? '', 10) || undefined
    return c.json({ files: await searchWorkspaceEntries(root, c.req.query('q') ?? '', limit) })
  })

  /** Full workspace index (packed, ZCode codec-compatible). `length` alone returns
   *  the size and no payload — the client's range contract needs it. */
  app.get('/api/files/index', async (c) => {
    const root = dir(c)
    if (!root) return c.json({ error: 'directory required' }, 400)
    const entries = await listWorkspaceEntries(root)
    const packed = packWorkspaceEntries(entries)
    if (c.req.query('lengthOnly') === '1') return c.json({ length: packed.length, truncated: entries.length >= 10_000 })
    return c.json({ length: packed.length, packed, truncated: entries.length >= 10_000 })
  })
}
