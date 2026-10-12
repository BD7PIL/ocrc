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

// ── B5 媒体输出（批次 4）：图片相册 → document / video / audio ──────────────
// 白名单制：只发已知安全的扩展名；可执行/脚本类（exe/msi/dll/sh/bat/ps1/jar…）
// 一律不发（不让面板把可执行文件推到聊天里）。大小上限按 TG Bot API：
// photo 10MB，其余 50MB。
export type OutboundMediaKind = 'photo' | 'video' | 'audio' | 'document'

const PHOTO_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'])
const VIDEO_EXT = new Set(['mp4', 'mov', 'webm', 'm4v', 'mkv'])
const AUDIO_EXT = new Set(['mp3', 'm4a', 'ogg', 'oga', 'opus', 'wav', 'flac', 'aac'])
const DOC_EXT = new Set([
  'pdf', 'md', 'markdown', 'txt', 'log', 'json', 'jsonc', 'csv', 'tsv', 'yaml', 'yml',
  'toml', 'ini', 'xml', 'html', 'htm', 'sql', 'diff', 'patch', 'zip', 'tar', 'gz', 'tgz',
  'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp',
])

export const OUTBOUND_MEDIA_MAX_BYTES: Record<OutboundMediaKind, number> = {
  photo: 10 * 1024 * 1024, // TG photo cap
  video: 50 * 1024 * 1024,
  audio: 50 * 1024 * 1024,
  document: 50 * 1024 * 1024,
}

/** 从 URL 路径的扩展名分类；不在白名单（含可执行类）→ null（不发）。 */
export function classifyOutboundUrl(url: string): OutboundMediaKind | null {
  let path = url
  try {
    path = new URL(url).pathname
  } catch {
    path = url.split('?')[0] ?? url
  }
  const m = /\.([A-Za-z0-9]+)$/.exec(path.split('?')[0] ?? path)
  const ext = m?.[1]?.toLowerCase()
  if (!ext) return null
  if (PHOTO_EXT.has(ext)) return 'photo'
  if (VIDEO_EXT.has(ext)) return 'video'
  if (AUDIO_EXT.has(ext)) return 'audio'
  if (DOC_EXT.has(ext)) return 'document'
  return null
}

/** 响应 Content-Type 分类（比扩展名更可信时用它）。未知/缺失 → null。 */
export function classifyOutboundMime(mime: string | null | undefined): OutboundMediaKind | null {
  if (!mime) return null
  const m = mime.split(';')[0]!.trim().toLowerCase()
  if (m === 'application/pdf') return 'document'
  if (m.startsWith('image/')) return 'photo'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  if (m.startsWith('text/') || m === 'application/json' || m === 'application/zip' || m === 'application/x-tar') return 'document'
  return null
}

/** assistant 文本里的媒体资产（markdown 链接 + 裸 URL），分类后去重截断。
 *  与 extractImageUrls 的分工：后者是图片相册的兼容面，这里是 B5 的四类面。 */
export function extractMediaUrls(text: string, cap = 3): Array<{ url: string; kind: OutboundMediaKind }> {
  if (!text) return []
  const urls: string[] = []
  const md = /\!?!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g
  for (const m of text.matchAll(md)) urls.push(m[1]!)
  // 裸 URL：http(s)://… 后跟已知媒体扩展名
  const bare = /(?:^|[\s(])(https?:\/\/[^\s)]+\.(?:[A-Za-z0-9]{2,5}))(?=[\s)]|$)/g
  for (const m of text.matchAll(bare)) {
    if (!urls.includes(m[1]!)) urls.push(m[1]!)
  }
  const out: Array<{ url: string; kind: OutboundMediaKind }> = []
  for (const u of [...new Set(urls)]) {
    const kind = classifyOutboundUrl(u)
    if (kind) out.push({ url: u, kind })
  }
  return out.slice(0, cap)
}

/** 投递依赖（注入以便单测：隔离栈跑的是无 token bot，不能拿生产 bot 做测试）。 */
export interface OutboundMediaDeps {
  fetchImpl: (url: string, init?: { signal?: AbortSignal }) => Promise<{
    ok: boolean
    headers: { get(name: string): string | null }
    arrayBuffer(): Promise<ArrayBuffer>
  }>
  send: (kind: OutboundMediaKind, file: { buf: Buffer; filename: string }) => Promise<unknown>
  warn?: (message: string) => void
  timeoutMs?: number
}

/** 逐条取回并发。逐条独立容错（一条失败不拖累其余）；超限/白名单外如实跳过并记日志。 */
export async function deliverOutboundMedia(
  media: Array<{ url: string; kind: OutboundMediaKind }>,
  deps: OutboundMediaDeps,
): Promise<{ sent: number; skipped: number }> {
  let sent = 0
  let skipped = 0
  for (const item of media) {
    try {
      const res = await deps.fetchImpl(item.url, { signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000) })
      if (!res.ok) {
        skipped++
        continue
      }
      const buf = Buffer.from(await res.arrayBuffer())
      // mime 优先、扩展名兜底；两者都不在白名单 → 不发。
      const kind = classifyOutboundMime(res.headers.get('content-type')) ?? item.kind
      if (buf.length > OUTBOUND_MEDIA_MAX_BYTES[kind]) {
        deps.warn?.(`media output skipped (over ${kind} cap): ${item.url}`)
        skipped++
        continue
      }
      const filename = decodeURIComponent(item.url.split('/').pop() ?? `asset.${kind}`)
      await deps.send(kind, { buf, filename })
      sent++
    } catch (err) {
      deps.warn?.(`media output skipped for ${item.url}: ${(err as Error).message}`)
      skipped++
    }
  }
  return { sent, skipped }
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
