// P2b — world reads and artifact bytes. These are the two boundaries where the
// vendored engine's discipline is most explicit: over-cap reads REJECT (never
// truncate), artifact bytes live in a store (never in the journal), and
// world.run execs a fixed argv (never a shell string).
import { describe, it, expect, beforeEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorldReader } from '../../src/core/workflow/world'
import { createArtifactStore } from '../../src/core/workflow/artifacts'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ocrc-wf-world-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), 'export const answer = 42\n// TODO: tidy\n')
  writeFileSync(join(root, 'README.md'), '# hello\n')
})

const reader = (deps: Partial<Parameters<typeof createWorldReader>[0]> = {}) =>
  createWorldReader({ cwd: root, ...deps })

describe('world reads', () => {
  it('glob returns workspace-relative paths, sorted', async () => {
    const out = await reader().read('glob', ['**/*.ts']) as string[]
    expect(out).toEqual(['src/a.ts'])
  })

  it('read returns file text and refuses escapes / directories', async () => {
    const r = reader()
    expect(await r.read('read', ['src/a.ts'])).toContain('answer = 42')
    await expect(r.read('read', ['../outside.txt'])).rejects.toThrow(/escapes the workspace/)
    await expect(r.read('read', ['src'])).rejects.toThrow(/is a directory/)
    await expect(r.read('read', ['nope.txt'])).rejects.toThrow(/no such file/)
  })

  it('grep returns path/line/text and honours a glob filter', async () => {
    const r = reader()
    const hits = await r.read('grep', ['TODO']) as Array<{ path: string; line: number; text: string }>
    expect(hits).toEqual([{ path: 'src/a.ts', line: 2, text: '// TODO: tidy' }])
    expect(await r.read('grep', ['TODO', '**/*.md'])).toEqual([])
  })

  it('grep rejects past its match cap instead of truncating', async () => {
    for (let i = 0; i < 2100; i++) writeFileSync(join(root, `f${i}.txt`), 'hit\n')
    await expect(reader().read('grep', ['hit'])).rejects.toThrow(/exceeded its cap/)
  })

  it('git-status / git-log / git-diff work in a real repo', async () => {
    const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf-8' })
    git(['init', '-q'])
    git(['config', 'user.email', 't@example.com'])
    git(['config', 'user.name', 'T'])
    git(['add', '.'])
    git(['commit', '-qm', 'first'])
    writeFileSync(join(root, 'src', 'a.ts'), 'export const answer = 43\n')
    writeFileSync(join(root, 'new.txt'), 'brand new\n')

    const r = reader()
    const status = await r.read('git-status', []) as { branch?: string; clean: boolean; unstaged: string[]; untracked: string[] }
    expect(status.clean).toBe(false)
    expect(status.unstaged).toContain('src/a.ts')
    expect(status.untracked).toContain('new.txt')

    const log = await r.read('git-log', [5]) as Array<{ hash: string; subject: string }>
    expect(log).toHaveLength(1)
    expect(log[0].subject).toBe('first')

    expect(await r.read('git-diff', [undefined, 'src/a.ts'])).toContain('43')
    expect(await r.read('git-changed-files', [])).toEqual(expect.arrayContaining(['src/a.ts', 'new.txt']))
  })

  it('git-log rejects a count over its cap', async () => {
    await expect(reader().read('git-log', [500])).rejects.toThrow(/exceeded its cap/)
  })

  it('world.run returns the exit code as an outcome, not an error', async () => {
    const ok = await reader().read('run', ['node', ['-e', 'console.log("hi")']]) as { exitCode: number; stdout: string }
    expect(ok.exitCode).toBe(0)
    expect(ok.stdout.trim()).toBe('hi')

    const bad = await reader().read('run', ['node', ['-e', 'process.exit(3)']]) as { exitCode: number }
    expect(bad.exitCode).toBe(3)
  })

  it('world.run goes through the approval gate when one is wired', async () => {
    const seen: string[] = []
    const r = reader({ approve: (cmd) => { seen.push(cmd); return cmd !== 'rm' } })
    await r.read('run', ['node', ['-e', '0']])
    expect(seen).toEqual(['node'])
    await expect(r.read('run', ['rm', ['-rf', '/']])).rejects.toThrow(/was not approved/)
  })

  it('rejects unusable arguments rather than guessing', async () => {
    const r = reader()
    await expect(r.read('glob', [])).rejects.toThrow(/non-empty string/)
    await expect(r.read('run', ['node', 'not-an-array'])).rejects.toThrow(/array of strings/)
    await expect(r.read('nonsense' as never, [])).rejects.toThrow(/unknown op/)
  })
})

