import http from 'node:http'
import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createInstanceProxy, isLocalTarget, isTargetAllowed, parseAbsoluteUrlTarget, parseConnectTarget, type InstanceProxy,
} from '../../src/core/remote-instance-proxy.js'

/**
 * P3 / R9：控制端出网中继。这里测的三件事都是"错了就会静默"的：
 *   · 解析（CONNECT 目标写错 → 对端拿到 400，模型调用莫名其妙失败）；
 *   · 拒绝本机目标（少了这条，反向隧道就成了通往控制端 loopback 的门）；
 *   · 记录每次出网（没有它，"请求成功"分不清是走了我们还是对端自己有网）。
 */

describe('CONNECT 目标解析', () => {
  it('吃标准请求行，含 IPv6 括号形式', () => {
    expect(parseConnectTarget('CONNECT api.anthropic.com:443 HTTP/1.1')).toEqual({ host: 'api.anthropic.com', port: 443 })
    expect(parseConnectTarget('CONNECT [2001:db8::1]:8443 HTTP/1.1')).toEqual({ host: '2001:db8::1', port: 8443 })
    expect(parseConnectTarget('CONNECT host:443 HTTP/1.0')).toEqual({ host: 'host', port: 443 })
    expect(parseConnectTarget('  CONNECT host:443 HTTP/1.1  ')).toEqual({ host: 'host', port: 443 })
  })

  it('非法请求行一律 undefined（宁可 400，不要连错地方）', () => {
    expect(parseConnectTarget('GET /x HTTP/1.1')).toBeUndefined()
    expect(parseConnectTarget('CONNECT host HTTP/1.1')).toBeUndefined()
    expect(parseConnectTarget('CONNECT host:0 HTTP/1.1')).toBeUndefined()
    expect(parseConnectTarget('CONNECT host:99999 HTTP/1.1')).toBeUndefined()
    expect(parseConnectTarget('')).toBeUndefined()
  })

  it('绝对形式 URL（明文 HTTP 代理路径）只认 http:', () => {
    expect(parseAbsoluteUrlTarget('http://example.com/a?b=1')).toEqual({ host: 'example.com', port: 80 })
    expect(parseAbsoluteUrlTarget('http://example.com:8080/a')).toEqual({ host: 'example.com', port: 8080 })
    expect(parseAbsoluteUrlTarget('https://example.com/a')).toBeUndefined()
    expect(parseAbsoluteUrlTarget('/relative')).toBeUndefined()
  })

  it('本机目标被识别（反向隧道不是通往控制端 loopback 的门）', () => {
    expect(isLocalTarget('127.0.0.1')).toBe(true)
    expect(isLocalTarget('127.1.2.3')).toBe(true)
    expect(isLocalTarget('localhost')).toBe(true)
    expect(isLocalTarget('LOCALHOST')).toBe(true)
    expect(isLocalTarget('::1')).toBe(true)
    expect(isLocalTarget('[::1]')).toBe(true)
    expect(isLocalTarget('0.0.0.0')).toBe(true)
    expect(isLocalTarget('192.0.2.10')).toBe(false)
    expect(isLocalTarget('api.anthropic.com')).toBe(false)
  })

  it('白名单：空=不限制；否则只认点边界后缀（大小写不敏感）', () => {
    expect(isTargetAllowed('anything.example', [])).toBe(true)
    expect(isTargetAllowed('anything.example', undefined)).toBe(true)
    // 精确与子域
    expect(isTargetAllowed('api.deepseek.com', ['deepseek.com'])).toBe(true)
    expect(isTargetAllowed('deepseek.com', ['deepseek.com'])).toBe(true)
    expect(isTargetAllowed('API.DeepSeek.com', ['deepseek.com'])).toBe(true)
    // 点边界：不许 `notexample.com` 冒充 `example.com`
    expect(isTargetAllowed('notexample.com', ['example.com'])).toBe(false)
    expect(isTargetAllowed('evil-deepseek.com', ['deepseek.com'])).toBe(false)
    // 子域条目只匹配它自己
    expect(isTargetAllowed('other.deepseek.com', ['api.deepseek.com'])).toBe(false)
    // 空白与尾点被忽略
    expect(isTargetAllowed('api.openai.com.', [' OpenAI.com '])).toBe(true)
    expect(isTargetAllowed('x.com', ['  '])).toBe(true) // 全是空条目 = 不限制
  })
})

