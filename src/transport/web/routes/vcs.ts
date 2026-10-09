import type { Hono } from 'hono'
import type { BackendRegistry } from '../../../core/agent/registry.js'
import {
  buildCommitMessagePrompt, gitCommit, gitDiscard, gitDiff, gitInfo, gitPush, gitStage, gitSwitchBranch,
  gitWorkingDiff, sanitizeCommitMessage,
} from '../../../core/git-ops.js'

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

  // ── N12 G9：提交信息生成（Git 面板的「生成提交信息」按钮）。ZCode 走它自己的
  //    agent，ocrc 复用同一条一次性子会话通道；证据是工作区 diff（有界截断）。
  //    模型不可用/没改动都如实报错，不静默编一条假信息。 ──
  app.post('/api/git/commit-message', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      directory?: string; paths?: string[]; includeUnstaged?: boolean; locale?: string
    }
    const directory = body.directory ?? ''
    if (!directory) return c.json({ error: 'directory required' }, 400)
    try {
      const staged = await gitWorkingDiff(directory, { staged: true, paths: body.paths })
      const unstaged = body.includeUnstaged === false ? '' : await gitWorkingDiff(directory, { paths: body.paths })
      const diff = `${staged}${unstaged}`.trim()
      if (!diff) return c.json({ error: '没有可提交的改动' }, 400)
      const backend = reg.active()
      if (!backend.promptOnce) return c.json({ error: 'backend 不支持一次性生成' }, 501)
      const raw = await backend.promptOnce(buildCommitMessagePrompt(diff, body.locale), {
        title: 'ocrc-commit-message',
        tools: {}, // 只写信息，不碰工作区
        timeoutMs: 60_000,
      })
      const message = raw ? sanitizeCommitMessage(raw) : ''
      if (!message) return c.json({ error: '模型未返回提交信息' }, 502)
      return c.json({ message })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400)
    }
  })
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

/** N9-4 message actions: fork the session (passthrough to the engine). Body
 *  {messageID?} optional — fork point; omitted = fork the whole tail. Returns
 *  the NEW session id; the caller (zcode bridge) switches the UI over. */
export function registerFork(app: Hono, reg: BackendRegistry) {
  app.post('/api/session/:id/fork', async (c) => {
    const id = c.req.param('id')
    const backend = reg.forSession(id)
    if (!backend?.forkSession) return c.json({ error: 'unsupported' }, 501)
    const body = await c.req.json().catch(() => ({})) as { messageID?: string }
    const created = await backend.forkSession(id, typeof body.messageID === 'string' && body.messageID ? body.messageID : undefined)
    if (!created) return c.json({ error: 'fork failed' }, 502)
    return c.json(created)
  })
}
