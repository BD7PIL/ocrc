import { describe, it, expect, afterAll, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  OffsetJournal, extractImageUrls, normalizeMediaKind, findUndoTarget,
  classifyOutboundUrl, classifyOutboundMime, extractMediaUrls, OUTBOUND_MEDIA_MAX_BYTES, deliverOutboundMedia,
} from '../../src/transport/telegram/m8-journal.js'

const dir = mkdtempSync(join(tmpdir(), 'm8-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('OffsetJournal', () => {
  it('records processed ids and flushes to disk (2s debounce)', () => {
    vi.useFakeTimers()
    const path = join(dir, 'j1.json')
    const j = new OffsetJournal(path)
    j.markProcessed(7)
    j.markProcessed(9)
    expect(j.isReplay(9)).toBe(false) // not flushed yet — lastId still 0
    vi.advanceTimersByTime(2100) // debounce flush → journal through 9
    expect(j.isReplay(9)).toBe(true) // offsets are cumulative: ≤9 all acknowledged
    expect(j.isReplay(10)).toBe(false)
    expect(readFileSync(path, 'utf-8')).toContain('9')
    vi.useRealTimers()
  })

  it('reloads lastId from disk — post-crash replays are dropped', () => {
    const path = join(dir, 'j2.json')
    const j1 = new OffsetJournal(path)
    j1.markProcessed(42)
    j1.flush()
    expect(readFileSync(path, 'utf-8')).toContain('42')
    const j2 = new OffsetJournal(path)
    expect(j2.processedThrough).toBe(42)
    expect(j2.isReplay(42)).toBe(true)
    expect(j2.isReplay(43)).toBe(false)
  })
})

describe('extractImageUrls', () => {
  it('extracts markdown images and bare image urls, deduped, capped', () => {
    const text = [
      '![shot](https://x.example/a.png)',
      'bare https://y.example/b.jpg tail',
      'dup ![shot](https://x.example/a.png)',
      'https://z.example/plain.txt',
    ].join('\n')
    expect(extractImageUrls(text)).toEqual(['https://x.example/a.png', 'https://y.example/b.jpg'])
  })
  it('caps at 3', () => {
    const text = ['1', '2', '3', '4'].map((n) => `![i](https://e/${n}.png)`).join('\n')
    expect(extractImageUrls(text)).toHaveLength(3)
  })
})

describe('normalizeMediaKind', () => {
  it('maps telegram media types', () => {
    expect(normalizeMediaKind('photo')).toBe('photo')
    expect(normalizeMediaKind('video_note')).toBe('video')
    expect(normalizeMediaKind('voice')).toBe('voice')
    expect(normalizeMediaKind('text')).toBeNull()
  })
})

describe('findUndoTarget', () => {
  it('returns the second-to-last user messageId', () => {
    const cards = [
      { kind: 'user', messageId: 'm1' },
      { kind: 'assistant', messageId: 'm2' },
      { kind: 'user', messageId: 'm3' },
    ]
    expect(findUndoTarget(cards)).toBe('m1')
  })
  it('undefined with fewer than two user messages', () => {
    expect(findUndoTarget([{ kind: 'user', messageId: 'm1' }])).toBeUndefined()
  })
})

