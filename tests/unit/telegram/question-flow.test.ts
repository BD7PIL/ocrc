import { describe, it, expect, vi, beforeEach } from 'vitest'
import { QuestionFlow } from '../../../src/transport/telegram/question-flow'
import { InteractionManager } from '../../../src/transport/telegram/managers/interaction-manager'
import type { QuestionInfo } from '../../../src/core/agent/backend'

function fakeCtx() {
  return {
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageText: vi.fn().mockResolvedValue(undefined),
  } as any
}

function fakeApi() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
    editMessageText: vi.fn().mockResolvedValue(undefined),
  } as any
}

const Q: QuestionInfo[] = [
  { question: 'Deploy now?', header: 'Deploy', options: [{ label: 'Yes' }, { label: 'No' }] },
  { question: 'Which env?', header: 'Env', multiple: true, options: [{ label: 'dev' }, { label: 'staging' }, { label: 'prod' }] },
]

function flow(over: { answer?: any; reject?: any } = {}) {
  const interactionManager = new InteractionManager()
  const f = new QuestionFlow({
    interactionManager,
    answer: over.answer ?? vi.fn().mockResolvedValue({ ok: true }),
    reject: over.reject ?? vi.fn().mockResolvedValue({ ok: true }),
  }, '100')
  return { f, interactionManager }
}

const REQ = { requestId: 'que_1', sessionId: 'ses_1', questions: Q }

describe('QuestionFlow', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('presents the first question and holds the mutex slot', async () => {
    const { f, interactionManager } = flow()
    const api = fakeApi()
    await f.present(api, REQ)
    expect(api.sendMessage).toHaveBeenCalledTimes(1)
    const [, text, opts] = api.sendMessage.mock.calls[0]
    expect(text).toContain('Deploy')
    expect(String((opts as any).reply_markup.inline_keyboard[0][0].text)).toContain('Yes')
    expect(interactionManager.getSnapshot()?.kind).toBe('question')
  })

  it('single-choice tap answers with the raw label and clears the slot', async () => {
    const answer = vi.fn().mockResolvedValue({ ok: true })
    const { f, interactionManager } = flow({ answer })
    const api = fakeApi()
    await f.present(api, { requestId: 'que_1', sessionId: 'ses_1', questions: [Q[0]] })
    // Token is derived from the requestId; extract it from the sent keyboard.
    const kb = (api.sendMessage.mock.calls[0][2] as any).reply_markup
    const data = kb.inline_keyboard[0][0].callback_data as string // q:<tok>:o:0
    const tok = data.split(':')[1]
    const ctx = fakeCtx()
    await f.onOption(ctx, tok, 0)
    expect(answer).toHaveBeenCalledWith('ses_1', 'que_1', [['Yes']])
    expect(ctx.editMessageText).toHaveBeenCalledWith('✅ 已提交回答')
    expect(interactionManager.getSnapshot()).toBeNull()
  })

  it('multi-choice toggles then submits both labels on 提交', async () => {
    const answer = vi.fn().mockResolvedValue({ ok: true })
    const { f } = flow({ answer })
    const api = fakeApi()
    await f.present(api, REQ)
    const kb1 = (api.sendMessage.mock.calls[0][2] as any).reply_markup
    const tok = (kb1.inline_keyboard[0][0].callback_data as string).split(':')[1]
    // Q1 is single-choice → tap advances to Q2 (Env, multi).
    await f.onOption(fakeCtx(), tok, 0)
    await f.onOption(fakeCtx(), tok, 0) // dev on
    await f.onOption(fakeCtx(), tok, 2) // prod on
    await f.onSubmit(fakeCtx(), tok)
    expect(answer).toHaveBeenCalledWith('ses_1', 'que_1', [['Yes'], ['dev', 'prod']])
  })

  it('reject calls rejectQuestion and closes the slot', async () => {
    const reject = vi.fn().mockResolvedValue({ ok: true })
    const { f, interactionManager } = flow({ reject })
    const api = fakeApi()
    await f.present(api, REQ)
    const kb = (api.sendMessage.mock.calls[0][2] as any).reply_markup
    const tok = (kb.inline_keyboard[0][0].callback_data as string).split(':')[1]
    await f.onReject(fakeCtx(), tok)
    expect(reject).toHaveBeenCalledWith('ses_1', 'que_1')
    expect(interactionManager.getSnapshot()).toBeNull()
  })

  it('defers to an active permission (slot busy note, no slot start)', async () => {
    const { f, interactionManager } = flow()
    interactionManager.start({ kind: 'permission', expectedInput: 'callback', payload: { requests: [] } } as any)
    const api = fakeApi()
    await f.present(api, REQ)
    expect(api.sendMessage).toHaveBeenCalledWith('100', expect.stringContaining('Web 端'))
    expect(interactionManager.getSnapshot()?.kind).toBe('permission')
  })

  it('external resolution edits the prompt and clears state', async () => {
    const { f, interactionManager } = flow()
    const api = fakeApi()
    await f.present(api, REQ)
    await f.onExternal(api, 'que_1', 'replied')
    expect(api.editMessageText).toHaveBeenCalledWith('100', 42, expect.stringContaining('已在其他界面回答'))
    expect(interactionManager.getSnapshot()).toBeNull()
  })

  it('free-text-only requests point to web without taking the slot', async () => {
    const { f, interactionManager } = flow()
    const api = fakeApi()
    await f.present(api, { requestId: 'que_2', sessionId: 'ses_1', questions: [
      { question: 'Describe', options: [], custom: true },
    ] })
    expect(api.sendMessage).toHaveBeenCalledWith('100', expect.stringContaining('Web 端'))
    expect(interactionManager.getSnapshot()).toBeNull()
  })

  it('stale answers (resolved elsewhere) show the stale label', async () => {
    const answer = vi.fn().mockResolvedValue({ ok: false, stale: true })
    const { f } = flow({ answer })
    const api = fakeApi()
    await f.present(api, { requestId: 'que_3', sessionId: 'ses_1', questions: [Q[0]] })
    const tok = ((api.sendMessage.mock.calls[0][2] as any).reply_markup.inline_keyboard[0][0].callback_data as string).split(':')[1]
    const ctx = fakeCtx()
    await f.onOption(ctx, tok, 0)
    expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringContaining('已在其他界面回答'))
  })
})
