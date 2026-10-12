// B8 附件上行（批次 5）单测：边界（白名单/大小）、落盘 staging、路径注入、会话清理。
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import {
  ATTACHMENT_MAX_BYTES, attachmentDirFor, attachmentKind, attachmentNote, cleanupSessionAttachments,
  isBlockedAttachment, safeAttachmentName, saveAttachment,
} from '../../src/core/attachments.js'
import { registerMessage } from '../../src/transport/web/routes/message.js'

const home = mkdtempSync(join(tmpdir(), 'b8-'))
afterAll(() => rmSync(home, { recursive: true, force: true }))

describe('边界：可执行/脚本类白名单', () => {
  it('拒收可执行与脚本类', () => {
    for (const n of ['setup.exe', 'lib.DLL', 'run.sh', 'a.bat', 'x.ps1', 'app.jar', 'pkg.deb', 'x.apk', 'c.lnk']) {
      expect(isBlockedAttachment(n)).toBe(true)
    }
  })
  it('放行常见文档/媒体类', () => {
    for (const n of ['report.pdf', 'notes.md', 'data.csv', 'photo.png', 'clip.mp4', 'voice.m4a', 'bundle.zip']) {
      expect(isBlockedAttachment(n)).toBe(false)
    }
  })
  it('路径穿越与怪异字符被规整成安全名', () => {
    expect(safeAttachmentName('../../etc/passwd')).toBe('passwd')
    expect(safeAttachmentName('a\\b\\c.txt')).toBe('c.txt')
    expect(safeAttachmentName('   ')).toBe('attachment')
  })
})

describe('落盘 staging 与路径注入', () => {
  it('写入会话子目录，note 措辞与 TG 收件同族', () => {
    const path = saveAttachment('ses_b8', 'notes.md', Buffer.from('hello'), home)
    expect(path.startsWith(attachmentDirFor('ses_b8', home))).toBe(true)
    expect(readFileSync(path, 'utf-8')).toBe('hello')
    expect(attachmentNote('document', 'notes.md', 5, path)).toBe(
      `[附件 document: notes.md（0KB），已保存到 ${path}——需要时用文件工具读取]`,
    )
  })

  it('会话删除清理整目录（幂等）', () => {
    saveAttachment('ses_b8_clean', 'a.txt', Buffer.from('x'), home)
    expect(existsSync(attachmentDirFor('ses_b8_clean', home))).toBe(true)
    cleanupSessionAttachments('ses_b8_clean', home)
    expect(existsSync(attachmentDirFor('ses_b8_clean', home))).toBe(false)
    cleanupSessionAttachments('ses_b8_clean', home) // 幂等
  })

  it('类型词按 mime 优先、扩展名兜底', () => {
    expect(attachmentKind('x.bin', 'image/png')).toBe('photo')
    expect(attachmentKind('x.bin', 'video/mp4')).toBe('video')
    expect(attachmentKind('voice.m4a')).toBe('audio')
    expect(attachmentKind('report.pdf')).toBe('document')
  })
})

describe('/api/message 附件通道（host 侧纵深防御）', () => {
  const app = new Hono()
  const seen: Array<{ text?: string }> = []
  // 真实 server 由 auth 中间件写 c.user；这里补一个最小上下文。
  app.use('*', async (c, next) => { (c as any).set('user', { email: 'dev@local', sub: 'dev' }); await next() })
  registerMessage(app, async (msg) => { seen.push({ text: msg.text }) })

  it('非图片附件落盘并把路径说明折进文本', async () => {
    seen.length = 0
    const res = await app.request('/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'ses_b8_route',
        text: '看这个文件',
        clientId: 'c1',
        attachments: [{ name: 'notes.md', mimeType: 'text/markdown', data: Buffer.from('# hi').toString('base64') }],
      }),
    })
    expect(res.status).toBe(200)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.text).toContain('看这个文件')
    expect(seen[0]!.text).toMatch(/\[附件 document: notes\.md（\d+KB），已保存到 .*notes\.md——需要时用文件工具读取\]/)
  })

  it('可执行类拒收（400，如实回错）', async () => {
    const res = await app.request('/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 's', text: 'x', attachments: [{ name: 'setup.exe', data: Buffer.from('MZ').toString('base64') }] }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('可执行/脚本类')
  })

  it('超 20MB 拒收', async () => {
    const big = Buffer.alloc(ATTACHMENT_MAX_BYTES + 1, 1)
    const res = await app.request('/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 's', text: 'x', attachments: [{ name: 'big.pdf', data: big.toString('base64') }] }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('20MB')
  })
})
