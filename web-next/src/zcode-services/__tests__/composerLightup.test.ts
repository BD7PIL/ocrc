// 批次 3 composer 点亮 — 服务级集成测试：
//   canStop 三连（ws busy 帧 → running control patch；stop 命令 → /api/abort）
//   config.mode 回显（GET /policy → snapshot.config.mode）
//   usage.contextWindow（GET /context 的 tokens.used/max → pill 数据；未知 → null）
// control patch 的形状用 vendor 的 sessionControlSchema 逐帧验证。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { sessionControlSchema } from '@zcode/shared/zcode-protocol-v4/snapshot.js'
import { createOcrcZcodeAgentService } from '../zcodeAgentService.js'
import { HOST_RECONNECT_MS } from '../hostConnection.js'

type WsMode = 'open' | 'refused'
let wsMode: WsMode = 'open'
let policy: string | null = null
let contextTokens: { used?: number; max?: number } | null = null
const abortCalls: string[] = []

const wsInstances: FakeWs[] = []
function currentWs(): FakeWs | undefined {
  return wsInstances[wsInstances.length - 1]
}

class FakeWs {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  readyState = FakeWs.OPEN
  url: string
  sent: string[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  constructor(url: string) {
    this.url = url
    wsInstances.push(this)
    if (wsMode === 'open') queueMicrotask(() => this.onopen?.())
    else queueMicrotask(() => { this.onerror?.(); this.onclose?.() })
  }
  send(data: string) { this.sent.push(data) }
  close() {
    if (this.readyState === FakeWs.CLOSED) return
    this.readyState = FakeWs.CLOSED
    queueMicrotask(() => this.onclose?.())
  }
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
}

const fetchMock = vi.fn(async (url: string) => {
  const u = String(url)
  if (u.includes('/api/abort')) {
    abortCalls.push(u)
    return jsonResponse({ ok: true })
  }
  if (u.includes('/policy')) {
    if (policy === null) return jsonResponse({}, 404)
    return jsonResponse({ policy })
  }
  if (u.includes('/context')) return jsonResponse(contextTokens === null ? {} : { tokens: contextTokens })
  if (u.includes('/api/sessions')) return jsonResponse([])
  if (u.includes('/api/models')) return jsonResponse([])
  if (u.includes('/api/overrides')) return jsonResponse({ model: null })
  return jsonResponse({ runs: [], joins: [] })
})

function wirePayloads(frames: any[]): any[] {
  return frames.map((f) => f.frame?.payload).filter(Boolean)
}

function controlDeltas(frames: any[]): any[] {
  return wirePayloads(frames)
    .filter((p) => p.kind === 'deltas')
    .flatMap((p) => p.deltas)
    .filter((d) => d.op === 'state.updated' && d.patch.control)
    .map((d) => d.patch.control)
}

const settle = (ms = 0) => vi.advanceTimersByTimeAsync(ms)

beforeEach(() => {
  wsMode = 'open'
  policy = null
  contextTokens = null
  abortCalls.length = 0
  // wsInstances 不清空：service 模块单例的 liveWs 跨用例存活，得留着句柄才能驱动/重连它。
  vi.stubGlobal('WebSocket', FakeWs)
  vi.stubGlobal('fetch', fetchMock)
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Batch 3 composer lightup (service-level)', () => {
  it('busy frame flips control to running/stoppable; idle flips it back', async () => {
    const service = createOcrcZcodeAgentService()
    const frames: any[] = []
    service.onDynamicConversationFrame({})((f: any) => frames.push(f))
    await service.subscribeConversationV4({ sessionId: 's1', workspacePath: '/ws1' })
    await settle()

    currentWs()!.onmessage?.({ data: JSON.stringify({ type: 'session.status', sessionId: 's1', busy: true }) })
    await settle()
    const running = sessionControlSchema.parse(controlDeltas(frames).at(-1))
    expect(running.phase).toBe('running')
    expect(running.canStop).toBe(true)
    expect(running.stopState).toBe('stoppable')
    expect(running.activeWorks).toHaveLength(1)

    currentWs()!.onmessage?.({ data: JSON.stringify({ type: 'session.status', sessionId: 's1', busy: false }) })
    await settle()
    const idle = sessionControlSchema.parse(controlDeltas(frames).at(-1))
    expect(idle.phase).toBe('completedSuccess')
    expect(idle.canStop).toBe(false)
    expect(idle.stopState).toBe('idle')
  })

  it('stop command hits POST /api/abort and acks accepted', async () => {
    const service = createOcrcZcodeAgentService()
    await service.subscribeConversationV4({ sessionId: 's1', workspacePath: '/ws1' })
    await settle()
    const ack = await service.sendConversationCommandV4({
      envelope: { commandId: 'cmd-1', type: 'stop', sessionId: 's1', payload: {} },
    })
    expect(ack.status).toBe('accepted')
    expect(abortCalls).toHaveLength(1)
    // 无 sessionId 的 stop 如实拒绝，不发引擎请求。
    const rejected = await service.sendConversationCommandV4({
      envelope: { commandId: 'cmd-2', type: 'stop', sessionId: null, payload: {} },
    })
    expect(rejected.status).toBe('failed')
    expect(abortCalls).toHaveLength(1)
  })

  it('snapshot is busy-aware and carries mode echo + contextWindow', async () => {
    const service = createOcrcZcodeAgentService()
    const frames: any[] = []
    service.onDynamicConversationFrame({})((f: any) => frames.push(f))
    policy = 'edit'
    contextTokens = { used: 4321, max: 128000 }
    // service 模块单例：前用例遗留的连接还开着——先重连拿一条可驱动 onmessage 的新 ws。
    currentWs()?.close()
    await settle(HOST_RECONNECT_MS + 100)
    const ws = currentWs()!
    await service.subscribeConversationV4({ sessionId: 's1', workspacePath: '/ws1' })
    await settle()
    const snapshot = wirePayloads(frames).find((p) => p.kind === 'snapshot')!.snapshot
    expect(snapshot.config.mode).toBe('edit')
    expect(snapshot.usage.contextWindow).toEqual({ usedTokens: 4321, maxTokens: 128000, autoCompactThresholdTokens: null })
    expect(snapshot.control.phase).toBe('completedSuccess')

    // busy 中再开一条订阅：快照 control 直接落在 running 基线（busy 感知）。
    ws.onmessage?.({ data: JSON.stringify({ type: 'session.status', sessionId: 's1', busy: true }) })
    await settle()
    await service.subscribeConversationV4({ sessionId: 's1', workspacePath: '/ws1' })
    await settle()
    const lastSnap = wirePayloads(frames).filter((p) => p.kind === 'snapshot').at(-1)!.snapshot
    expect(lastSnap.control.phase).toBe('running')
    expect(lastSnap.control.canStop).toBe(true)
  })

  it('unknown mode/context degrade honestly (mode=build, contextWindow=null)', async () => {
    const service = createOcrcZcodeAgentService()
    const frames: any[] = []
    service.onDynamicConversationFrame({})((f: any) => frames.push(f))
    await service.subscribeConversationV4({ sessionId: 's1', workspacePath: '/ws1' })
    await settle()
    const snapshot = wirePayloads(frames).find((p) => p.kind === 'snapshot')!.snapshot
    expect(snapshot.config.mode).toBe('build')
    expect(snapshot.usage.contextWindow).toBeNull()
  })
})
