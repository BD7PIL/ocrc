// m8-journal.ts — M8 channel-reliability pure/mutable pieces:
//   • OffsetJournal — durable record of processed Telegram update_ids; after a
//     crash+restart, replays of already-processed updates are dropped instead
//     of re-handled (grammY's in-memory offset forgets on restart).
//   • extractImageUrls — grinev-style media output: markdown image URLs from
//     a finalized assistant message, capped, deduped.
//   • normalizeMediaKind — generic attachment pipeline classification.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export class OffsetJournal {
  private lastId = 0
  private pending: number | null = null
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly path: string) {
    try { this.lastId = Number(JSON.parse(readFileSync(path, 'utf-8')).lastId) || 0 } catch { /* empty */ }
  }

  get processedThrough(): number {
    return this.lastId
  }

  /** True when this update was already processed (pre-crash replay). */
  isReplay(updateId: number): boolean {
    return updateId <= this.lastId
  }

  /** Record successful processing; debounced flush (2s) keeps the write off
   *  the hot path while a burst streams. */
  markProcessed(updateId: number): void {
    if (updateId <= this.lastId) return
    this.pending = Math.max(this.pending ?? 0, updateId)
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), 2000)
    this.timer.unref?.()
  }

  flush(): void {
    if (this.pending == null) return
    this.lastId = this.pending
    this.pending = null
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, JSON.stringify({ lastId: this.lastId }))
      renameSync(tmp, this.path)
    } catch { /* best-effort journal */ }
  }
}

// ── grinev 媒体输出：assistant 文本中的图片资产 ────────────────────────────
export function extractImageUrls(text: string, cap = 3): string[] {
  if (!text) return []
  const urls: string[] = []
  const md = /\!?!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g
  for (const m of text.matchAll(md)) urls.push(m[1]!)
  // bare image-ish URLs (png/jpg/webp/gif) outside markdown
  const bare = /(?:^|[\s(])(https?:\/\/[^\s)]+\.(?:png|jpe?g|webp|gif))(?=[\s)]|$)/gi
  for (const m of text.matchAll(bare)) {
    if (!urls.includes(m[1]!)) urls.push(m[1]!)
  }
  return [...new Set(urls)].slice(0, cap)
}

/** Generic attachment classification (ZCode attachment pipeline register):
 *  photo → image part; document/video/audio/voice → path note. Voice
 *  transcription is OUT of scope (PRODUCT.md ruling). */
export type MediaKind = 'photo' | 'document' | 'video' | 'audio' | 'voice'
export function normalizeMediaKind(tgType: string): MediaKind | null {
  if (tgType === 'photo') return 'photo'
  if (tgType === 'document') return 'document'
  if (tgType === 'video' || tgType === 'video_note') return 'video'
  if (tgType === 'audio') return 'audio'
  if (tgType === 'voice') return 'voice'
  return null
}

// ── session 深命令：/undo 的回退目标查找 ────────────────────────────────────
/** From a card history, find the previous user message id before the LAST
 *  user message (the /undo revert target). Returns undefined when there's
 *  nothing to undo. Cards carry messageId on user/assistant kinds. */
export function findUndoTarget(cards: Array<{ kind: string; messageId?: string }>): string | undefined {
  const userMsgIds: string[] = []
  for (const c of cards) {
    if (c.kind === 'user' && c.messageId) userMsgIds.push(c.messageId)
  }
  if (userMsgIds.length < 2) return undefined
  return userMsgIds[userMsgIds.length - 2]!
}

// ── journal file helper (module-level, mirrors OffsetJournal) ──────────────
export function journalExists(path: string): boolean {
  return existsSync(path)
}
