import { describe, it, expect, vi } from 'vitest'
import { join } from 'node:path'
import { runInitWizard, type InitDeps } from '../../src/cli/init.js'

describe('init wizard', () => {
  // 期望路径必须和产品用同一条 join：把 '/test/.env' 写死，在 Windows 上产品写的是
  // '\test\.env'，Map 的键对不上 → 断言看到的是 undefined（测试自己的 bug，不是产品的）。
  const cwd = '/test'
  const envPath = join(cwd, '.env')

  function makeDeps(inputs: string[], files = new Map<string, string>()): { deps: InitDeps; outputs: string[] } {
    let idx = 0
    const outputs: string[] = []
    const deps: InitDeps = {
      ask: async (q) => {
        const ans = inputs[idx++] ?? ''
        return ans
      },
      writeFile: (path, content) => {
        files.set(path, content)
      },
      exists: (path) => files.has(path),
      testConnection: vi.fn().mockResolvedValue(undefined),
      cwd,
    }
    return { deps, outputs }
  }

  it('writes .env with token and user id', async () => {
    const files = new Map<string, string>()
    const { deps } = makeDeps(['my-token-123', '987654321'], files)
    await runInitWizard(deps)

    const env = files.get(envPath)
    expect(env).toBeDefined()
    expect(env).toContain('TELEGRAM_BOT_TOKEN=my-token-123')
    expect(env).toContain('ALLOWED_USER_IDS=987654321')
    expect(env).toContain('OPENCODE_BASE_URL=http://localhost:4096')
  })

  it('does not include SPAWN_OPENCODE in generated .env', async () => {
    const files = new Map<string, string>()
    const { deps } = makeDeps(['tok', '123'], files)
    await runInitWizard(deps)

    const env = files.get(envPath)
    expect(env).not.toContain('SPAWN_OPENCODE')
  })

  it('calls testConnection with the token', async () => {
    const files = new Map<string, string>()
    const { deps } = makeDeps(['tok', '123'], files)
    await runInitWizard(deps)
    expect(deps.testConnection).toHaveBeenCalledWith('tok')
  })

  it('overwrites existing .env when user confirms', async () => {
    const files = new Map<string, string>([[envPath, 'OLD=1']])
    const { deps } = makeDeps(['tok', '123', 'y'], files)
    await runInitWizard(deps)
    expect(files.get(envPath)).toContain('TELEGRAM_BOT_TOKEN=tok')
  })
})
