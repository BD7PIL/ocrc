import { describe, expect, it } from 'vitest'
import {
  AUTH_RELATIVE_PATH, authHasChanges, authPathFor, buildAuthReadScript, buildAuthWriteScript,
  compareAuth, mergeAuth, panelAuthPath, parseAuthRead,
} from './auth-sync.js'

const b64 = (text: string) => Buffer.from(text, 'utf-8').toString('base64')

describe('凭据文件的读', () => {
  it('落点是引擎自己的 auth.json（凭据文件，不是配置文件）', () => {
    expect(authPathFor('/home/demo')).toBe(`/home/demo/${AUTH_RELATIVE_PATH}`)
    expect(AUTH_RELATIVE_PATH).toBe('.local/share/opencode/auth.json')
  })

  it('没有凭据文件时给空对象，不报错', () => {
    expect(parseAuthRead('AUTH_EXISTS=no\nAUTH_READ_DONE=1\n')).toEqual({})
  })

  it('解析远端形状（provider → 凭据条目）', () => {
    const stdout = `AUTH_EXISTS=yes\nAUTH_BEGIN\n${b64('{"xiaomi":{"type":"api","key":"sk-x"}}')}\nAUTH_END\nAUTH_READ_DONE=1\n`
    expect(parseAuthRead(stdout)).toEqual({ xiaomi: { type: 'api', key: 'sk-x' } })
  })

  it('坏文件当作空（合并会整份替换，.ocrc-bak 留原样）', () => {
    const stdout = `AUTH_EXISTS=yes\nAUTH_BEGIN\n${b64('{not json')}\nAUTH_END\n`
    expect(parseAuthRead(stdout)).toEqual({})
  })
})

describe('名字账——面板能看到凭据的唯一一面（D11）', () => {
  it('只回 provider 名字，不回值', () => {
    const inventory = compareAuth(
      { xiaomi: { key: 'sk-panel-secret' }, deepseek: { key: 'sk-d' } },
      { deepseek: { key: 'sk-remote' }, zhipuai: { key: 'sk-z' } },
    )
    expect(inventory).toEqual({
      panelProviders: ['deepseek', 'xiaomi'],
      remoteProviders: ['deepseek', 'zhipuai'],
      missing: ['xiaomi'],
      overlapping: ['deepseek'],
      remoteOnly: ['zhipuai'],
    })
    // 值一个都不在：整个对象序列化后不该出现任何密钥。
    expect(JSON.stringify(inventory)).not.toContain('sk-')
  })
})

describe('粘性合并', () => {
  it('同名条目面板覆盖，被控端独有的一律保留', () => {
    const merged = mergeAuth(
      { deepseek: { key: 'panel' }, xiaomi: { key: 'panel' } },
      { deepseek: { key: 'remote' }, zhipuai: { key: 'remote-only' } },
    )
    expect(merged).toEqual({ deepseek: { key: 'panel' }, xiaomi: { key: 'panel' }, zhipuai: { key: 'remote-only' } })
  })

  it('undefined = 不动', () => {
    const merged = mergeAuth({ deepseek: undefined }, { deepseek: { key: 'remote' } })
    expect(merged.deepseek).toEqual({ key: 'remote' })
  })

  it('只写差异：同样的凭据不比出变化（不产生无意义的 .ocrc-bak）', () => {
    const same = { deepseek: { key: 'k' } }
    expect(authHasChanges(same, { deepseek: { key: 'k' } })).toBe(false)
    expect(authHasChanges(same, { deepseek: { key: 'other' } })).toBe(true)
    expect(authHasChanges(same, {})).toBe(true)
  })
})

describe('写入脚本', () => {
  it('原子写 + .ocrc-bak，且权限收紧到 0600（凭据文件必须私有）', () => {
    const { script, stdin } = buildAuthWriteScript('/home/demo', 'eyJhIjoxfQ==')
    expect(script).toContain("P='/home/demo/.local/share/opencode/auth.json'")
    expect(script).toContain('umask 077')
    expect(script).toContain('chmod 600 "$P"')
    expect(script).toContain('cp -p "$P" "$P.ocrc-bak"')
    expect(script).toContain('mv "$T" "$P"')
    expect(stdin).toBe('eyJhIjoxfQ==')
  })

  it('读脚本用 base64，避免引号/换行撕碎输出', () => {
    const script = buildAuthReadScript('/home/demo')
    expect(script).toContain('base64 < "$P"')
    expect(script).toContain('AUTH_READ_DONE=1')
  })
})

describe('面板宿主的凭据路径（XDG → APPDATA → 家目录）', () => {
  it('XDG_DATA_HOME 优先', () => {
    expect(panelAuthPath({ XDG_DATA_HOME: '/xdg/data' })).toBe('/xdg/data/opencode/auth.json')
  })

  it('没有 XDG 时落到 ~/.local/share/opencode/auth.json', () => {
    expect(panelAuthPath({ HOME: '/Users/me' })).toBe('/Users/me/.local/share/opencode/auth.json')
  })

  it('分隔符跟随 home 自己的写法，不看宿主平台（Windows 上的 POSIX home 不该拼出反斜杠）', () => {
    expect(panelAuthPath({ HOME: '/Users/me/' })).toBe('/Users/me/.local/share/opencode/auth.json')
    expect(panelAuthPath({ HOME: 'C:\\Users\\me' })).toBe('C:\\Users\\me\\.local\\share\\opencode\\auth.json')
  })
})
