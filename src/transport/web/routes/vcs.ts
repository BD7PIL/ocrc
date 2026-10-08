import type { Hono } from 'hono'
import type { BackendRegistry } from '../../../core/agent/registry.js'
import { gitCommit, gitDiscard, gitDiff, gitInfo, gitPush, gitStage, gitSwitchBranch } from '../../../core/git-ops.js'

/** 0.18 git pane data: branch + per-file working-tree status, and per-file
 *  patches. Proxied from the opencode server's /vcs endpoints (ocFetch).
 *  /vcs is project-global on the server, so this routes to the active backend. */
export function registerVcs(app: Hono, reg: BackendRegistry) {
  app.get('/api/vcs', async (c) => {
    const backend = reg.forSession(c.req.query('sessionId') ?? '')
    if (!backend.getVcs) return c.json({ error: 'unsupported' }, 501)
    const body = await backend.getVcs(c.req.query('sessionId'))
    if (!body) return c.json({ error: 'unavailable' }, 404)
    return c.json(body)
  })

  app.get('/api/vcs/diff', async (c) => {
    const backend = reg.forSession(c.req.query('sessionId') ?? '')
    if (!backend.getVcsDiff) return c.json({ error: 'unsupported' }, 501)
    const file = c.req.query('file')
    if (!file) return c.json({ error: 'file required' }, 400)
    const body = await backend.getVcsDiff(c.req.query('sessionId'), file)
    if (!body) return c.json({ error: 'unavailable' }, 404)
    return c.json(body)
  })

  // ── N6 Git 面板：host 侧 git（固定参数）给 /z/ 的 repoRoot / ahead-behind /
  //    numstat / 本地分支 / identity。已有 /api/vcs 是从引擎转手的窄面，不够用。──
  app.get('/api/git', async (c) => {
    const directory = c.req.query('directory') ?? ''
    if (!directory) return c.json({ error: 'directory required' }, 400)
    return c.json(await gitInfo(directory))
  })

  app.get('/api/git/diff', async (c) => {
    const directory = c.req.query('directory') ?? ''
    const file = c.req.query('file') ?? ''
    if (!directory || !file) return c.json({ error: 'directory and file required' }, 400)
    return c.json(await gitDiff(directory, file, { staged: c.req.query('staged') === '1' }))
  })

  // ── N7-3 git 写操作（ZCode Git 面板的 stage/commit/discard/push/branch）──
  const gitWrite = <B extends { directory?: string }, R>(fn: (directory: string, body: B) => R | Promise<R>) =>
    async (c: any) => {
      const body = (await c.req.json().catch(() => ({}))) as B & { directory?: string }
      if (!body?.directory) return c.json({ error: 'directory required' }, 400)
      try {
        return c.json(await fn(body.directory, body))
      } catch (err) {
        return c.json({ ok: false, error: (err as Error).message }, 400)
      }
    }

  app.post('/api/git/stage', gitWrite<{ directory: string; paths: string[]; staged?: boolean }, { ok: boolean }>(
    async (directory, body) => {
      await gitStage(directory, body.paths ?? [], body.staged !== false)
      return { ok: true }
    },
  ))
  app.post('/api/git/discard', gitWrite<{ directory: string; paths: string[] }, { ok: boolean }>(
    async (directory, body) => {
      await gitDiscard(directory, body.paths ?? [])
      return { ok: true }
    },
  ))
  app.post('/api/git/commit', gitWrite<{ directory: string; message: string; paths?: string[] }, { ok: boolean; commit: string; output?: string }>(
    async (directory, body) => {
      const out = await gitCommit(directory, body.message ?? '', body.paths)
      return { ok: true, ...out }
    },
  ))
  app.post('/api/git/push', gitWrite<{ directory: string }, { ok: boolean; error?: string }>(
    async (directory) => await gitPush(directory),
  ))
  app.post('/api/git/branch', gitWrite<{ directory: string; branch: string; create?: boolean }, { ok: boolean }>(
    async (directory, body) => {
      if (!body.branch) return { ok: false, error: 'branch required' }
      await gitSwitchBranch(directory, body.branch, body.create === true)
      return { ok: true }
    },
  ))
}

/** Session revert / unrevert + state (0.22). Separate file-level routes so the
 *  session id rides the path (auth + normalization parity with other routes). */
export function registerRevert(app: Hono, reg: BackendRegistry) {
  const run = (action: 'revert' | 'unrevert' | 'state') =>
    async (c: any) => {
      if (action === 'revert' && !c.req.query('messageID')) return c.json({ error: 'messageID required' }, 400)
      const id = c.req.param('id')
      const backend = reg.forSession(id)
      if (action === 'state') {
        if (!backend.getSessionRevert) return c.json({ error: 'unsupported' }, 501)
        const body = await backend.getSessionRevert(id)
        return body ? c.json(body) : c.json({ error: 'unavailable' }, 404)
      }
      const fn = action === 'revert' ? backend.revertSession : backend.unrevertSession
      if (!fn) return c.json({ error: 'unsupported' }, 501)
      const body =
        action === 'revert'
          ? await backend.revertSession!(id, String(c.req.query('messageID') ?? ''))
          : await backend.unrevertSession!(id)
      return body ? c.json(body) : c.json({ error: 'unavailable' }, 404)
    }
  app.post('/api/session/:id/revert', run('revert'))
  app.post('/api/session/:id/unrevert', run('unrevert'))
  app.get('/api/session/:id/revert-state', run('state'))
}
