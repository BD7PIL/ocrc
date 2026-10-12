import type { Hono } from 'hono'
import type { IncomingMessage } from '../../../core/types.js'
import type { BackendRegistry } from '../../../core/agent/registry.js'
import { createLogger } from '../../../utils/logger.js'
import {
  ATTACHMENT_MAX_BYTES, attachmentKind, attachmentNote, isBlockedAttachment, safeAttachmentName, saveAttachment,
} from '../../../core/attachments.js'

const log = createLogger('web')

export function registerMessage(
  app: Hono,
  onMessage: (msg: IncomingMessage) => Promise<void>,
  reg?: BackendRegistry,
) {
  app.post('/api/message', async (c) => {
    const body = await c.req.json().catch(() => ({})) as {
      sessionId?: string
      text?: string
      clientId?: string
      variant?: string
      agent?: string
      images?: Array<{ data?: string; mimeType?: string }>
      /** B8 非图片附件上行：{name, mimeType, data(base64)} → 落盘 + 路径注入。 */
      attachments?: Array<{ name?: string; mimeType?: string; data?: string }>
    }
    const images = Array.isArray(body.images)
      ? body.images.filter((i): i is { data: string; mimeType: string } => !!i && typeof i.data === 'string' && typeof i.mimeType === 'string')
      : []
    let text = typeof body.text === 'string' ? body.text : ''
    const rawAttachments = Array.isArray(body.attachments) ? body.attachments : []
    if (text.trim() === '' && images.length === 0 && rawAttachments.length === 0) {
      return c.json({ error: 'text or images required' }, 400)
    }
    const user = c.get('user') as { email: string; sub: string }
    // Use the client-supplied id so the echoed user card carries the same id as
    // the optimistic card the UI already inserted — they reconcile (no dupe).
    const messageId = typeof body.clientId === 'string' && body.clientId ? body.clientId : `web_${Date.now()}`
    // B8：非图片附件落盘 + 把路径说明折进文本（TG 收件同款措辞）。边界在 host 侧再验
    // 一遍（客户端已挡一次，这里是纵深防御）；拒绝时如实回错，不静默丢弃。
    const sessionForAttachments = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : 'default'
    const notes: string[] = []
    for (const att of rawAttachments) {
      const name = safeAttachmentName(String(att?.name ?? ''), 'attachment')
      if (typeof att?.data !== 'string' || !att.data) {
        return c.json({ error: `附件 ${name} 内容缺失` }, 400)
      }
      if (isBlockedAttachment(name)) {
        return c.json({ error: `附件 ${name} 是可执行/脚本类，已拒绝（上行白名单）` }, 400)
      }
      const buf = Buffer.from(att.data, 'base64')
      if (buf.length > ATTACHMENT_MAX_BYTES) {
        return c.json({ error: `附件 ${name} 超过 20MB 上限` }, 400)
      }
      const savedPath = saveAttachment(sessionForAttachments, name, buf)
      notes.push(attachmentNote(attachmentKind(name, att.mimeType), name, buf.length, savedPath))
    }
    if (notes.length) text = [text, ...notes].filter((t) => t.trim() !== '').join('\n\n')
    const msg: IncomingMessage = {
      userId: user.sub ?? user.email,
      chatId: `web:${user.email}`,
      text,
      images: images.length ? images : undefined,
      messageId,
      // Route to the session the web UI is viewing, not the global pinned one,
      // so web and Telegram can converse with different sessions independently.
      sessionId: typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : undefined,
      variant: typeof body.variant === 'string' && body.variant ? body.variant : undefined,
      // Per-message agent override (/z/ 计划模式 → 引擎原生 plan agent)。
      agent: typeof body.agent === 'string' && body.agent ? body.agent : undefined,
      origin: 'web',
    }
    void onMessage(msg).catch((e) => log.warn(`onMessage handler rejected: ${(e as Error).message}`))
    return c.json({ messageId })
  })

  // Raw message content for tool-output pages: proxied to the backend so the
  // web sees parts[].state.output (which never rides the event stream).
  app.get('/api/session/:id/message/:msgId', async (c) => {
    const backend = reg?.forSession(c.req.param('id'))
    if (!backend?.getMessageRaw) return c.json({ error: 'unsupported' }, 501)
    const body = await backend.getMessageRaw(c.req.param('id'), c.req.param('msgId'))
    if (!body) return c.json({ error: 'not found' }, 404)
    return c.json(body)
  })
}
