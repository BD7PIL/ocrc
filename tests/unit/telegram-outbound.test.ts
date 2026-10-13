// B5（批次 4）媒体输出的**发送端**集成验证：真 grammy + 本地 mock Bot API。
// 目的：把「无 TG 端实测」从「完全没验」收窄到「只差真 bot 投递」——不碰生产 bot、
// 不需要 token。
// 断言：四种 kind 分别打到 `/bot<token>/sendPhoto|sendVideo|sendAudio|sendDocument`，
// multipart 字段名与 filename 正确，chat_id 正确。
import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Bot } from 'grammy'
import { grammyOutboundSender } from '../../src/transport/telegram/outbound.js'

interface Hit { path: string; body: string }

/** 本地 mock Bot API：记录 path + multipart 原始体，回一个最小合法 result。 */
function mockBotApi(): { server: Server; hits: Hit[]; apiRoot: Promise<string> } {
  const hits: Hit[] = []
  let resolveRoot: (u: string) => void
  const apiRoot = new Promise<string>((r) => (resolveRoot = r))
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += String(c) })
    req.on('end', () => {
      hits.push({ path: req.url ?? '', body })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, result: { message_id: hits.length, date: 1, chat: { id: 1, type: 'private' } } }))
    })
  })
  server.listen(0, '127.0.0.1', () => resolveRoot(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))
  return { server, hits, apiRoot }
}

describe('B5 媒体输出发送端（grammy + mock Bot API）', () => {
  const servers: Server[] = []
  afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()))
  })

  it('四种 kind 各打到对应端点，multipart 字段名/filename/chat_id 正确', async () => {
    const { server, hits, apiRoot } = mockBotApi()
    servers.push(server)
    // apiRoot 末尾不能带 '/'（grammy 拼 `${root}/bot${token}/${method}`）。
    const bot = new Bot('123:TEST', { client: { apiRoot: await apiRoot } })
    const send = grammyOutboundSender(bot.api, 42)

    const names = ['shot.png', 'clip.mp4', 'voice.mp3', '报告.pdf']
    await send('photo', { buf: Buffer.from('PNGBYTES'), filename: names[0]! })
    await send('video', { buf: Buffer.from('MP4BYTES'), filename: names[1]! })
    await send('audio', { buf: Buffer.from('MP3BYTES'), filename: names[2]! })
    await send('document', { buf: Buffer.from('PDFBYTES'), filename: names[3]! })

    expect(hits.map((h) => h.path)).toEqual([
      '/bot123:TEST/sendPhoto',
      '/bot123:TEST/sendVideo',
      '/bot123:TEST/sendAudio',
      '/bot123:TEST/sendDocument',
    ])
    // grammy 把文件作为 `attach://<id>` 引用：payload 字段名必须与 kind 对应，
    // 且该 id 指向的文件分片要带原始 filename（含非 ASCII）。
    const fields = ['photo', 'video', 'audio', 'document']
    for (let i = 0; i < hits.length; i++) {
      const body = hits[i]!.body
      expect(body, `#${i} chat_id 分片`).toContain('name="chat_id"')
      expect(body, `#${i} chat_id 值`).toMatch(/name="chat_id"[\s\S]{0,8}\r?\n\r?\n42/)
      const attachId = new RegExp(`name="${fields[i]}"[\\s\\S]{0,8}\\r?\\n\\r?\\nattach://([a-z0-9]+)`).exec(body)?.[1]
      expect(attachId, `#${i} attach 引用`).toBeTruthy()
      expect(body, `#${i} 文件分片 filename`).toContain(`name="${attachId}";filename=${names[i]}`)
    }
  })

  it('token 不同 → 端点前缀跟着变（不是硬编码）', async () => {
    const { server, hits, apiRoot } = mockBotApi()
    servers.push(server)
    const bot = new Bot('999:OTHER', { client: { apiRoot: await apiRoot } })
    await grammyOutboundSender(bot.api, 'chat-1')('document', { buf: Buffer.from('X'), filename: 'x.txt' })
    expect(hits[0]!.path).toBe('/bot999:OTHER/sendDocument')
    expect(hits[0]!.body).toContain('chat-1')
  })
})
