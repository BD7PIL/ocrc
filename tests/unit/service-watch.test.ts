import { describe, it, expect } from 'vitest'
import { shouldRestart } from '../../src/cli/service'

describe('shouldRestart (watch-loop crash vs intentional)', () => {
  it('restarts on a crash exit code', () => {
    expect(shouldRestart(1, null, false)).toBe(true)
    expect(shouldRestart(0, null, false)).toBe(true) // clean-looking exit is still a surprise → restart
  })

  it('SIGTERM/SIGINT = intentional stop (operator / our own graceful path)', () => {
    expect(shouldRestart(null, 'SIGTERM', false)).toBe(false)
    expect(shouldRestart(null, 'SIGINT', false)).toBe(false)
  })

  it('SIGKILL / SIGSEGV = crash → restart (OOM recovery; octg got this wrong)', () => {
    expect(shouldRestart(null, 'SIGKILL', false)).toBe(true)
    expect(shouldRestart(null, 'SIGSEGV', false)).toBe(true)
    expect(shouldRestart(null, 'SIGABRT', false)).toBe(true)
  })

  it('stop file wins over everything', () => {
    expect(shouldRestart(1, null, true)).toBe(false)
    expect(shouldRestart(null, 'SIGKILL', true)).toBe(false)
  })
})
