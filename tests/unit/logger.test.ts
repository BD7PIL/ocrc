import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogger, recentLogs } from '../../src/utils/logger'

// Redirect the log file into a temp dir so tests never touch the real ~/.opencode.
const tmp = mkdtempSync(join(tmpdir(), 'ocrc-logger-test-'))
process.env.OCRC_HOME = tmp
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

  it('rotates the log file to a single .old generation past the size threshold', () => {
    const fp = join(tmp, 'ocrc.log')
    process.env.OCRC_LOG_MAX_BYTES = '64'
    try {
      writeFileSync(fp, 'x'.repeat(128))
      log.info('trigger-rotation')
      // Previous content moved to .old …
      expect(readFileSync(`${fp}.old`, 'utf-8')).toContain('x'.repeat(128))
      // … and the fresh file holds only the new line.
      const cur = readFileSync(fp, 'utf-8')
      expect(cur).toContain('trigger-rotation')
      expect(cur).not.toContain('x'.repeat(128))
      // A second rotation clobbers the first .old (single generation).
      writeFileSync(fp, 'y'.repeat(128))
      log.info('trigger-rotation-2')
      expect(readFileSync(`${fp}.old`, 'utf-8')).toContain('y'.repeat(128))
      expect(readFileSync(fp, 'utf-8')).toContain('trigger-rotation-2')
      expect(existsSync(`${fp}.old.old`)).toBe(false)
    } finally {
      delete process.env.OCRC_LOG_MAX_BYTES
    }
  })
})
