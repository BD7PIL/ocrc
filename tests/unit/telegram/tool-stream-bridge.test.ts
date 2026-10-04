import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ToolStreamBridge } from '../../../src/transport/telegram/tool-stream-bridge.js'
import { __resetStreamThrottleForTests } from '../../../src/transport/telegram/streaming/stream-throttle.js'

function fakeApi() {
  return {
    sendMessage: vi.fn(async () => ({ message_id: 21 })),
    editMessageText: vi.fn(async () => true),
    deleteMessage: vi.fn(async () => true),
  }
}

type StreamingCard = Extract<Parameters<ToolStreamBridge['onStreamingCard']>[0], { kind: 'streaming' }>

function streamingCard(sid: string, blocks: StreamingCard['blocks']): StreamingCard {
  return { kind: 'streaming', sessionId: sid, blocks, id: `turn:${sid}:1` } as StreamingCard
}

describe('ToolStreamBridge', () => {
  let api: ReturnType<typeof fakeApi>

  beforeEach(() => {
    vi.useFakeTimers()
    __resetStreamThrottleForTests()
    api = fakeApi()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function makeBridge(granularity: 'standard' | 'detailed' = 'detailed') {
    return new ToolStreamBridge({ api: api as never, chatId: '42', granularity: () => granularity })
  }

  it('streams a running tool as one live message (detailed)', async () => {
    const b = makeBridge()
    b.onStreamingCard(streamingCard('s1', [
      { type: 'text', text: 'hi', partId: 't0' },
      { type: 'tool', tool: 'Bash', args: 'npm test', status: 'running', partId: 'p1' },
    ]))
    await vi.advanceTimersByTimeAsync(1100)

    expect(api.sendMessage).toHaveBeenCalledTimes(1)
    expect(api.sendMessage.mock.calls[0][1]).toBe('⏳ Bash · npm test')
  })

  it('flips the line in place when the tool completes', async () => {
    const b = makeBridge()
    b.onStreamingCard(streamingCard('s1', [
      { type: 'tool', tool: 'Bash', args: 'npm test', status: 'running', partId: 'p1' },
    ]))
    await vi.advanceTimersByTimeAsync(1100)

    b.onStreamingCard(streamingCard('s1', [
      { type: 'tool', tool: 'Bash', args: 'npm test', status: 'done', partId: 'p1' },
    ]))
    await vi.advanceTimersByTimeAsync(1100)

    // Same message id edited in place — no second message for one tool.
    expect(api.sendMessage).toHaveBeenCalledTimes(1)
    expect(api.editMessageText).toHaveBeenCalledTimes(1)
    expect(api.editMessageText.mock.calls[0][1]).toBe(21)
    expect(String(api.editMessageText.mock.calls[0][2])).toMatch(/^✅/)
  })

  it('appends elapsed time for tools running past the threshold', async () => {
    const b = makeBridge()
    b.onStreamingCard(streamingCard('s1', [
      { type: 'tool', tool: 'Bash', args: 'sleep 30', status: 'running', partId: 'p1' },
    ]))
    await vi.advanceTimersByTimeAsync(1100)
    api.editMessageText.mockClear()

    // Tracker ticks every second; past 20s the duration suffix appears.
    await vi.advanceTimersByTimeAsync(25_000)
    const withDuration = api.editMessageText.mock.calls.map((c) => String(c[2]))
    expect(withDuration.some((t) => t.includes('🕒'))).toBe(true)
  })

  it('standard granularity streams nothing', async () => {
    const b = makeBridge('standard')
    b.onStreamingCard(streamingCard('s1', [
      { type: 'tool', tool: 'Bash', args: 'npm test', status: 'running', partId: 'p1' },
    ]))
    await vi.advanceTimersByTimeAsync(1100)
    b.onTurnEnd('s1')
    await vi.advanceTimersByTimeAsync(1100)

    expect(api.sendMessage).not.toHaveBeenCalled()
    expect(api.editMessageText).not.toHaveBeenCalled()
  })

  it('onTurnEnd flushes pending lines without waiting for the throttle', async () => {
    const b = makeBridge()
    b.onStreamingCard(streamingCard('s1', [
      { type: 'tool', tool: 'Read', args: 'src/a.ts', status: 'done', partId: 'p1' },
    ]))
    await b.onTurnEnd('s1')

    expect(api.sendMessage).toHaveBeenCalledTimes(1)
    expect(String(api.sendMessage.mock.calls[0][1])).toMatch(/^✅ Read · src\/a\.ts/)
  })
})
