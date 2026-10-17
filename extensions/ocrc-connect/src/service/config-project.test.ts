import { describe, expect, it } from 'vitest'
import {
  buildProjectConfigReadScript, buildProjectConfigWriteScript, extractProjectSections,
  hasChanges, mergeSticky, parseProjectConfigRead, stripLiteralSecrets,
} from './config-project.js'

const b64 = (text: string) => Buffer.from(text, 'utf-8').toString('base64')

describe('读引擎实际会读的那一份（D10）', () => {
  it('存在 .jsonc 就报 .jsonc——同目录 .jsonc 优先于 .json', () => {
    const stdout = `FOUND=opencode.jsonc\nSIZE=42\nB64_BEGIN\n${b64('{"model":"a/b"}')}\nB64_END\nREAD_DONE=1\n`
    const report = parseProjectConfigRead(stdout, '/home/demo/project')
    expect(report.format).toBe('jsonc')
    expect(report.targetPath).toBe('/home/demo/project/opencode.jsonc')
    expect(report.exists).toBe(true)
    expect(report.parsed).toEqual({ model: 'a/b' })
  })

  it('都不存在时给出推荐落点 .jsonc（不是 .json）', () => {
    const report = parseProjectConfigRead('READ_DONE=1\n', '/home/demo/project')
    expect(report.exists).toBe(false)
    expect(report.format).toBe('missing')
    expect(report.targetPath).toBe('/home/demo/project/opencode.jsonc')
  })

  it('坏 JSON 如实报 parseError，不猜也不清空', () => {
    const stdout = `FOUND=opencode.json\nB64_BEGIN\n${b64('{not json')}\nB64_END\n`
    const report = parseProjectConfigRead(stdout, '/p')
    expect(report.parseError).toBeTruthy()
    expect(report.parsed).toBeUndefined()
    expect(report.exists).toBe(true)
  })

  it('顶层不是对象也算坏（引擎要的是对象）', () => {
    const stdout = `FOUND=opencode.json\nB64_BEGIN\n${b64('[1,2]')}\nB64_END\n`
    expect(parseProjectConfigRead(stdout, '/p').parseError).toContain('对象')
  })

  it('.jsonc 里有注释 → 如实提示写回会丢注释', () => {
    const stdout = `FOUND=opencode.jsonc\nB64_BEGIN\n${b64('{\n  // 保留我\n  "model": "a/b"\n}')}\nB64_END\n`
    const report = parseProjectConfigRead(stdout, '/p')
    expect(report.commentsWillBeLost).toBe(true)
    expect(report.parsed).toEqual({ model: 'a/b' })
  })

  it('脚本只读项目目录下的两个候选文件，不碰 ~/.config', () => {
    const script = buildProjectConfigReadScript('/home/demo/project')
    // 路径在远端拼装（`$D/$name`）——目标目录本身只出现一次，且不是用户级配置。
    expect(script).toContain("D='/home/demo/project'")
    expect(script).toContain('for name in opencode.jsonc opencode.json')
    expect(script).toContain('"$D/$name"')
    expect(script).not.toContain('.config/opencode')
    expect(script).not.toContain('HOME')
  })

  it('结尾的斜杠不会拼出双斜杠', () => {
    const report = parseProjectConfigRead('READ_DONE=1\n', '/home/demo/project/')
    expect(report.targetPath).toBe('/home/demo/project/opencode.jsonc')
  })
})