describe('artifact bytes', () => {
  const store = () => createArtifactStore({ dir: root, cwd: root, now: () => 1_700_000_000_000 })

  it('publishes a workspace file by copy and returns a store uri', async () => {
    const rec = await store().publish({ runId: 'dwfrun-1', siteId: 's', ordinal: 1, op: 'file', id: 'report', version: 1, path: 'README.md' })
    expect(rec).toMatchObject({
      id: 'report', kind: 'file', version: 1, bytes: 8,
      contentType: 'text/markdown; charset=utf-8', sourcePath: 'README.md',
      uri: 'ocrc-artifact://dwfrun-1/report/v1', publishedAt: 1_700_000_000_000,
    })
    expect(store().readVersion('dwfrun-1', 'report', 1)?.bytes.toString()).toBe('# hello\n')
  })

  it('publishes markdown from content', async () => {
    const rec = await store().publish({ runId: 'dwfrun-1', siteId: 's', ordinal: 1, op: 'markdown', id: 'notes', version: 1, content: '**bold**' })
    expect(rec.contentType).toContain('text/markdown')
    expect(rec.sourcePath).toBeUndefined()
    expect(store().readVersion('dwfrun-1', 'notes', 1)?.bytes.toString()).toBe('**bold**')
  })

  it('keeps every version on disk (a republish never clobbers)', async () => {
    const s = store()
    await s.publish({ runId: 'dwfrun-1', siteId: 's', ordinal: 1, op: 'markdown', id: 'notes', version: 1, content: 'v1' })
    await s.publish({ runId: 'dwfrun-1', siteId: 's', ordinal: 2, op: 'markdown', id: 'notes', version: 2, content: 'v2' })
    expect(s.readVersion('dwfrun-1', 'notes', 1)?.bytes.toString()).toBe('v1')
    expect(s.readVersion('dwfrun-1', 'notes', 2)?.bytes.toString()).toBe('v2')
  })

  it('refuses a source outside the workspace and a missing source', async () => {
    const s = store()
    await expect(s.publish({ runId: 'r', siteId: 's', ordinal: 1, op: 'file', id: 'x', version: 1, path: '../escape.txt' }))
      .rejects.toThrow(/escapes the workspace/)
    await expect(s.publish({ runId: 'r', siteId: 's', ordinal: 1, op: 'file', id: 'x', version: 1, path: 'nope.txt' }))
      .rejects.toThrow(/does not exist/)
  })

  it('refuses an unsafe id and a preset op', async () => {
    const s = store()
    await expect(s.publish({ runId: 'r', siteId: 's', ordinal: 1, op: 'markdown', id: 'a/b', version: 1, content: 'x' }))
      .rejects.toThrow(/must match/)
    await expect(s.publish({ runId: 'r', siteId: 's', ordinal: 1, op: 'chart' as never, id: 'ok', version: 1 }))
      .rejects.toThrow(/not a content member/)
  })

  it('rejects a markdown payload over the cap instead of writing a partial file', async () => {
    const big = 'x'.repeat(256 * 1024 + 1)
    await expect(store().publish({ runId: 'r', siteId: 's', ordinal: 1, op: 'markdown', id: 'big', version: 1, content: big }))
      .rejects.toThrow(/over the/)
    expect(store().readVersion('r', 'big', 1)).toBeUndefined()
  })

  it('truncates title/description to their caps rather than refusing', async () => {
    const rec = await store().publish({
      runId: 'r', siteId: 's', ordinal: 1, op: 'markdown', id: 'x', version: 1, content: 'hi',
      opts: { title: 'T'.repeat(500), description: 'D'.repeat(900) },
    })
    expect(rec.title).toHaveLength(120)
    expect(rec.description).toHaveLength(500)
  })
})
