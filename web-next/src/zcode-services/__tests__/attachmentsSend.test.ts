// B8 批次 5：桥接侧附件上行分支——图片走 images[]，非图片走 attachments[]；
// 可执行/脚本类如实拒绝（reasonCode），不静默丢弃。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createOcrcZcodeAgentService } from '../zcodeAgentService.js'
import { putWebFile } from '../webAttachments.js'

type Captured = { url: string; body: any }

function stubFetch(captured: Captured[]) {
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url)
    if (u.includes('/api/message')) {
      captured.push({ url: u, body: JSON.parse(init?.body ?? '{}') })
      return { ok: true, json: async () => ({ messageId: 'm1' }) }
    }
    if (u.includes('/api/commands')) return { ok: true, json: async () => [] }
    return { ok: true, json: async () => ({}) }
  })
}

beforeEach(() => { try { localStorage.setItem('ocrc.token', 'tok') } catch { /* jsdom */ } })
afterEach(() => vi.unstubAllGlobals())

describe('B8 附件上行（桥接侧）', () => {
  it('图片 → images[]；非图片 → attachments[]（名字/mime/base64）', async () => {
    const captured: Captured[] = []
    vi.stubGlobal('fetch', stubFetch(captured))
    const svc = createOcrcZcodeAgentService()
    const pngRef = putWebFile(new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' }))
    const mdRef = putWebFile(new File(['# 标题'], 'notes.md', { type: 'text/markdown' }))

    const ack = await (svc as any).sendConversationCommandV4({
      envelope: {
        commandId: 'c1', type: 'sendText', sessionId: 'ses_b8',
        payload: { text: '看这两个', attachments: [{ ref: pngRef, fileName: 'a.png' }, { ref: mdRef, fileName: 'notes.md' }] },
      },
    })
    expect(ack.status).toBe('accepted')
    const post = captured.find((c) => c.url.includes('/api/message'))!
    expect(post.body.images).toHaveLength(1)
    expect(post.body.images[0].mimeType).toBe('image/png')
    expect(post.body.attachments).toHaveLength(1)
    expect(post.body.attachments[0]).toMatchObject({ name: 'notes.md', mimeType: 'text/markdown' })
    expect(Buffer.from(post.body.attachments[0].data, 'base64').toString('utf-8')).toBe('# 标题')
  })

  it('可执行类如实拒绝（ocrc_attachment_blocked），不发请求', async () => {
    const captured: Captured[] = []
    vi.stubGlobal('fetch', stubFetch(captured))
    const svc = createOcrcZcodeAgentService()
    const ref = putWebFile(new File(['MZ'], 'setup.exe', { type: 'application/octet-stream' }))
    const ack = await (svc as any).sendConversationCommandV4({
      envelope: { commandId: 'c2', type: 'sendText', sessionId: 'ses_b8', payload: { text: 'x', attachments: [{ ref, fileName: 'setup.exe' }] } },
    })
    expect(ack.status).toBe('failed')
    expect(ack.reasonCode).toBe('ocrc_attachment_blocked')
    expect(captured.some((c) => c.url.includes('/api/message'))).toBe(false)
  })

  it('未知 ref 如实拒绝（ocrc_attachment_unsupported）', async () => {
    const captured: Captured[] = []
    vi.stubGlobal('fetch', stubFetch(captured))
    const svc = createOcrcZcodeAgentService()
    const ack = await (svc as any).sendConversationCommandV4({
      envelope: { commandId: 'c3', type: 'sendText', sessionId: 'ses_b8', payload: { text: 'x', attachments: [{ ref: 'ocrc-webfile://nope', fileName: 'ghost.pdf' }] } },
    })
    expect(ack.status).toBe('failed')
    expect(ack.reasonCode).toBe('ocrc_attachment_unsupported')
  })
})
