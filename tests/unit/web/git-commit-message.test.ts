// N12 G9 — /api/git/commit-message. The Git panel's 「生成提交信息」 button used to
// be the only git affordance that refused honestly; it now runs a one-shot child
// session over the working diff. These tests pin the boundary: which diff is
// sent, what happens with no changes / no backend support, and what the caller
// gets back.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { registerVcs } from '../../../src/transport/web/routes/vcs'
import { singleBackendRegistry } from '../../../src/core/agent/registry'
import type { AgentBackend } from '../../../src/core/agent/backend'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ocrc-gitmsg-'))
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir })
  git(['init', '-b', 'main'])
  git(['config', 'user.email', 't@ocrc.test'])
  git(['config', 'user.name', 'T'])
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  git(['add', '.'])
  git(['commit', '-m', 'init'])
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function makeApp(over: { promptOnce?: AgentBackend['promptOnce'] } = {}) {
  const prompts: Array<{ text: string; opts?: unknown }> = []
  const backend = {
    id: 'opencode',
    capabilities: {},
    promptOnce: over.promptOnce ?? (async (text: string, opts?: unknown) => {
      prompts.push({ text, opts })
      return 'feat(git): 生成提交信息\n\n说明'
    }),
  } as unknown as AgentBackend
  const app = new Hono()
  registerVcs(app, singleBackendRegistry(backend))
  return { app, prompts }
}

const post = (app: Hono, body: unknown) =>
  app.request('/api/git/commit-message', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

describe('POST /api/git/commit-message', () => {
  it('400s without a directory', async () => {
    const { app } = makeApp()
    expect((await post(app, {})).status).toBe(400)
  })

  it('400s when there is nothing to commit', async () => {
    const { app, prompts } = makeApp()
    const res = await post(app, { directory: dir })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('没有可提交的改动')
    expect(prompts).toHaveLength(0) // 没改动就不该花模型调用
  })

  it('sends the working diff and returns the sanitized message', async () => {
    writeFileSync(join(dir, 'a.txt'), 'two\n')
    const { app, prompts } = makeApp({ promptOnce: async (text, opts) => {
      prompts.push({ text, opts })
      return '```\nfix: 改成 two\n```'
    } })
    const res = await post(app, { directory: dir, locale: 'zh-CN' })
    expect(res.status).toBe(200)
    expect((await res.json()).message).toBe('fix: 改成 two')
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.text).toContain('中文')
    expect(prompts[0]!.text).toContain('+two')
    // 子会话不允许写工作区
    expect((prompts[0]!.opts as { tools?: unknown }).tools).toEqual({})
  })

  it('staged-only when includeUnstaged is false', async () => {
    writeFileSync(join(dir, 'a.txt'), 'staged-change\n')
    execFileSync('git', ['add', 'a.txt'], { cwd: dir })
    writeFileSync(join(dir, 'b.txt'), 'untracked\n')
    const { app, prompts } = makeApp()
    await post(app, { directory: dir, includeUnstaged: false })
    expect(prompts[0]!.text).toContain('staged-change')
    expect(prompts[0]!.text).not.toContain('untracked')
  })

  it('501s when the backend has no one-shot channel', async () => {
    writeFileSync(join(dir, 'a.txt'), 'two\n')
    const backend = { id: 'acp:kimi', capabilities: {} } as unknown as AgentBackend
    const app = new Hono()
    registerVcs(app, singleBackendRegistry(backend))
    const res = await post(app, { directory: dir })
    expect(res.status).toBe(501)
  })

  it('502s when the model returns nothing', async () => {
    writeFileSync(join(dir, 'a.txt'), 'two\n')
    const { app } = makeApp({ promptOnce: async () => undefined })
    const res = await post(app, { directory: dir })
    expect(res.status).toBe(502)
    expect((await res.json()).error).toContain('未返回提交信息')
  })
})
