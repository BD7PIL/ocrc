import { describe, it, expect } from 'vitest'
import { shouldRestart } from '../../src/cli/service'

describe('shouldRestart (watch-loop crash vs intentional)', () => {
  it('restarts on a crash exit code', () => {
    expect(shouldRestart(1, false)).toBe(true)
    expect(shouldRestart(0, false)).toBe(true) // clean-looking exit is still a surprise → restart
  })

  it('does not restart on signal deaths (128+signal)', () => {
    expect(shouldRestart(143, false)).toBe(false) // SIGTERM
    expect(shouldRestart(137, false)).toBe(false) // SIGKILL
  })

  it('stop file wins over everything', () => {
    expect(shouldRestart(1, true)).toBe(false)
    expect(shouldRestart(null, true)).toBe(false)
  })

  it('null exit code (killed by signal, no code) restarts', () => {
    expect(shouldRestart(null, false)).toBe(true)
  })
})
