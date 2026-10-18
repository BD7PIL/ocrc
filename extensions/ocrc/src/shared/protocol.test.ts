import { describe, expect, it } from 'vitest'
import { buildSshArgs, DEFAULT_LOCAL_PORT, normalizeProfile } from './protocol.js'

const base = { host: '192.168.26.101', user: 'demo', port: 22, remotePort: 4096, localPort: 4096 }

describe('buildSshArgs — 一条 ssh，全部转发', () => {
  it('没有额外转发时就是原来的样子（批次 2 起的行为不能变）', () => {
    const args = buildSshArgs(normalizeProfile(base))
    expect(args).toContain('-L')
    expect(args).toContain('127.0.0.1:4096:127.0.0.1:4096')
    expect(args.at(-1)).toBe('demo@192.168.26.101')
  })

  it('额外转发与主隧道同一个进程里（D15：生命周期完全一致）', () => {
    const args = buildSshArgs(normalizeProfile({
      ...base,
      forwards: [
        { direction: 'local', peerHost: '192.168.96.11', peerPort: 8080, port: 41001, activePort: 41001, reason: 'searxng' },
        { direction: 'remote', peerHost: '127.0.0.1', peerPort: 9222, port: 41002, activePort: 41002, reason: '面板侧浏览器' },
      ],
    }))
    expect(args.filter((a) => a === '-L')).toHaveLength(2) // 主隧道 + searxng
    expect(args).toContain('127.0.0.1:41001:192.168.96.11:8080')
    expect(args).toContain('-R')
    expect(args).toContain('127.0.0.1:41002:127.0.0.1:9222')
    // 只起一个进程：只有一个目标参数。
    expect(args.filter((a) => a === 'demo@192.168.26.101')).toHaveLength(1)
  })

  it('端口还没分配的转发不进 argv（不能让 ssh 起在我们不知道的端口上）', () => {
    const args = buildSshArgs(normalizeProfile({
      ...base,
      forwards: [{ direction: 'local', peerHost: 'a.lan', peerPort: 80, port: 0, activePort: 0, reason: '未分配' }],
    }))
    expect(args.join(' ')).not.toContain('a.lan')
  })

  it('私钥路径照旧只影响 -i', () => {
    const args = buildSshArgs(normalizeProfile({ ...base, keyPath: 'C:\\keys\\id_ed25519' }))
    expect(args).toContain('-i')
    expect(args).toContain('C:\\keys\\id_ed25519')
  })
})

describe('normalizeProfile — 档案是主机级（D16）', () => {
  it('项目目录是子项，POSIX 绝对路径才收', () => {
    const profile = normalizeProfile({
      ...base,
      projects: [{ path: '/home/demo/project', label: '主项目' }, { path: 'relative/x' }, { path: 'C:\\win' }, { path: '/opt/work' }],
    })
    expect(profile.projects).toEqual([{ path: '/home/demo/project', label: '主项目' }, { path: '/opt/work' }])
  })

  it('allowedRoots 与 projects 各自独立（前者是授权，后者是绑定）', () => {
    const profile = normalizeProfile({ ...base, allowedRoots: ['/home/demo'] })
    expect(profile.allowedRoots).toEqual(['/home/demo'])
    expect(profile.projects).toBeUndefined()
  })

  it('端口与默认值照旧', () => {
    const profile = normalizeProfile({ host: 'h' })
    expect(profile.port).toBe(22)
    expect(profile.user).toBe('root')
    expect(profile.localPort).toBe(DEFAULT_LOCAL_PORT)
  })

  it('engineVersion 留白为 undefined，不做假默认', () => {
    expect(normalizeProfile(base).engineVersion).toBeUndefined()
    expect(normalizeProfile({ ...base, engineVersion: ' 2.0.27 ' }).engineVersion).toBe('2.0.27')
  })
})
