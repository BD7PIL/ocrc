// P5 host 掉线可见化 — 服务级集成测试：
// 用假 WebSocket / 假 fetch / 假计时器驱动 zcodeAgentService 的真实代码路径：
//   掉线 → control patch（lastError source=network + apiRetry N/M）→ 封顶 down
//   （apiRetry 清空 + lifecycle unavailable）→ 探测闸门如实 reject → ws 回来
//   → 清口 patch + lifecycle available；半开心跳（REST 裁决后才撕连接）。
// control patch 的形状用 vendor 的 sessionControlSchema 逐帧验证（整键替换语义）。
// 注意：service 模块与 hostConn 都是进程内单例，本文件各用例按声明顺序共享状态
// （前一个用例恢复 up 后，后一个才建立前置）；wire 监听器收到的是信封，payload 在
// `frame.payload`。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { sessionControlSchema } from '@zcode/shared/zcode-protocol-v4/snapshot.js'
import { createOcrcZcodeAgentService } from '../zcodeAgentService.js'
import { HOST_MAX_RECONNECT_ATTEMPTS, HOST_RECONNECT_MS } from '../hostConnection.js'

type WsMode = 'open' | 'refused'
let wsMode: WsMode = 'open'
let probeFail = false
let historyFail = false

const wsInstances: FakeWs[] = []
function currentWs(): FakeWs | undefined {
  return wsInstances[wsInstances.length - 1]
}

