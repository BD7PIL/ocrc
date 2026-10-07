import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { StructuredCard } from './structured-card.js'

/**
 * 0.27 M6 分享 — session snapshot store (~/.ocrc/shares.json, 0600, atomic).
 * A share is a FULL transcript snapshot at share time (not a live reference):
 * the public read-only page renders exactly what was captured. Codes are
 * 12-char url-safe random; ids carry no session identity.
 */

export interface ShareEntry {
  code: string
  title: string
  sessionId: string
  createdAt: number
  cards: StructuredCard[]
}

export interface SharesStore {
  create(sessionId: string, title: string, cards: StructuredCard[]): ShareEntry
  get(code: string): ShareEntry | undefined
  remove(code: string): boolean
  list(): ShareEntry[]
}

export function createSharesStore(stateDir: string): SharesStore {
  const path = join(stateDir, 'shares.json')
  let cache: ShareEntry[] | undefined
  const load = (): ShareEntry[] => {
    if (cache) return cache
    try { cache = JSON.parse(readFileSync(path, 'utf-8')) ?? [] } catch { cache = [] }
    return cache!
  }
  const persist = (entries: ShareEntry[]) => {
    cache = entries
    try {
      mkdirSync(dirname(path), { recursive: true })
      const tmp = `${path}.tmp`
      writeFileSync(tmp, JSON.stringify(entries), { mode: 0o600 })
      renameSync(tmp, path)
    } catch (err) {
      // non-fatal: shares are best-effort
      console.warn('[shares] persist failed', (err as Error).message)
    }
  }
  return {
    create(sessionId, title, cards) {
      const code = randomBytes(9).toString('base64url').slice(0, 12)
      const entry: ShareEntry = { code, title, sessionId, createdAt: Date.now(), cards }
      persist([...load(), entry])
      return entry
    },
    get: (code) => load().find((e) => e.code === code),
    remove: (code) => {
      const entries = load()
      const next = entries.filter((e) => e.code !== code)
      if (next.length === entries.length) return false
      persist(next)
      return true
    },
    list: () => load(),
  }
}

export const SHARES_DIR_HINT = 'shares.json lives next to state.json'
