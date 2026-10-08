import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { gitCommit, gitDiscard, gitInfo, gitStage, gitSwitchBranch } from '../../src/core/git-ops.js'

let dir = ''

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ocrc-git-'))
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir })
  git(['init', '-b', 'main'])
  git(['config', 'user.email', 't@ocrc.test'])
  git(['config', 'user.name', 'T'])
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  git(['add', '.'])
  git(['commit', '-m', 'init'])
})

describe('git 写操作（N7-3）', () => {
  it('stage/unstage 真实改变暂存区', async () => {
    writeFileSync(join(dir, 'a.txt'), 'two\n')
    await gitStage(dir, ['a.txt'], true)
    expect((await import('node:child_process')).execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: dir }).toString()).toContain('a.txt')
    await gitStage(dir, ['a.txt'], false)
    expect((await import('node:child_process')).execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: dir }).toString()).toBe('')
  })

  it('commit 提交并返回短哈希', async () => {
    writeFileSync(join(dir, 'b.txt'), 'new\n')
    const out = await gitCommit(dir, 'add b', ['a.txt', 'b.txt'])
    expect(out.commit).toMatch(/^[0-9a-f]+$/)
    const info = await gitInfo(dir)
    expect(info.isDirty).toBe(false)
  })

  it('discard 未跟踪文件 = 删除（ZCode 同语义）', async () => {
    writeFileSync(join(dir, 'c.txt'), 'junk\n')
    await gitDiscard(dir, ['c.txt'])
    expect((await import('node:fs')).existsSync(join(dir, 'c.txt'))).toBe(false)
  })

  it('discard 已跟踪改动 = 还原', async () => {
    writeFileSync(join(dir, 'a.txt'), 'dirty\n')
    await gitDiscard(dir, ['a.txt'])
    const after = (await import('node:fs')).readFileSync(join(dir, 'a.txt'), 'utf-8')
    expect(after).toBe('two\n')
  })

  it('switchBranch 切换分支并拒绝非法名', async () => {
    await gitSwitchBranch(dir, 'feature/x', true)
    const info = await gitInfo(dir)
    expect(info.branchName).toBe('feature/x')
    await gitSwitchBranch(dir, 'main', false)
    await expect(gitSwitchBranch(dir, 'bad name with space', false)).rejects.toThrow(/非法分支名/)
  })

  it('路径越界/非法字符一律拒绝（无 shell 注入面）', async () => {
    await expect(gitStage(dir, ['../../etc/passwd'], true)).rejects.toThrow(/非法路径/)
    await expect(gitStage(dir, ['a.txt; rm -rf /'], true)).rejects.toThrow(/非法路径/)
  })

  it('push 无 upstream 时如实失败（不假装成功）', async () => {
    const { gitPush } = await import('../../src/core/git-ops.js')
    const out = await gitPush(dir)
    expect(out.ok).toBe(false)
    expect(out.error).toBeTruthy()
  })
})