class FakeWs {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  readyState = FakeWs.CONNECTING
  url: string
  sent: string[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  constructor(url: string) {
    this.url = url
    wsInstances.push(this)
    if (wsMode === 'open') {
      queueMicrotask(() => { this.readyState = FakeWs.OPEN; this.onopen?.() })
    } else {
      queueMicrotask(() => { this.readyState = FakeWs.CLOSED; this.onerror?.(); this.onclose?.() })
    }
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
  if (u.includes('/api/version')) {
    if (probeFail) throw new TypeError('fetch failed')
    return jsonResponse({ version: 'test' })
  }
  if (historyFail && /\/api\/session\/[^/?]+\?limit=200/.test(u)) throw new TypeError('fetch failed')
  if (u.includes('/api/sessions')) return jsonResponse([])
  if (u.includes('/api/models')) return jsonResponse([])
  if (u.includes('/api/overrides')) return jsonResponse({ model: null })
  return jsonResponse({ runs: [], joins: [] })
})

function wirePayloads(frames: any[]): any[] {
  return frames.map((f) => f.frame?.payload).filter(Boolean)
}

function lastControlDelta(frames: any[]): any {
  const deltas = wirePayloads(frames).filter((p) => p.kind === 'deltas')
  expect(deltas.length).toBeGreaterThan(0)
  const last = deltas[deltas.length - 1]
  expect(last.deltas[0].op).toBe('state.updated')
  return last.deltas[0].patch.control
}

const settle = (ms = 0) => vi.advanceTimersByTimeAsync(ms)

beforeEach(() => {
  wsMode = 'open'
  probeFail = false
  historyFail = false
  vi.stubGlobal('WebSocket', FakeWs)
  vi.stubGlobal('fetch', fetchMock)
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('P5 host offline visibility (service-level)', () => {
  it('happy path: snapshot carries clean control; offline ladder emits network patches and caps at down', async () => {
    const service = createOcrcZcodeAgentService()
    const frames: any[] = []
    service.onDynamicConversationFrame({})((f: any) => frames.push(f))
    const lifecycle: any[] = []
    service.onAgentRuntimeLifecycle((e: any) => lifecycle.push(e))

    const { ack } = await service.subscribeConversationV4({ sessionId: 's1', workspacePath: '/ws1' })
    expect(ack.subscriptionId).toBeTruthy()
    await settle()
    // 初始快照：control 通过 vendor schema 验证，lastError/apiRetry 干净。
    const snapshotPayload = wirePayloads(frames).find((p) => p.kind === 'snapshot')
    expect(snapshotPayload).toBeTruthy()
    const cleanControl = sessionControlSchema.parse(snapshotPayload.snapshot.control)
    expect(cleanControl.lastError).toBeNull()
    expect(cleanControl.apiRetry).toBeNull()

    // 掉线（连接被撕）→ degraded patch：lastError=network + apiRetry 1/M。
    wsMode = 'refused'
    currentWs()!.close()
    await settle()
    const degraded = sessionControlSchema.parse(lastControlDelta(frames))
    expect(degraded.lastError?.source).toBe('network')
    expect(degraded.lastError?.code).toBe('fault.host.unreachable')
    expect(degraded.apiRetry?.attempt).toBe(1)
    expect(degraded.apiRetry?.maxAttempts).toBe(HOST_MAX_RECONNECT_ATTEMPTS)

    // 重连梯子跑到封顶 → down：apiRetry 清空（横幅接管）、unavailable 生命周期下发。
    await settle(HOST_RECONNECT_MS * (HOST_MAX_RECONNECT_ATTEMPTS + 2))
    const down = sessionControlSchema.parse(lastControlDelta(frames))
    expect(down.lastError?.source).toBe('network')
    expect(down.apiRetry).toBeNull()
    expect(lifecycle.some((e) => e.state === 'unavailable')).toBe(true)

    // host 回来：ws 重连成功 → 清口 patch + available。
    wsMode = 'open'
    await settle(HOST_RECONNECT_MS + 100)
    const recovered = sessionControlSchema.parse(lastControlDelta(frames))
    expect(recovered.lastError).toBeNull()
    expect(recovered.apiRetry).toBeNull()
    expect(lifecycle.some((e) => e.state === 'available')).toBe(true)
  })

  it('probe gate: subscribe/resync while the host is unreachable reject (recycle-classified) instead of acking', async () => {
    const service = createOcrcZcodeAgentService()
    // 先建立一条活订阅（ws open + phase up → 探测快路径放行）。
    const { ack } = await service.subscribeConversationV4({ sessionId: 's1', workspacePath: '/ws1' })
    await settle()

    // 撕掉 ws（ws 不再 open）+ REST 探测确认不可达 → 探测闸门如实 reject。
    wsMode = 'refused'
    probeFail = true
    currentWs()!.close()
    await settle()
    await expect(
      service.subscribeConversationV4({ sessionId: 's9', workspacePath: '/ws1' }),
    ).rejects.toThrow(/ZCode Agent runtime is not running/)
    await expect(
      service.resyncConversationV4({ subscriptionId: ack.subscriptionId, base: { logEpoch: 'ocrc-1', seq: 0 } }),
    ).rejects.toThrow(/host unreachable/)

    // 恢复：ws 重连成功、探测放行。
    probeFail = false
    wsMode = 'open'
    await settle(HOST_RECONNECT_MS + 100)
    await expect(
      service.subscribeConversationV4({ sessionId: 's2', workspacePath: '/ws1' }),
    ).resolves.toBeTruthy()
  })

  it('snapshot build failure never ships a hollow snapshot (bounded retry instead)', async () => {
    const service = createOcrcZcodeAgentService()
    const frames: any[] = []
    service.onDynamicConversationFrame({})((f: any) => frames.push(f))
    historyFail = true
    await service.subscribeConversationV4({ sessionId: 's1', workspacePath: '/ws1' })
    await settle(100)
    // 历史取不到 → 无 snapshot 帧（宁可等补投，不投空会话假象）。
    expect(wirePayloads(frames).find((p) => p.kind === 'snapshot')).toBeUndefined()
    // host 恢复 → 有界补投链把快照送出来。
    historyFail = false
    await settle(2000)
    expect(wirePayloads(frames).find((p) => p.kind === 'snapshot')).toBeTruthy()
  })

  it('heartbeat only tears down the socket when REST confirms the host is gone', async () => {
    // 上一用例遗留的连接，其心跳 interval 挂在前一时钟上——先重连一条，让心跳在
    // 当前假时钟下重启（service 模块单例，直接驱动其 ws 生命周期即可）。
    currentWs()?.close()
    await settle(HOST_RECONNECT_MS + 100)
    const ws = currentWs()!
    expect(ws.readyState).toBe(FakeWs.OPEN)

    // 一拍心跳 → app 级 ping 出站；pong 回声把在途标记清掉 → 后续拍继续 ping，连接存活。
    await settle(15_000)
    expect(ws.sent.some((d) => d.includes('"ping"'))).toBe(true)
    ws.onmessage?.({ data: JSON.stringify({ type: 'pong' }) })
    await settle(30_000)
    expect(currentWs()).toBe(ws)

    // ping 无回声 + REST 确认不可达 → 撕连接走重连梯子（半开探测不误杀活连接）。
    probeFail = true
    await settle(15_000)
    await settle(15_000)
    await settle(5000)
    expect(currentWs()).not.toBe(ws)
  })
})
