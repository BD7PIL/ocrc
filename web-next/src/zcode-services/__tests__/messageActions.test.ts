// N9-4 消息动作契约测试：forkAssistant / editUserQuery / setAssistantFeedback。
// 三个命令都走 sendConversationCommandV4；target 必须 rowId+entityId 成对
// （vendor core.ts 的 conversationRowTargetSchema strict）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createOcrcZcodeAgentService } from '../zcodeAgentService.js'

const envel = (type: string, payload: Record<string, unknown>, sessionId = 'ses_a') => ({
  envelope: { commandId: `cmd_${type}_${Math.random().toString(36).slice(2, 7)}`, type, sessionId, payload },
})

beforeEach(() => { try { localStorage.setItem('ocrc.token', 'tok') } catch { /* jsdom 恒有 */ } })
afterEach(() => { vi.unstubAllGlobals(); try { localStorage.removeItem('ocrc.feedback') } catch { /* noop */ } })

function svcWithFetch() {
  return createOcrcZcodeAgentService()
}

describe('N9-4 forkAssistant', () => {
  it('成功：POST /fork 携带 messageID=entityId，ACK 带 forkAssistant+新 sessionId', async () => {
    const calls: Array<{ url: string; body: any }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined })
      if (String(url).endsWith('/fork')) return { ok: true, status: 200, json: async () => ({ id: 'ses_child' }) }
      return { ok: true, status: 200, json: async () => ({}) }
    }))
    const svc = svcWithFetch()
    const ack = await svc.sendConversationCommandV4(envel('forkAssistant', { target: { rowId: 7, entityId: 'msg_x' } }))
    expect(ack.status).toBe('accepted')
    expect(ack.result).toEqual({ type: 'forkAssistant', sessionId: 'ses_child' })
    expect(calls[0].url).toContain('/api/session/ses_a/fork')
    expect(calls[0].body).toEqual({ messageID: 'msg_x' })
  })
  it('缺 target.entityId → failed（不猜 fork 点）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })))
    const svc = svcWithFetch()
    const ack = await svc.sendConversationCommandV4(envel('forkAssistant', { target: { rowId: 7 } }))
    expect(ack.status).toBe('failed')
    expect(ack.reasonCode).toBe('ocrc_bad_payload')
  })
})

describe('N9-4 editUserQuery', () => {
  it('preserve：revert(messageID) + 重发，ACK disposition=rewind', async () => {
    const calls: Array<string> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url))
      if (String(url).includes('/revert')) return { ok: true, status: 200, json: async () => ({ id: 'ses_a' }) }
      if (String(url).endsWith('/api/message')) return { ok: true, status: 200, json: async () => ({ messageId: 'm1' }) }
      return { ok: true, status: 200, json: async () => ({}) }
    }))
    const svc = svcWithFetch()
    const ack = await svc.sendConversationCommandV4(envel('editUserQuery', { target: { rowId: 3, entityId: 'msg_u' }, newText: '改写后的问题' }))
    expect(ack.status).toBe('accepted')
    expect(ack.result).toEqual({ type: 'editUserQuery', disposition: 'rewind', sessionId: 'ses_a' })
    expect(calls[0]).toContain('/revert?messageID=msg_u')
    expect(calls[1]).toContain('/api/message')
  })
  it('rewind 模式如实 rejected（无 checkpoint 机制）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })))
    const svc = svcWithFetch()
    const ack = await svc.sendConversationCommandV4(envel('editUserQuery', { target: { rowId: 3, entityId: 'msg_u' }, newText: 'x', workspaceMode: 'rewind' }))
    expect(ack.status).toBe('rejected')
    expect(ack.reasonCode).toBe('ocrc_rewind_unsupported')
  })
})

describe('N9-4 setAssistantFeedback', () => {
  it('like 持久进 localStorage 并可回读；null 清除', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })))
    const svc = svcWithFetch()
    const ack1 = await svc.sendConversationCommandV4(envel('setAssistantFeedback', { target: { rowId: 5, entityId: 'msg_k' }, feedback: 'like' }))
    expect(ack1.status).toBe('accepted')
    const stored = JSON.parse(localStorage.getItem('ocrc.feedback') ?? '{}')
    expect(stored['msg_k']).toBe('like')
    const ack2 = await svc.sendConversationCommandV4(envel('setAssistantFeedback', { target: { rowId: 5, entityId: 'msg_k' }, feedback: null }))
    expect(ack2.status).toBe('accepted')
    const after = JSON.parse(localStorage.getItem('ocrc.feedback') ?? '{}')
    expect(after['msg_k']).toBeUndefined()
  })
  it('assistantText 行回读 feedback（重建时高亮态不丢）', async () => {
    localStorage.setItem('ocrc.feedback', JSON.stringify({ msg_fb: 'dislike' }))
    const frames: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/api/session/')) return { ok: true, json: async () => ({ cards: [
        { kind: 'user', text: '问', ts: 1, messageId: 'msg_q' },
        { kind: 'assistant', ts: 2, messageId: 'msg_fb', blocks: [{ type: 'text', text: '答' }] },
      ], lastSeq: 2, hasMore: false, busy: false }) }
      if (String(url).includes('/api/models')) return { ok: true, json: async () => [] }
      if (String(url).includes('/api/overrides')) return { ok: true, json: async () => ({ model: null }) }
      if (String(url).includes('/api/sessions')) return { ok: true, json: async () => [] }
      return { ok: true, json: async () => ({}) }
    }))
    const svc = svcWithFetch()
    svc.onDynamicConversationFrame(() => {})((f: any) => frames.push(f))
    await svc.subscribeConversationV4({ sessionId: 'ses_fb', workspacePath: '/w' })
    await new Promise((r) => setTimeout(r, 50))
    const snap = frames.map((f) => f?.frame?.payload?.snapshot).find((s) => s && Array.isArray(s.rows?.window))
    const textRow = snap.rows.window.find((r: any) => r.kind === 'assistantText')
    expect(textRow.feedback).toBe('dislike')
    expect(textRow.entityId).toBe('msg_fb')
  })
})
