import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StreamingRenderer } from '../../../src/transport/telegram/streaming-render.js'
import { __resetStreamThrottleForTests } from '../../../src/transport/telegram/streaming/stream-throttle.js'

function fakeApi() {
  return {
    sendMessage: vi.fn(async () => ({ message_id: 11 })),
    sendRichMessage: vi.fn(async () => ({ message_id: 12 })),
    editMessageText: vi.fn(async () => true),
    deleteMessage: vi.fn(async () => true),
    editMessageReplyMarkup: vi.fn(async () => true),
  }
}

const RICH_TEXT = '# Heading\n\nSome **bold** paragraph here.\n\n```ts\nconst x = 1\n```\n'

describe('StreamingRenderer', () => {
  let api: ReturnType<typeof fakeApi>

  beforeEach(() => {
    vi.useFakeTimers()
    __resetStreamThrottleForTests()
    api = fakeApi()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function makeRenderer() {
    return new StreamingRenderer({ api: api as never, chatId: '42' })
  }

  it('delivers native rich parts via sendRichMessage (no parse_mode path)', async () => {
    const r = makeRenderer()
    r.onStreaming('s1', 'msg1', RICH_TEXT)
    await vi.advanceTimersByTimeAsync(1100)

    expect(api.sendRichMessage).toHaveBeenCalledTimes(1)
    const [chatId, rich] = api.sendRichMessage.mock.calls[0] as unknown as [string, { blocks: unknown[] }]
    expect(chatId).toBe('42')
    expect(Array.isArray(rich.blocks)).toBe(true)
    expect(rich.blocks.length).toBeGreaterThan(0)
    // plain sendMessage must not be used for a native part
    expect(api.sendMessage).not.toHaveBeenCalled()
  })

  it('skips the edit when the flushed payload is unchanged (signature round-trip)', async () => {
    const r = makeRenderer()
    r.onStreaming('s1', 'msg1', RICH_TEXT)
    await vi.advanceTimersByTimeAsync(1100)
    expect(api.sendRichMessage).toHaveBeenCalledTimes(1)

    // Same text again → the flush must SKIP (signature matches what was sent)
    r.onStreaming('s1', 'msg1', RICH_TEXT)
    await vi.advanceTimersByTimeAsync(1100)
    expect(api.sendRichMessage).toHaveBeenCalledTimes(1)
    expect(api.editMessageText).not.toHaveBeenCalled()

    // Changed text → exactly one edit
    r.onStreaming('s1', 'msg1', RICH_TEXT + '\nMore text.\n')
    await vi.advanceTimersByTimeAsync(1100)
    expect(api.editMessageText).toHaveBeenCalledTimes(1)
  })

  it('treats "message is not modified" as a successful edit', async () => {
    api.editMessageText.mockRejectedValueOnce(new Error('Bad Request: message is not modified'))
    const r = makeRenderer()
    r.onStreaming('s1', 'msg1', RICH_TEXT)
    await vi.advanceTimersByTimeAsync(1100)

    r.onStreaming('s1', 'msg1', RICH_TEXT + '\nchanged\n')
    await vi.advanceTimersByTimeAsync(1100)

    // The not-modified edit must not break or degrade the stream: the next
    // real change still edits normally.
    api.editMessageText.mockClear()
    r.onStreaming('s1', 'msg1', RICH_TEXT + '\nchanged again\n')
    await vi.advanceTimersByTimeAsync(1100)
    expect(api.editMessageText).toHaveBeenCalledTimes(1)
    // plainOnly degradation never kicked in — still the rich path
    expect(api.sendMessage).not.toHaveBeenCalled()
  })

  it('finalize fallback delivers ALL parts, not just the first', async () => {
    // 600 short paragraphs exceed the 480-block part budget → ≥2 parts.
    const longText = Array.from({ length: 600 }, (_, i) => `para ${i}`).join('\n\n')
    const r = makeRenderer()
    await r.onFinalize('s1', [{ type: 'text', text: longText }], undefined)

    expect(api.sendRichMessage.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('finalize attaches the action bar to the last delivered message', async () => {
    const r = makeRenderer()
    const keyboard = { inline_keyboard: [] }
    await r.onFinalize('s1', [{ type: 'text', text: RICH_TEXT }], undefined, {
      text: '⌨️ 操作',
      keyboard,
    })
    expect(api.editMessageReplyMarkup).toHaveBeenCalledTimes(1)
    const [chatId, messageId, markup] = api.editMessageReplyMarkup.mock.calls[0] as unknown as [
      string, number, { reply_markup: unknown },
    ]
    expect(chatId).toBe('42')
    expect(messageId).toBe(12)
    expect(markup.reply_markup).toBe(keyboard)
  })
})
