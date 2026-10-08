// 附件管线契约测试（N7-1）。
// 链路：platform 选图 → File 进寄存表、句柄当路径引用（零拷贝，不触发 V4 上传——
// 局域网 http 源没有 crypto.subtle，V4 校验和第一步就会死）→ sendText 时句柄解析回
// 字节 → /api/message 的 images[]。钉三件事：句柄可解析、发送带 images、非图片如实拒绝。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createOcrcZcodeAgentService } from '../zcodeAgentService.js'
import { putWebFile, resolveWebFile, releaseWebFile, WEBFILE_SCHEME } from '../webAttachments.js'

function pngFile(name = 'shot.png', bytes = 8): File {
  const data = new Uint8Array(bytes)
  data[0] = 0x89; data[1] = 0x50 // PNG 魔数开头，语义上像图即可
  return new File([data], name, { type: 'image/png' })
}

beforeEach(() => { try { localStorage.setItem('ocrc.token', 'tok') } catch { /* jsdom 恒有 */ } })
afterEach(() => vi.unstubAllGlobals())

describe('webAttachments 寄存表', () => {
  it('句柄可解析回同一个 File，release 后不可', () => {
    const f = pngFile()
    const handle = putWebFile(f)
    expect(handle.startsWith(WEBFILE_SCHEME)).toBe(true)
    expect(resolveWebFile(handle)).toBe(f)
    releaseWebFile(handle)
    expect(resolveWebFile(handle)).toBeUndefined()
  })
})

describe('sendText 的附件解析', () => {
  it('图片句柄 → /api/message 的 images[]，成功后释放句柄', async () => {
    const calls: Array<{ url: string; body: any }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined })
      return { ok: true, json: async () => ({ messageId: 'm1' }) }
    }))
    const f = pngFile()
    const handle = putWebFile(f)
    const svc = createOcrcZcodeAgentService()
    const ack: any = await svc.sendConversationCommandV4({
      envelope: {
        commandId: 'c1', clientId: 'c1', sessionId: 'ses_a', type: 'sendText', issuedAt: 0,
        payload: { text: '看这张图', attachments: [{ ref: handle, fileName: f.name, mime: 'image/png', bytes: f.size }] },
      },
    })
    expect(ack.status).toBe('accepted')
    const sent = calls.find((c) => c.url.includes('/api/message'))
    expect(sent?.body.images).toHaveLength(1)
    expect(sent?.body.images[0].mimeType).toBe('image/png')
    expect(sent?.body.text).toBe('看这张图')
    // 发送成功 → 句柄已释放（引擎已收到字节）
    expect(resolveWebFile(handle)).toBeUndefined()
  })

  it('不是本页选择的 ref → failed ack，明确说「仅支持图片」', async () => {
    const calls: Array<{ url: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, _init?: any) => {
      calls.push({ url }); return { ok: true, json: async () => ({ messageId: 'm1' }) }
    }))
    const svc = createOcrcZcodeAgentService()
    const ack: any = await svc.sendConversationCommandV4({
      envelope: {
        commandId: 'c2', clientId: 'c2', sessionId: 'ses_a', type: 'sendText', issuedAt: 0,
        payload: { text: 'x', attachments: [{ ref: '/home/u/桌面/报表.pdf', fileName: '报表.pdf', mime: 'application/pdf', bytes: 10 }] },
      },
    })
    expect(ack.status).toBe('failed')
    expect(ack.reasonCode).toBe('ocrc_attachment_unsupported')
    expect(ack.message).toContain('仅支持图片')
    expect(calls.find((c) => c.url.includes('/api/message'))).toBeUndefined()
  })

  it('纯图片、无文本也能发（后端契约：text 或 images 至少其一）', async () => {
    const calls: Array<{ url: string; body: any }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined })
      return { ok: true, json: async () => ({ messageId: 'm1' }) }
    }))
    const handle = putWebFile(pngFile())
    const svc = createOcrcZcodeAgentService()
    const ack: any = await svc.sendConversationCommandV4({
      envelope: {
        commandId: 'c3', clientId: 'c3', sessionId: 'ses_a', type: 'sendText', issuedAt: 0,
        payload: { text: '', attachments: [{ ref: handle, fileName: 'a.png', mime: 'image/png', bytes: 8 }] },
      },
    })
    expect(ack.status).toBe('accepted')
    expect(calls.find((c) => c.url.includes('/api/message'))?.body.images).toHaveLength(1)
  })
})
