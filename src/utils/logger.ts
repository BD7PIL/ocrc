import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ocrcHome } from './paths.js'

type Level = 'debug' | 'info' | 'warn' | 'error'

const LEVELS: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 }

function currentLevel(): number {
  const raw = (process.env.LOG_LEVEL ?? 'warn').toLowerCase()
  return LEVELS[raw as Level] ?? LEVELS.info
}

function logFilePath(): string {
  return join(ocrcHome(), 'ocrc.log')
}

// Single-generation rotation: once the log passes the threshold it is renamed
// to `<file>.old` (clobbering any previous .old) and a fresh file is started.
// Keeps the on-disk footprint bounded at ~2× the threshold. The threshold is
// env-overridable mainly so tests don't have to write 10MB.
const DEFAULT_MAX_LOG_BYTES = 10 * 1024 * 1024
function maxLogBytes(): number {
  const raw = Number(process.env.OCRC_LOG_MAX_BYTES)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_LOG_BYTES
}

function rotateIfNeeded(fp: string): void {
  try {
    if (statSync(fp).size >= maxLogBytes()) renameSync(fp, `${fp}.old`)
  } catch {
    // missing file (ENOENT) or rename failure — the append below handles it
  }
}

let logFileReady = false
function ensureLogFile() {
  if (logFileReady) return
  try {
    const fp = logFilePath()
    mkdirSync(join(fp, '..'), { recursive: true })
    logFileReady = true
  } catch {
    // best effort — if we can't create the dir, fall back to console
  }
}

function format(level: Level, mod: string, msg: string, extra: unknown[]): string {
  const ts = new Date().toISOString()
  const extras = extra.length ? ' ' + extra.map(formatExtra).join(' ') : ''
  return `[${ts}] [${level.toUpperCase()}] [${mod}] ${msg}${extras}`
}

// JSON.stringify throws on circular structures; this runs inside the process
// crash guards (unhandledRejection/uncaughtException), so it must never throw.
function formatExtra(e: unknown): string {
  if (e instanceof Error) return e.stack ?? e.message
  try {
    return JSON.stringify(e)
  } catch {
    return '[unserializable]'
  }
}

// In-memory ring buffer of recent log lines, surfaced via GET /api/logs for
// remote diagnostics without shipping the user a log file.
const RING_SIZE = 500
const ring: string[] = []

export function recentLogs(limit = RING_SIZE): string[] {
  return ring.slice(-limit)
}

function write(level: Level, mod: string, msg: string, extra: unknown[]): void {
  const line = format(level, mod, msg, extra)

  ring.push(line)
  if (ring.length > RING_SIZE) ring.shift()

  // Write to file only — console would pollute the opencode TUI
  ensureLogFile()
  try {
    const fp = logFilePath()
    rotateIfNeeded(fp)
    appendFileSync(fp, line + '\n')
  } catch {
    // fallback to stderr if file writing fails
    if (level === 'error' || level === 'warn') console.error(line)
  }
}

export function createLogger(mod: string) {
  return {
    debug: (msg: string, ...extra: unknown[]) => {
      if (currentLevel() <= LEVELS.debug) write('debug', mod, msg, extra)
    },
    info: (msg: string, ...extra: unknown[]) => {
      if (currentLevel() <= LEVELS.info) write('info', mod, msg, extra)
    },
    warn: (msg: string, ...extra: unknown[]) => {
      if (currentLevel() <= LEVELS.warn) write('warn', mod, msg, extra)
    },
    error: (msg: string, ...extra: unknown[]) => {
      if (currentLevel() <= LEVELS.error) write('error', mod, msg, extra)
    },
  }
}
