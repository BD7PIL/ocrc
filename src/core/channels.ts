import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createLogger } from '../utils/logger.js'

const log = createLogger('channels')

/**
 * M9: per-channel bot settings, persisted atomically at ~/.ocrc/channels.json
 * (same tmp+rename+debounce pattern as schedules.json). v1 keeps ONE fixed bot
 * entry per channel — no multi-bot. Entries never disappear; "删除" in the UI
 * resets them to defaults.
 */

export type ChannelKind = 'telegram' | 'wechat' | 'lark'
/** standard = hide the tool-call process (ZCode 标准回复); detailed = show it. */
export type ReplyGranularity = 'standard' | 'detailed'
export type WorkspaceScope = { mode: 'all' } | { mode: 'custom'; dirs: string[] }

export interface ChannelBot {
  id: string
  channel: ChannelKind
  enabled: boolean
  /** Channel credentials (e.g. telegram bot token, wechat appid/secret). */
  credentials: Record<string, string>
  replyGranularity: ReplyGranularity
  workspaces: WorkspaceScope
  /** 0.27: the Telegram allowlist (Telegram numeric user ids). When absent or
   *  empty, entry falls back to the env ALLOWED_USER_IDS; set = panel wins
   *  (same precedence as the panel token). Reset returns to the env fallback. */
  allowUsers?: number[]
}

export interface ChannelsStore {
  list(): ChannelBot[]
  get(id: string): ChannelBot | undefined
  update(id: string, patch: Partial<Pick<ChannelBot, 'enabled' | 'credentials' | 'replyGranularity' | 'workspaces' | 'allowUsers'>>): ChannelBot | undefined
  reset(id: string): ChannelBot | undefined
}

const DEFAULT_IDS: Array<{ id: string; channel: ChannelKind }> = [
  { id: 'tg-default', channel: 'telegram' },
  { id: 'wechat-default', channel: 'wechat' },
  { id: 'lark-default', channel: 'lark' },
]

function defaults(): ChannelBot[] {
  return DEFAULT_IDS.map(({ id, channel }) => ({
    id,
    channel,
    enabled: channel === 'telegram', // the channel that actually ships today
    credentials: {},
    replyGranularity: 'standard', // ZCode 标准回复: hide the tool-call process
    workspaces: { mode: 'all' },
  }))
}

export function createChannelsStore(path: string): ChannelsStore {
  let bots: ChannelBot[] = defaults()

  function load(): void {
    if (!existsSync(path)) return
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as { bots?: ChannelBot[] }
      if (!Array.isArray(raw.bots)) return
      // Merge by id so newly-added channel defaults appear on upgrade while
      // persisted values win over defaults.
      for (const saved of raw.bots) {
        const target = bots.find((b) => b.id === saved?.id)
        if (target) Object.assign(target, saved, { channel: target.channel })
      }
    } catch (err) {
      log.warn(`failed to load ${path}: ${(err as Error).message}`)
    }
  }

  let writeQueued: ReturnType<typeof setTimeout> | undefined
  function persist(): void {
    if (writeQueued) clearTimeout(writeQueued)
    writeQueued = setTimeout(() => {
      try {
        mkdirSync(dirname(path), { recursive: true })
        const tmp = `${path}.tmp`
        writeFileSync(tmp, JSON.stringify({ bots }, null, 2), { mode: 0o600 })
        renameSync(tmp, path)
      } catch (err) {
        log.warn(`persist failed: ${(err as Error).message}`)
      }
    }, 100)
    writeQueued.unref?.()
  }

  load()

  return {
    list: () => bots.map((b) => ({ ...b })),
    get: (id) => {
      const b = bots.find((x) => x.id === id)
      return b ? { ...b } : undefined
    },
    update: (id, patch) => {
      const b = bots.find((x) => x.id === id)
      if (!b) return undefined
      if (patch.enabled !== undefined) b.enabled = patch.enabled
      if (patch.credentials !== undefined) b.credentials = { ...patch.credentials }
      if (patch.replyGranularity !== undefined) b.replyGranularity = patch.replyGranularity
      if (patch.workspaces !== undefined) b.workspaces = patch.workspaces
      if (patch.allowUsers !== undefined) {
        // Defense in depth: the route validates shape; the store still only
        // ever persists deduped integers.
        b.allowUsers = [...new Set(patch.allowUsers.filter((n) => Number.isInteger(n)))]
      }
      persist()
      return { ...b }
    },
    reset: (id) => {
      const fresh = defaults().find((b) => b.id === id)
      const idx = bots.findIndex((b) => b.id === id)
      if (!fresh || idx === -1) return undefined
      bots[idx] = fresh
      persist()
      return { ...fresh }
    },
  }
}

/** Default on-disk location: ~/.ocrc/channels.json */
export function channelsPath(home: string): string {
  return join(home, 'channels.json')
}
