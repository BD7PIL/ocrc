// file-watcher.ts — U4：/z/ 面板的文件变更监听（fileWatcherService 的 host 半边）。
//
// 上游 Host 是桌面进程，watcher 与 UI 同进程。ocrc 的面板在浏览器里：watch/unwatch
// 走 /ws 帧（ws-hub 的 `file-watch` 消息），事件以同类型帧广播回全部客户端（id 是
// 订阅键，客户端自筛）。底层 node fs.watch（Linux recursive 内建可用）。
//
// 噪音治理（写风暴是 agent 回合的常态）：
// - 每 watcher 目录 300ms 防抖合并；窗口内多个路径 → 省略 changedPath（vendor 契约
//   就是「不能确认时省略，调用方保守刷新」）。
// - 目录数上限 64（递归 watch 的内核代价高，防失控）；拒绝 '/' 与非绝对路径。
import { watch, type FSWatcher } from 'node:fs'
import { createLogger } from '../utils/logger.js'

const log = createLogger('file-watcher')

const DEBOUNCE_MS = 300
const MAX_WATCHERS = 64

interface WatcherEntry {
  id: string
  dir: string
  recursive: boolean
  refcount: number
  fsWatcher: FSWatcher
  timer: ReturnType<typeof setTimeout> | null
  pendingPaths: Set<string>
}

export interface FileWatchFrame {
  id: string
  dirPath: string
  changedPath?: string
}

export interface FileWatcherHub {
  /** Returns the watcher ids now backing (path, recursive). */
  watch(path: string, recursive: boolean): { id: string }
  unwatch(id: string): void
  /** Drop one client's registrations (ws detach). Ids unique per client. */
  unwatchAllFor(ids: Iterable<string>): void
  disposeAll(): void
}

export function createFileWatcherHub(broadcast: (frame: FileWatchFrame) => void): FileWatcherHub {
  const byId = new Map<string, WatcherEntry>()
  const byDir = new Map<string, WatcherEntry>()

  const flush = (entry: WatcherEntry): void => {
    entry.timer = null
    const paths = [...entry.pendingPaths]
    entry.pendingPaths.clear()
    const changedPath = paths.length === 1 ? paths[0] : undefined
    broadcast({ id: entry.id, dirPath: entry.dir, ...(changedPath ? { changedPath } : {}) })
  }

  const startWatcher = (dir: string, recursive: boolean): WatcherEntry => {
    const id = `fw-${Math.random().toString(36).slice(2, 10)}`
    const fsWatcher = watch(dir, { recursive }, (event, filename) => {
      const entry = byId.get(id)
      if (!entry) return
      if (typeof filename === 'string') entry.pendingPaths.add(`${entry.dir}/${filename}`)
      if (!entry.timer) {
        entry.timer = setTimeout(() => flush(entry), DEBOUNCE_MS)
      }
    })
    fsWatcher.on('error', (err) => {
      log.warn(`watcher ${dir} error: ${(err as Error).message}`)
      // Dead watcher (dir deleted): release and let the panel re-watch on demand.
      const entry = byId.get(id)
      if (entry) release(entry)
    })
    const entry: WatcherEntry = { id, dir, recursive, refcount: 0, fsWatcher, timer: null, pendingPaths: new Set() }
    byId.set(id, entry)
    byDir.set(dir, entry)
    log.info(`watching ${dir}${recursive ? ' (recursive)' : ''} → ${id}`)
    return entry
  }

  const release = (entry: WatcherEntry): void => {
    if (entry.timer) clearTimeout(entry.timer)
    try { entry.fsWatcher.close() } catch { /* noop */ }
    byId.delete(entry.id)
    if (byDir.get(entry.dir) === entry) byDir.delete(entry.dir)
  }

  return {
    watch(path, recursive) {
      if (typeof path !== 'string' || !path.startsWith('/') || path === '/') {
        throw new Error('file-watch: path must be an absolute directory')
      }
      if (byId.size >= MAX_WATCHERS && !byDir.has(path)) {
        throw new Error(`file-watch: watcher cap (${MAX_WATCHERS}) reached`)
      }
      const existing = byDir.get(path)
      if (existing) return { id: existing.id }
      const entry = startWatcher(path, recursive)
      return { id: entry.id }
    },
    unwatch(id) {
      const entry = byId.get(id)
      if (entry) release(entry)
    },
    unwatchAllFor(ids) {
      for (const id of ids) {
        const entry = byId.get(id)
        if (entry) release(entry)
      }
    },
    disposeAll() {
      for (const entry of [...byId.values()]) release(entry)
    },
  }
}
