import { describe, it, expect, vi } from 'vitest'
import { TelegramSessionRenderer, splitMarkdown } from '../../../src/transport/telegram/renderer'

function fakeBot() {
  return {
    sent: [] as Array<{ chatId: string; text: string; options: any }>,
    edits: [] as Array<{ chatId: string; messageId: string; text: string; options: any }>,
    sendMessage: vi.fn(async function (this: any, chatId: string, text: string, options: any) {
      this.sent.push({ chatId, text, options })
      return { message_id: this.sent.length }
    }),
    editMessageText: vi.fn(async function (this: any, chatId: string, messageId: number, _: any, text: string, options: any) {
      this.edits.push({ chatId, messageId: String(messageId), text, options })
    }),
    deleteMessage: vi.fn(async () => {}),
  }
}

describe('TelegramSessionRenderer overflow', () => {
  it('paginates a long final answer into multiple Telegram messages', async () => {
    const bot = fakeBot()
    const r = new TelegramSessionRenderer({ chatId: '100', sessionId: 'ses', bot: bot as any })
    await r.onCard({ kind: 'thinking', sessionId: 'ses', showStop: true })
    const longMd = Array.from({ length: 30 }, (_, i) => `Paragraph ${i}: ${'x'.repeat(200)}`).join('\n\n')
    await r.onCard({ kind: 'assistant', sessionId: 'ses', blocks: [{ type: 'text', text: longMd }], meta: { cost: 0.04 } })
    // finalize sends new messages (not edits) for each piece
    // thinking + at least 2 finalize pieces
    expect(bot.sent.length).toBeGreaterThanOrEqual(3)
    const last = bot.sent.at(-1)!
    expect(last.text).toMatch(/\$0\.040/)
  })

  it('falls back to plain text when Telegram rejects the HTML', async () => {
    const bot = {
      sent: [] as Array<{ text: string; options: any }>,
      sendMessage: vi.fn(async function (this: any, _chatId: string, text: string, options: any) {
        if (options?.parse_mode === 'HTML') throw new Error("Bad Request: can't parse entities: unbalanced tag")
        this.sent.push({ text, options })
        return { message_id: this.sent.length }
      }),
      deleteMessage: vi.fn(async () => {}),
    }
    const r = new TelegramSessionRenderer({ chatId: '100', sessionId: 'ses', bot: bot as any })
    await r.onCard({ kind: 'assistant', sessionId: 'ses', blocks: [{ type: 'text', text: '**bold** and <stuff>' }], meta: {} })
    const body = bot.sent.map((s) => s.text).join('\n')
    expect(bot.sent.length).toBeGreaterThanOrEqual(1)
    expect(body).not.toMatch(/<b>/)          // tags stripped
    expect(body).toContain('bold')           // content preserved
    expect(bot.sent.every((s) => s.options?.parse_mode === undefined)).toBe(true)
  })
})

describe('Telegram 429 rate-limit handling', () => {
  const err429 = (retryAfter = 1) => ({
    response: { error_code: 429, parameters: { retry_after: retryAfter } },
    message: '429: Too Many Requests',
  })

  it('waits retry_after and resends on 429', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const bot = {
        sent: [] as Array<{ text: string; options: any }>,
        sendMessage: vi.fn(async function (this: any, _c: string, text: string, options: any) {
          calls++
          if (calls < 3) throw err429(2)
          this.sent.push({ text, options })
          return { message_id: calls }
        }),
        deleteMessage: vi.fn(async () => {}),
      }
      const r = new TelegramSessionRenderer({ chatId: '100', sessionId: 'ses', bot: bot as any })
      const p = r.onCard({ kind: 'error', sessionId: 'ses', message: 'boom' })
      await vi.advanceTimersByTimeAsync(10_000)
      await p
      expect(calls).toBe(3)
      expect(bot.sent).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives up after 3 retries when 429 persists', async () => {
    vi.useFakeTimers()
    try {
      const bot = {
        sendMessage: vi.fn(async () => { throw err429() }),
        deleteMessage: vi.fn(async () => {}),
      }
      const r = new TelegramSessionRenderer({ chatId: '100', sessionId: 'ses', bot: bot as any })
      // startThinking swallows the failure, so onCard resolves either way
      const p = r.onCard({ kind: 'thinking', sessionId: 'ses', showStop: true })
      await vi.advanceTimersByTimeAsync(30_000)
      await p
      expect(bot.sendMessage).toHaveBeenCalledTimes(4) // initial + 3 retries
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retry non-429 errors', async () => {
    const bot = {
      sendMessage: vi.fn(async () => { throw new Error('400: chat not found') }),
      deleteMessage: vi.fn(async () => {}),
    }
    const r = new TelegramSessionRenderer({ chatId: '100', sessionId: 'ses', bot: bot as any })
    await r.onCard({ kind: 'thinking', sessionId: 'ses', showStop: true })
    expect(bot.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('throttles back-to-back chunk sends instead of tight-looping', async () => {
    vi.useFakeTimers()
    try {
      const bot = fakeBot()
      const r = new TelegramSessionRenderer({ chatId: '100', sessionId: 'ses', bot: bot as any })
      const longMd = Array.from({ length: 20 }, (_, i) => `Paragraph ${i}: ${'x'.repeat(200)}`).join('\n\n')
      const p = r.onCard({ kind: 'assistant', sessionId: 'ses', blocks: [{ type: 'text', text: longMd }], meta: {} })
      // Flush the microtask chain without advancing timers: only the first
      // chunk(s) can be out — the rest wait on the inter-chunk delay timer.
      for (let i = 0; i < 30; i++) await Promise.resolve()
      const sentImmediately = bot.sent.length
      expect(sentImmediately).toBeGreaterThanOrEqual(1)
      await vi.advanceTimersByTimeAsync(5_000)
      await p
      expect(bot.sent.length).toBeGreaterThan(sentImmediately)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('splitMarkdown', () => {
  it('breaks only at line boundaries and stays under the limit', () => {
    const md = Array.from({ length: 40 }, (_, i) => `line ${i} **bold${i}**`).join('\n')
    const chunks = splitMarkdown(md, 100)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100)
    // round-trips (no characters lost, joins on newline)
    expect(chunks.join('\n')).toBe(md)
    // no chunk splits an inline **bold** token (even count of ** per chunk)
    for (const c of chunks) expect((c.match(/\*\*/g)?.length ?? 0) % 2).toBe(0)
  })

  it('keeps a fenced code block smaller than the limit intact', () => {
    const md = 'intro\n\n```ts\nconst a = 1\nconst b = 2\n```\n\noutro'
    const chunks = splitMarkdown(md, 1000)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toBe(md)
  })

  it('hard-wraps a single line longer than the limit', () => {
    const chunks = splitMarkdown('x'.repeat(250), 100)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100)
    expect(chunks.join('')).toBe('x'.repeat(250))
  })
})
