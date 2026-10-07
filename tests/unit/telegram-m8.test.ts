import { describe, it, expect, afterAll, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OffsetJournal, extractImageUrls, normalizeMediaKind, findUndoTarget } from '../../src/transport/telegram/m8-journal.js'

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