describe('中继实跑（回环靶机，不碰外网）', () => {
  let proxy: InstanceProxy | undefined
  let origin: http.Server | undefined
  let originPort = 0

  afterEach(async () => {
    await proxy?.close()
    proxy = undefined
    if (origin) await new Promise<void>((r) => origin!.close(() => r()))
    origin = undefined
  })

  async function startOrigin(): Promise<number> {
    origin = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' }).end(`origin saw ${req.url}`)
    })
    await new Promise<void>((r) => origin!.listen(0, '127.0.0.1', () => r()))
    const addr = origin!.address()
    if (!addr || typeof addr === 'string') throw new Error('no port')
    originPort = addr.port
    return originPort
  }

  it('CONNECT 隧道通、且目标被记录（R9 的证据就是这条记录）', async () => {
    const target = await startOrigin()
    proxy = await createInstanceProxy({ port: 0, allowLocal: true })
    const seen: string[] = []
    proxy.connects.length = 0

    const body = await new Promise<string>((resolve, reject) => {
      const raw = net.connect(proxy!.port, '127.0.0.1', () => {
        raw.write(`CONNECT 127.0.0.1:${target} HTTP/1.1\r\nHost: 127.0.0.1:${target}\r\n\r\n`)
      })
      let buf = ''
      raw.on('data', (d) => {
        buf += d.toString()
        if (!buf.includes('origin saw')) {
          if (buf.includes('\r\n\r\n')) raw.write('GET /probe HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
          return
        }
        raw.end()
        resolve(buf)
      })
      raw.on('error', reject)
      raw.setTimeout(5_000, () => reject(new Error('timeout')))
    })
    expect(body).toContain('200 Connection Established')
    expect(body).toContain('origin saw /probe')
    expect(proxy.connects).toEqual([{ host: '127.0.0.1', port: target }])
    seen.push('ok')
    expect(seen).toHaveLength(1)
  })

  it('默认拒绝本机目标：403 且不记为出网', async () => {
    const target = await startOrigin()
    proxy = await createInstanceProxy({ port: 0 })
    proxy.connects.length = 0
    const head = await new Promise<string>((resolve, reject) => {
      const raw = net.connect(proxy!.port, '127.0.0.1', () => {
        raw.write(`CONNECT 127.0.0.1:${target} HTTP/1.1\r\n\r\n`)
      })
      let buf = ''
      raw.on('data', (d) => { buf += d.toString() })
      raw.on('close', () => resolve(buf))
      raw.on('error', reject)
      raw.setTimeout(5_000, () => reject(new Error('timeout')))
    })
    expect(head).toContain('403')
    expect(proxy.connects).toEqual([])
  })

  it('白名单拒绝：CONNECT 在拨号之前就 403，且不记为出网', async () => {
    proxy = await createInstanceProxy({ port: 0, allow: ['allowed.example'] })
    proxy.connects.length = 0
    const head = await new Promise<string>((resolve, reject) => {
      const raw = net.connect(proxy!.port, '127.0.0.1', () => {
        // 目标名不存在也没关系：拒绝发生在 net.connect 之前
        raw.write('CONNECT blocked.example:443 HTTP/1.1\r\n\r\n')
      })
      let buf = ''
      raw.on('data', (d) => { buf += d.toString() })
      raw.on('close', () => resolve(buf))
      raw.on('error', reject)
      raw.setTimeout(5_000, () => reject(new Error('timeout')))
    })
    expect(head).toContain('403')
    expect(proxy.connects).toEqual([])
  })

  it('白名单放行分支：列进去的目标照常走隧道（不是"有白名单就全拦"）', async () => {
    const target = await startOrigin()
    proxy = await createInstanceProxy({ port: 0, allow: ['127.0.0.1'], allowLocal: true })
    proxy.connects.length = 0
    const body = await new Promise<string>((resolve, reject) => {
      const raw = net.connect(proxy!.port, '127.0.0.1', () => {
        raw.write(`CONNECT 127.0.0.1:${target} HTTP/1.1\r\nHost: 127.0.0.1:${target}\r\n\r\n`)
      })
      let buf = ''
      raw.on('data', (d) => {
        buf += d.toString()
        if (!buf.includes('origin saw')) {
          if (buf.includes('\r\n\r\n')) raw.write('GET /allowed HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
          return
        }
        raw.end()
        resolve(buf)
      })
      raw.on('error', reject)
      raw.setTimeout(5_000, () => reject(new Error('timeout')))
    })
    expect(body).toContain('200 Connection Established')
    expect(body).toContain('origin saw /allowed')
    expect(proxy.connects).toEqual([{ host: '127.0.0.1', port: target }])
  })

  it('明文 HTTP 代理路径：绝对形式 URL 被转发', async () => {
    const target = await startOrigin()
    proxy = await createInstanceProxy({ port: 0, allowLocal: true })
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: proxy!.port, method: 'GET', path: `http://127.0.0.1:${target}/plain`, headers: { host: `127.0.0.1:${target}` } },
        (res) => {
          let b = ''
          res.on('data', (d) => { b += d.toString() })
          res.on('end', () => resolve(b))
        },
      )
      req.on('error', reject)
      req.end()
    })
    expect(body).toContain('origin saw /plain')
    expect(proxy.connects.some((t) => t.port === target)).toBe(true)
  })

  it('没有绝对形式 URL 的明文请求 → 400（我们不做透明代理）', async () => {
    proxy = await createInstanceProxy({ port: 0, allowLocal: true })
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: proxy!.port, method: 'GET', path: '/bare' }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on('error', reject)
      req.end()
    })
    expect(status).toBe(400)
  })
})
