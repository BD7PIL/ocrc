// src/lib/insecure-context.test.ts — 垫片行为：缺 API 补回退、有 API 不动。
// jsdom/node 20 的 navigator.clipboard / crypto.randomUUID / crypto.subtle
// 是否存在取决于运行时，因此每条用例先显式把目标 API 抹掉（或保留原值），
// 装 shim 后断言两种世界的边界。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { installInsecureContextShims } from './insecure-context.js'

function hideClipboard() {
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true, writable: true })
}
function hideRandomUUID() {
  Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true, writable: true })
}
function hideSubtle() {
  Object.defineProperty(globalThis.crypto, 'subtle', { value: undefined, configurable: true, writable: true })
}

let originalClipboard: unknown
let originalRandomUUID: unknown
let originalSubtle: unknown

beforeEach(() => {
  originalClipboard = Object.getOwnPropertyDescriptor(Navigator.prototype, 'clipboard')?.value ?? (navigator as { clipboard?: unknown }).clipboard
  originalRandomUUID = globalThis.crypto.randomUUID
  originalSubtle = globalThis.crypto.subtle
})

afterEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true, writable: true })
  Object.defineProperty(globalThis.crypto, 'randomUUID', { value: originalRandomUUID, configurable: true, writable: true })
  Object.defineProperty(globalThis.crypto, 'subtle', { value: originalSubtle, configurable: true, writable: true })
  vi.restoreAllMocks()
})

describe('installInsecureContextShims — clipboard', () => {
  // jsdom 没有 execCommand，显式桩一个（afterEach 由 defineProperty 恢复序处理）。
  let execCommand: ReturnType<typeof vi.fn>
  beforeEach(() => {
    execCommand = vi.fn().mockReturnValue(true)
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true, writable: true })
  })

  it('writeText 缺失时补 execCommand 回退，成功时 resolve 并清掉 textarea', async () => {
    hideClipboard()
    installInsecureContextShims()
    const before = document.querySelectorAll('textarea').length
    await expect(navigator.clipboard!.writeText('hello')).resolves.toBeUndefined()
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(document.querySelectorAll('textarea').length).toBe(before)
  })

  it('execCommand 拒绝时 reject（让调用方的 catch 如常工作）', async () => {
    hideClipboard()
    execCommand.mockReturnValue(false)
    installInsecureContextShims()
    await expect(navigator.clipboard!.writeText('x')).rejects.toThrow()
  })

  it('原生 clipboard 已有 writeText 时不覆盖', async () => {
    // jsdom 通常没有 clipboard；有就保留原引用，没有就先装一个标记实现。
    const marker = { writeText: vi.fn().mockResolvedValue(undefined) }
    Object.defineProperty(navigator, 'clipboard', { value: marker, configurable: true, writable: true })
    installInsecureContextShims()
    expect(navigator.clipboard).toBe(marker)
  })
})

describe('installInsecureContextShims — randomUUID', () => {
  it('缺失时补 v4 实现（version/variant 位正确、格式合法）', () => {
    hideRandomUUID()
    installInsecureContextShims()
    const id = crypto.randomUUID()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(crypto.randomUUID()).not.toBe(id)
  })

  it('原生 randomUUID 存在时不覆盖', () => {
    if (typeof originalRandomUUID !== 'function') return // 运行时本就没有，跳过
    installInsecureContextShims()
    expect(crypto.randomUUID).toBe(originalRandomUUID)
  })
})

describe('installInsecureContextShims — subtle.digest', () => {
  it('subtle 缺失时补 SHA-256 回退（与 WebCrypto 已知向量一致）', async () => {
    hideSubtle()
    installInsecureContextShims()
    const out = await crypto.subtle!.digest('SHA-256', new TextEncoder().encode('abc').buffer as ArrayBuffer)
    const hex = [...new Uint8Array(out)].map((b) => b.toString(16).padStart(2, '0')).join('')
    // "abc" 的 SHA-256 标准测试向量
    expect(hex).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('回退只实现 SHA-256，其他算法显式拒绝（与原生语义一致）', async () => {
    hideSubtle()
    installInsecureContextShims()
    await expect(crypto.subtle!.digest('SHA-1', new TextEncoder().encode('abc').buffer as ArrayBuffer)).rejects.toThrow()
  })

  it('原生 subtle 存在时不覆盖', () => {
    if (!originalSubtle) return
    installInsecureContextShims()
    expect(globalThis.crypto.subtle).toBe(originalSubtle)
  })
})