describe('粘性合并（D11：缺字段不得打掉远端原值）', () => {
  const remote = {
    model: 'a/remote',
    mcp: { servers: { searxng: { command: 'npx mcp-searxng', environment: { SEARXNG_URL: 'http://192.168.96.11:8080', API_KEY: 'remote-secret' } }, local: { command: '/opt/local' } } },
    provider: { onlyRemote: { apiKey: 'keep-me' } },
    agent: { build: { model: 'a/remote' } },
  }

  it('面板段逐叶覆盖，被控端独有键全部保留', () => {
    const merged = mergeSticky(remote, { agent: { build: { model: 'a/panel' }, plan: { model: 'b/x' } } })
    expect((merged.agent as Record<string, unknown>).build).toEqual({ model: 'a/panel' })
    expect((merged.agent as Record<string, unknown>).plan).toEqual({ model: 'b/x' })
    // 面板没提的段原样保留。
    expect(merged.provider).toEqual({ onlyRemote: { apiKey: 'keep-me' } })
  })

  it('面板没提供的密钥字段保留远端原值（最要紧的一条）', () => {
    const merged = mergeSticky(remote, { mcp: { servers: { searxng: { environment: { SEARXNG_URL: 'http://panel:8080' } } } } })
    const env = ((merged.mcp as Record<string, unknown>).servers as Record<string, Record<string, unknown>>).searxng.environment as Record<string, string>
    expect(env.SEARXNG_URL).toBe('http://panel:8080')
    expect(env.API_KEY).toBe('remote-secret')
    // 面板没提的 server 也不动。
    expect((((merged.mcp as Record<string, unknown>).servers as Record<string, unknown>).local as { command: string }).command).toBe('/opt/local')
  })

  it('undefined = 不修改（显式 null 才是要删）', () => {
    const merged = mergeSticky({ a: 1, b: 2 }, { a: undefined, b: null })
    expect(merged.a).toBe(1)
    expect(merged.b).toBeNull()
  })

  it('数组整体替换（opencode 自己的合并语义）', () => {
    const merged = mergeSticky({ plugin: ['a', 'b'] }, { plugin: ['c'] })
    expect(merged.plugin).toEqual(['c'])
  })

  it('只写差异：同样的内容不比出变化（不产生无意义的 .ocrc-bak）', () => {
    expect(hasChanges(remote, structuredClone(remote))).toBe(false)
    // 键顺序不同不算变化。
    expect(hasChanges({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false)
    expect(hasChanges(remote, mergeSticky(remote, { agent: { build: { model: 'changed' } } }))).toBe(true)
  })
})

describe('写入前先把密钥从文件里摘出去（D11 下半条）', () => {
  it('字面量密钥换成 {env:…} 引用，并逐条报出来', () => {
    const { config, replaced } = stripLiteralSecrets({
      mcp: { servers: { x: { environment: { GITHUB_TOKEN: 'ghp_live', REGION: 'cn' } } } },
    })
    const env = (((config.mcp as Record<string, unknown>).servers as Record<string, Record<string, unknown>>).x.environment) as Record<string, string>
    expect(env.GITHUB_TOKEN).toBe('{env:GITHUB_TOKEN}')
    expect(env.REGION).toBe('cn')
    expect(replaced).toEqual([{ path: 'mcp.servers.x.environment.GITHUB_TOKEN', env: 'GITHUB_TOKEN' }])
  })

  it('已经是引用就不动它', () => {
    const { replaced } = stripLiteralSecrets({ mcp: { servers: { x: { environment: { API_KEY: '{env:API_KEY}' } } } } })
    expect(replaced).toEqual([])
  })

  it('白名单段之外的面板字段不落被控端文件', () => {
    const sections = extractProjectSections({ mcp: { servers: {} }, provider: { p: {} }, unknownSection: { x: 1 }, apiKey: 'sk-panel' })
    expect(Object.keys(sections)).toEqual(['mcp', 'provider'])
  })
})

describe('写入脚本', () => {
  it('原子写 + .ocrc-bak，内容走 stdin 的 base64', () => {
    const { script, stdin } = buildProjectConfigWriteScript('/home/demo/project/opencode.jsonc', 'eyJhIjoxfQ==')
    expect(script).toContain("P='/home/demo/project/opencode.jsonc'")
    expect(script).toContain('mktemp')
    expect(script).toContain('cp -p "$P" "$P.ocrc-bak"')
    expect(script).toContain('mv "$T" "$P"')
    expect(stdin).toBe('eyJhIjoxfQ==')
  })

  it('目标路径里的单引号被正确转义（不注入）', () => {
    const { script } = buildProjectConfigWriteScript("/home/o'brien/opencode.json", 'x')
    expect(script).toContain(`'/home/o'\\''brien/opencode.json'`)
  })
})
