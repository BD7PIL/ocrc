/**
 * N6 文件面：/z/ 的文件树、预览、@ 提及都要这些能力，而 ocrc 此前只有
 * 「列目录 + 读整文件」（且读文件走引擎的 /file/content，二进制拿不到）。
 * 这里直接落在 host 的文件系统上（host 与工作区同机），并用路径 containment
 * 校验把越界读写挡在外面。
 */
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'coverage',
  '.svelte-kit', '.next', '.nuxt', '.cache', '.turbo', 'vendor', '__pycache__',
])

/** 二进制判定：前 8KB 里出现 NUL 即当二进制（与 git 的启发式同源）。 */
const BINARY_PROBE_BYTES = 8 * 1024

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
}

export function mimeForPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

/** Resolve `path` and refuse anything that escapes `root` (symlink-aware). */
export async function safeResolve(root: string, path: string): Promise<string> {
  const abs = isAbsolute(path) ? path : resolve(root, path)
  const rootReal = await realpath(root).catch(() => resolve(root))
  const absReal = await realpath(abs).catch(() => abs)
  const rel = relative(rootReal, absReal)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`路径越界：${path}`)
  }
  return abs
}

export interface FileStatResult {
  path: string
  exists: boolean
  type: 'file' | 'directory'
  size?: number
  mtimeMs?: number
}

export async function statPaths(root: string, paths: readonly string[]): Promise<FileStatResult[]> {
  const out: FileStatResult[] = []
  for (const p of paths.slice(0, 500)) {
    try {
      const abs = await safeResolve(root, p)
      const st = await lstat(abs)
      out.push({
        path: p,
        exists: true,
        type: st.isDirectory() ? 'directory' : 'file',
        size: st.isFile() ? st.size : undefined,
        mtimeMs: st.mtimeMs,
      })
    } catch {
      // Not found and out-of-root look the same to the client on purpose: the UI
      // only needs "there is nothing to open here", not why.
      out.push({ path: p, exists: false, type: 'file' })
    }
  }
  return out
}

export interface FileSlice {
  content: string
  offset: number
  bytesRead: number
  totalBytes: number
  truncated: boolean
  isBinary: boolean
}

export async function readTextSlice(
  root: string,
  path: string,
  offset = 0,
  length?: number,
): Promise<FileSlice> {
  const abs = await safeResolve(root, path)
  const buf = await readFile(abs)
  const isBinary = buf.subarray(0, BINARY_PROBE_BYTES).includes(0)
  if (isBinary) {
    return { content: '', offset: 0, bytesRead: 0, totalBytes: buf.byteLength, truncated: false, isBinary: true }
  }
  const text = buf.toString('utf-8')
  const start = Math.max(0, Math.min(offset, text.length))
  const end = length === undefined ? text.length : Math.min(text.length, start + Math.max(0, length))
  const content = text.slice(start, end)
  return {
    content,
    offset: start,
    bytesRead: Buffer.byteLength(content, 'utf-8'),
    totalBytes: buf.byteLength,
    truncated: end < text.length,
    isBinary: false,
  }
}

export async function readFileBase64(
  root: string,
  path: string,
  maxBytes = 8 * 1024 * 1024,
  offset = 0,
  length?: number,
): Promise<{ dataBase64: string; totalBytes: number; mediaType: string; offset: number }> {
  const abs = await safeResolve(root, path)
  const buf = await readFile(abs)
  const start = Math.max(0, Math.min(offset, buf.byteLength))
  const slice = length === undefined
    ? buf.subarray(start)
    : buf.subarray(start, Math.min(buf.byteLength, start + Math.max(0, length)))
  if (slice.byteLength > maxBytes) {
    throw new Error(`读取过大（${slice.byteLength} > ${maxBytes} 字节）`)
  }
  return {
    dataBase64: slice.toString('base64'),
    totalBytes: buf.byteLength,
    mediaType: mimeForPath(path),
    offset: start,
  }
}

export interface WorkspaceEntry {
  name: string
  path: string
  relativePath: string
  type: 'file' | 'directory'
}

/** Walk the workspace and return files AND directories (the tree needs both). */
export async function listWorkspaceEntries(
  root: string,
  opts: { scanCap?: number; maxEntries?: number } = {},
): Promise<WorkspaceEntry[]> {
  const scanCap = opts.scanCap ?? 20_000
  const maxEntries = opts.maxEntries ?? 10_000
  const out: WorkspaceEntry[] = []
  let scanned = 0

  async function walk(dir: string): Promise<void> {
    if (scanned >= scanCap || out.length >= maxEntries) return
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (scanned >= scanCap || out.length >= maxEntries) return
      scanned++
      const abs = join(dir, e.name)
      const rel = relative(root, abs).split(sep).join('/')
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        out.push({ name: e.name, path: abs, relativePath: rel, type: 'directory' })
        await walk(abs)
      } else if (e.isFile()) {
        out.push({ name: e.name, path: abs, relativePath: rel, type: 'file' })
      }
    }
  }

  await walk(root)
  return out
}

/** Columnar packing compatible with ZCode's workspaceFileEntriesCodec
 *  (`type\trelativePath` per line, \\ \t \n escaped). */
export function packWorkspaceEntries(entries: readonly WorkspaceEntry[]): string {
  const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n')
  return entries.map((e) => `${e.type}\t${esc(e.relativePath)}`).join('\n')
}

/** Substring search over the workspace (composer @-mention picker). */
export async function searchWorkspaceEntries(
  root: string,
  query: string,
  limit = 50,
): Promise<WorkspaceEntry[]> {
  const q = query.trim().toLowerCase()
  const entries = await listWorkspaceEntries(root, { scanCap: 8000, maxEntries: 8000 })
  const hits = q ? entries.filter((e) => e.relativePath.toLowerCase().includes(q)) : entries
  // Prefer shorter paths (top-level matches read as more relevant) — same rule as list-files.
  return hits.sort((a, b) => a.relativePath.length - b.relativePath.length).slice(0, limit)
}