// ── B5 媒体输出（批次 4）：分类白名单 + 抽取 + 上限 ─────────────────────────
describe('B5 媒体输出分类与抽取', () => {
  it('扩展名分类：photo / video / audio / document', () => {
    expect(classifyOutboundUrl('https://x/a.png')).toBe('photo')
    expect(classifyOutboundUrl('https://x/a.JPEG?w=1')).toBe('photo')
    expect(classifyOutboundUrl('https://x/clip.mp4')).toBe('video')
    expect(classifyOutboundUrl('https://x/voice.m4a')).toBe('audio')
    expect(classifyOutboundUrl('https://x/report.pdf')).toBe('document')
    expect(classifyOutboundUrl('https://x/dump.zip')).toBe('document')
  })

  it('白名单外（含可执行类）一律 null —— 不发', () => {
    for (const u of ['https://x/setup.exe', 'https://x/lib.dll', 'https://x/run.sh', 'https://x/x.bat', 'https://x/a.ps1', 'https://x/app.jar', 'https://x/noext', 'https://x/page.php']) {
      expect(classifyOutboundUrl(u)).toBeNull()
    }
  })

  it('响应 mime 优先（无扩展名/扩展名撒谎时按 mime 判）', () => {
    expect(classifyOutboundMime('application/pdf')).toBe('document')
    expect(classifyOutboundMime('image/png')).toBe('photo')
    expect(classifyOutboundMime('video/mp4; charset=binary')).toBe('video')
    expect(classifyOutboundMime('audio/mpeg')).toBe('audio')
    expect(classifyOutboundMime('application/octet-stream')).toBeNull()
    expect(classifyOutboundMime(null)).toBeNull()
  })

  it('抽取：markdown 链接 + 裸 URL，分类过滤 + 去重 + 截断', () => {
    const text = [
      '看这个 ![图](https://x/a.png)',
      '还有 https://y/clip.mp4 和 https://z/report.pdf',
      '重复 https://x/a.png',
      '可执行不发 https://w/setup.exe',
    ].join('\n')
    const out = extractMediaUrls(text, 3)
    expect(out).toEqual([
      { url: 'https://x/a.png', kind: 'photo' },
      { url: 'https://y/clip.mp4', kind: 'video' },
      { url: 'https://z/report.pdf', kind: 'document' },
    ])
    expect(extractMediaUrls(text, 2)).toHaveLength(2)
  })

  it('大小上限按 TG Bot API：photo 10MB，其余 50MB', () => {
    expect(OUTBOUND_MEDIA_MAX_BYTES.photo).toBe(10 * 1024 * 1024)
    expect(OUTBOUND_MEDIA_MAX_BYTES.video).toBe(50 * 1024 * 1024)
    expect(OUTBOUND_MEDIA_MAX_BYTES.audio).toBe(50 * 1024 * 1024)
    expect(OUTBOUND_MEDIA_MAX_BYTES.document).toBe(50 * 1024 * 1024)
  })
})

describe('B5 投递循环（注入依赖，隔离栈无 bot 也能测）', () => {
  const mkRes = (bytes: number, mime: string | null, ok = true) => ({
    ok,
    headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? mime : null) },
    arrayBuffer: async () => new ArrayBuffer(bytes),
  })

  it('按类型分发到 send，mime 覆盖扩展名，逐条独立容错', async () => {
    const calls: Array<{ kind: string; filename: string }> = []
    const warned: string[] = []
    const res = await deliverOutboundMedia(
      [
        { url: 'https://x/a.png', kind: 'photo' },
        { url: 'https://x/lying.png', kind: 'photo' }, // mime 说是 video
        { url: 'https://x/boom.pdf', kind: 'document' }, // fetch 抛错
        { url: 'https://x/report.pdf', kind: 'document' },
      ],
      {
        fetchImpl: async (url) => {
          if (url.includes('boom')) throw new Error('network down')
          if (url.includes('lying')) return mkRes(10, 'video/mp4')
          return mkRes(10, url.endsWith('.png') ? 'image/png' : 'application/pdf')
        },
        send: async (kind, f) => { calls.push({ kind, filename: f.filename }) },
        warn: (m) => warned.push(m),
      },
    )
    expect(res).toEqual({ sent: 3, skipped: 1 })
    expect(calls).toEqual([
      { kind: 'photo', filename: 'a.png' },
      { kind: 'video', filename: 'lying.png' },
      { kind: 'document', filename: 'report.pdf' },
    ])
    expect(warned.some((w) => w.includes('boom.pdf'))).toBe(true)
  })

  it('超限跳过并如实记日志（photo 10MB 线）', async () => {
    const warned: string[] = []
    const res = await deliverOutboundMedia([{ url: 'https://x/big.png', kind: 'photo' }], {
      fetchImpl: async () => mkRes(11 * 1024 * 1024, 'image/png'),
      send: async () => { throw new Error('should not send') },
      warn: (m) => warned.push(m),
    })
    expect(res).toEqual({ sent: 0, skipped: 1 })
    expect(warned[0]).toContain('over photo cap')
  })

  it('非 2xx 跳过（不静默当成功）', async () => {
    const res = await deliverOutboundMedia([{ url: 'https://x/a.pdf', kind: 'document' }], {
      fetchImpl: async () => mkRes(10, 'application/pdf', false),
      send: async () => { throw new Error('should not send') },
    })
    expect(res).toEqual({ sent: 0, skipped: 1 })
  })
})
