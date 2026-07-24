import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogger, recentLogs } from '../../src/utils/logger'

// Redirect the log file into a temp dir so tests never touch the real ~/.opencode.
const tmp = mkdtempSync(join(tmpdir(), 'ocrc-logger-test-'))
process.env.OPENCODE_CONFIG_DIR = tmp
process.env.LOG_LEVEL = 'debug'

describe('logger', () => {
  const log = createLogger('test')

  beforeAll(() => {
    // sanity: ring is observable
    expect(Array.isArray(recentLogs())).toBe(true)
  })

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('serializes plain objects', () => {
    log.info('plain', { a: 1 })
    expect(recentLogs().some((l) => l.includes('plain') && l.includes('{"a":1}'))).toBe(true)
  })

  it('uses the stack for Error extras', () => {
    log.error('boom', new Error('kaboom'))
    expect(recentLogs().some((l) => l.includes('boom') && l.includes('kaboom'))).toBe(true)
  })

  it('does not throw on circular objects — prints [unserializable]', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => log.warn('circ', circular)).not.toThrow()
    expect(recentLogs().some((l) => l.includes('circ') && l.includes('[unserializable]'))).toBe(true)
  })

  it('does not throw on circular objects at error level (crash-guard path)', () => {
    const a: Record<string, unknown> = {}
    const b: Record<string, unknown> = { a }
    a.b = b
    expect(() => log.error('guard', a)).not.toThrow()
    expect(recentLogs().some((l) => l.includes('guard') && l.includes('[unserializable]'))).toBe(true)
  })
})
