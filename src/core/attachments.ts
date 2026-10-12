// src/core/attachments.ts — B8 附件上行（批次 5，2026-10-12）
//
// 送达方式（spike 结论）：**落盘 + 路径注入**，与 TG 收件同款
// （telegram/index.ts 的 M8 附件通用管道）——引擎无关、已验证，模型用文件工具读取。
// 不选原生 FilePart：`url` 的语义（data:/file:）需引擎侧确认，且大文件走
// prompt 内联会污染上下文。
//
// 边界（best-of B8 裁决）：
//   · 禁可执行/脚本类（exe/msi/dll/sh/bat/ps1/jar…）——面板不把可执行文件送上行；
//   · 20MB 上限（与 TG 收件、vendor 上传事务同一档）；
//   · staging 隔离：落 `<ocrcHome>/attachments/<sessionId>/`，会话删除时整目录清理。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ocrcHome } from '../utils/paths.js'

export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024

/** 可执行/脚本类扩展名——一律拒收（上行方向）。 */
export const BLOCKED_ATTACHMENT_EXT = new Set([
  'exe', 'msi', 'dll', 'so', 'dylib', 'bin', 'com', 'scr', 'cpl',
  'sh', 'bash', 'zsh', 'fish', 'bat', 'cmd', 'ps1', 'psm1', 'vbs', 'vbe', 'wsf', 'wsh',
  'jar', 'apk', 'app', 'dmg', 'pkg', 'deb', 'rpm', 'hta', 'msc', 'lnk', 'reg',
])

export function attachmentExt(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i + 1).toLowerCase() : ''
}

export function isBlockedAttachment(name: string): boolean {
  return BLOCKED_ATTACHMENT_EXT.has(attachmentExt(name))
}

/** 落盘用的安全文件名（去路径分隔符 + 控制字符）。 */
export function safeAttachmentName(name: string, fallback = 'attachment'): string {
  const base = (name.split(/[/\\]/).pop() ?? name).replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim()
  return base || fallback
}

/** 展示用的类型词（与 TG 收件的 note 措辞同族）。 */
export function attachmentKind(name: string, mimeType?: string): string {
  const m = (mimeType ?? '').toLowerCase()
  if (m.startsWith('image/')) return 'photo'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  const ext = attachmentExt(name)
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'].includes(ext)) return 'photo'
  if (['mp4', 'mov', 'webm', 'm4v', 'mkv'].includes(ext)) return 'video'
  if (['mp3', 'm4a', 'ogg', 'opus', 'wav', 'flac', 'aac'].includes(ext)) return 'audio'
  return 'document'
}

/** 会话的 staging 目录（隔离：一个会话一个子目录）。 */
export function attachmentDirFor(sessionId: string, home = ocrcHome()): string {
  return join(home, 'attachments', safeAttachmentName(sessionId, 'session'))
}

/** 写入 staging，返回落盘路径。 */
export function saveAttachment(sessionId: string, name: string, buf: Buffer, home = ocrcHome()): string {
  const dir = attachmentDirFor(sessionId, home)
  mkdirSync(dir, { recursive: true })
  const savedPath = join(dir, `${Date.now()}-${safeAttachmentName(name)}`)
  writeFileSync(savedPath, buf)
  return savedPath
}

/** 注入 prompt 的路径说明（与 TG 收件同款措辞——模型靠它去读文件）。 */
export function attachmentNote(kind: string, name: string, bytes: number, savedPath: string): string {
  return `[附件 ${kind}: ${name}（${(bytes / 1024).toFixed(0)}KB），已保存到 ${savedPath}——需要时用文件工具读取]`
}

/** 会话结束清理：删掉该会话的 staging 目录（幂等，尽力而为）。 */
export function cleanupSessionAttachments(sessionId: string, home = ocrcHome()): void {
  try {
    rmSync(attachmentDirFor(sessionId, home), { recursive: true, force: true })
  } catch { /* best-effort：清理失败不影响会话删除 */ }
}
