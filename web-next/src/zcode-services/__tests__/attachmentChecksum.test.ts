// 附件校验和回退契约测试（N8-4）。crypto.subtle 只在安全上下文存在；局域网
// http 源上没有它，vendor 的 checksum() 原来会直接抛 checksumUnavailable →
// 拖放/粘贴的附件整条上传链断。这里钉住：纯 JS 实现与 WebCrypto/node crypto
// 逐字节一致，且接线在无 subtle 时真的走回退。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { sha256Hex } from '@/v4/sha256Pure.js'

const nodeHex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

afterEach(() => vi.unstubAllGlobals())

describe('sha256Pure（非安全上下文回退）', () => {
  const cases: Array<[string, Uint8Array]> = [
    ['empty', new Uint8Array(0)],
    ['1B', new Uint8Array([0x61])],
    // padding 边界：55 = 单 block 内可塞长度；56/63/64 = 需要第二个 block
    ['55B', new Uint8Array(55).fill(0x61)],
    ['56B', new Uint8Array(56).fill(0x61)],
    ['63B', new Uint8Array(63).fill(0x61)],
    ['64B', new Uint8Array(64).fill(0x61)],
    ['65B', new Uint8Array(65).fill(0x61)],
    ['1KB 多 block', new Uint8Array(1024).map((_, i) => i & 0xff)],
    ['UTF-8 中文', new TextEncoder().encode('附件校验和：这是一段中文，含 emoji 🚀')],
    ['高字节', new Uint8Array([0xff, 0x00, 0x80, 0x7f, 0xfe])],
  ]
  for (const [name, bytes] of cases) {
    it(`与 node crypto 一致：${name}`, () => {
      expect(sha256Hex(bytes)).toBe(nodeHex(bytes))
    })
  }
})

describe('uploadAttachmentTransaction 在无 subtle 时走回退', () => {
  // 该用例在并行全量跑时是 ~3.9s（纯 JS sha256 对多档输入做对照），默认 5s 上限
  // 在宿主负载高时会被顶穿；超时后挂起的异步还会把下一条用例的 digest spy 计数
  // 顶成 2（2026-10-13 实测两连失败、单跑全绿）。显式放宽到 20s 去抖。
  it('beginParams.checksum 是 sha256:<64 hex> 且与 node 结果一致', async () => {
    // 去掉 subtle（模拟 http 源），保留 randomUUID/getRandomValues（它们在
    // 非安全上下文仍存在）。
    vi.stubGlobal('crypto', {
      randomUUID: () => '00000000-0000-4000-8000-000000000000',
      getRandomValues: (arr: Uint32Array) => arr,
    })
    const { uploadAttachmentTransaction } = await import('@/v4/attachmentUploadTransaction.js')
    const data = new TextEncoder().encode('hello attachment')
    let beginParams: any
    const agent = {
      attachmentBeginV4: async (params: any) => {
        beginParams = params
        return { state: 'committed', ref: 'ocrc-att://probe' }
      },
    } as any
    const result = await uploadAttachmentTransaction(agent, { workspacePath: '/w' } as any, {
      sessionId: 'ses_a',
      fileName: 'note.txt',
      mime: 'text/plain',
      dataBase64: Buffer.from(data).toString('base64'),
    } as any)
    expect(result).toEqual({ ref: 'ocrc-att://probe' })
    expect(beginParams.checksum).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(beginParams.checksum).toBe(`sha256:${nodeHex(data)}`)
  }, 20000)

  it('有 subtle 时走原生实现（用可用的假 subtle 验证分支选择，不依赖 jsdom 的 WebCrypto）', async () => {
    const expected = new Uint8Array(32).fill(0xab)
    const digestSpy = vi.fn(async () => expected.buffer)
    vi.stubGlobal('crypto', {
      subtle: { digest: digestSpy },
      randomUUID: () => '00000000-0000-4000-8000-000000000000',
      getRandomValues: (arr: Uint32Array) => arr,
    })
    const { uploadAttachmentTransaction } = await import('@/v4/attachmentUploadTransaction.js')
    let beginParams: any
    const agent = {
      attachmentBeginV4: async (params: any) => { beginParams = params; return { state: 'committed', ref: 'r' } },
    } as any
    await uploadAttachmentTransaction(agent, { workspacePath: '/w' } as any, {
      sessionId: 'ses_a', fileName: 'n.txt', mime: 'text/plain',
      dataBase64: Buffer.from('native path').toString('base64'),
    } as any)
    expect(digestSpy).toHaveBeenCalledTimes(1)
    expect(beginParams.checksum).toBe(`sha256:${'ab'.repeat(32)}`)
  })
})
