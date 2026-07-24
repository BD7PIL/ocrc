import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileBackedState } from '../../src/core/state'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'state-test-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('SessionState', () => {
  it('returns undefined when no file exists', () => {
    const state = createFileBackedState(join(dir, 'state.json'))
    expect(state.getLastSessionId()).toBeUndefined()
    expect(state.getNextAgent()).toBeUndefined()
    expect(state.getNextModel()).toBeUndefined()
  })

  it('round-trips lastSessionId', async () => {
    const path = join(dir, 'state.json')
    const a = createFileBackedState(path)
    a.setLastSessionId('ses_1')
    await a.flush()
    const b = createFileBackedState(path)
    expect(b.getLastSessionId()).toBe('ses_1')
  })

  it('round-trips nextAgent + nextModel', async () => {
    const path = join(dir, 'state.json')
    const a = createFileBackedState(path)
    a.setNextAgent('build')
    a.setNextModel({ providerID: 'kimi-for-coding', modelID: 'k2p6' })
    await a.flush()
    const b = createFileBackedState(path)
    expect(b.getNextAgent()).toBe('build')
    expect(b.getNextModel()).toEqual({ providerID: 'kimi-for-coding', modelID: 'k2p6' })
  })

  it('recovers from malformed JSON by treating as empty', () => {
    const path = join(dir, 'state.json')
    writeFileSync(path, 'not json {{{')
    const state = createFileBackedState(path)
    expect(state.getLastSessionId()).toBeUndefined()
  })

  it('clears nextAgent when set to undefined', async () => {
    const path = join(dir, 'state.json')
    const a = createFileBackedState(path)
    a.setNextAgent('build')
    a.setNextAgent(undefined)
    await a.flush()
    const b = createFileBackedState(path)
    expect(b.getNextAgent()).toBeUndefined()
  })

  it('round-trips tuiSelectedSession + currentAgent', async () => {
    const path = join(dir, 'state.json')
    const a = createFileBackedState(path)
    a.setTuiSelectedSession('ses_xyz')
    a.setCurrentAgent('build')
    await a.flush()
    const b = createFileBackedState(path)
    expect(b.getTuiSelectedSession()).toBe('ses_xyz')
    expect(b.getCurrentAgent()).toBe('build')
  })

  it('persists activeWorkspace', async () => {
    const path = join(dir, 'state.json')
    const a = createFileBackedState(path)
    expect(a.getActiveWorkspace()).toBeUndefined()
    a.setActiveWorkspace('/Users/x/repo')
    await a.flush()
    const b = createFileBackedState(path)
    expect(b.getActiveWorkspace()).toBe('/Users/x/repo')
    b.setActiveWorkspace(undefined)
    await b.flush()
    const c = createFileBackedState(path)
    expect(c.getActiveWorkspace()).toBeUndefined()
  })

  it('tracks active generation via the abort registry', () => {
    const s = createFileBackedState(join(dir, 'state.json'))
    expect(s.hasActiveGeneration()).toBe(false)
    const ac = new AbortController()
    s.setActiveAbort('ses_1', ac)
    expect(s.hasActiveGeneration()).toBe(true)
    expect(s.getActiveAbort('ses_1')).toBe(ac)
    s.setActiveAbort('ses_1', undefined)
    expect(s.hasActiveGeneration()).toBe(false)
  })

  it('hasActiveGeneration(sessionId) scopes the check to one session', () => {
    const s = createFileBackedState(join(dir, 'state.json'))
    s.setActiveAbort('ses_a', new AbortController())
    expect(s.hasActiveGeneration('ses_a')).toBe(true)
    expect(s.hasActiveGeneration('ses_b')).toBe(false)
    expect(s.hasActiveGeneration()).toBe(true) // global semantics preserved
    s.setActiveAbort('ses_a', undefined)
    expect(s.hasActiveGeneration('ses_a')).toBe(false)
    expect(s.hasActiveGeneration()).toBe(false)
  })

  it('hasActiveGeneration(sessionId) resolves short suffixes before checking', () => {
    const s = createFileBackedState(join(dir, 'state.json'))
    s.setSessionBackend('ses_full_abcdef', 'opencode')
    s.setActiveAbort('ses_full_abcdef', new AbortController())
    expect(s.hasActiveGeneration('abcdef')).toBe(true)
    expect(s.hasActiveGeneration('000000')).toBe(false)
  })

  it('round-trips session→backend tags and active backend', async () => {
    const path = join(dir, 'state.json')
    const s = createFileBackedState(path)
    expect(s.getSessionBackend('k1')).toBeUndefined()
    expect(s.getActiveBackend()).toBeUndefined()
    s.setSessionBackend('k1', 'acp:kimi')
    s.setSessionBackend('o1', 'opencode')
    s.setActiveBackend('acp:kimi')
    await s.flush()
    const r = createFileBackedState(path)
    expect(r.getSessionBackend('k1')).toBe('acp:kimi')
    expect(r.getSessionBackend('o1')).toBe('opencode')
    expect(r.getActiveBackend()).toBe('acp:kimi')
  })

  it('dropSession clears its backend tag', async () => {
    const path = join(dir, 'state.json')
    const s = createFileBackedState(path)
    s.setSessionBackend('k1', 'acp:kimi')
    s.dropSession('k1')
    await s.flush()
    expect(createFileBackedState(path).getSessionBackend('k1')).toBeUndefined()
  })

  describe('normalizeSessionId', () => {
    it('passes undefined/empty through instead of throwing or matching everything', () => {
      const s = createFileBackedState(join(dir, 'state.json'))
      s.setSessionBackend('ses_full_abcdef', 'opencode')
      expect(s.normalizeSessionId(undefined as any)).toBeUndefined()
      expect(s.normalizeSessionId('')).toBe('')
    })

    it('passes full IDs through unchanged', () => {
      const s = createFileBackedState(join(dir, 'state.json'))
      s.setSessionBackend('ses_full_abcdef', 'opencode')
      expect(s.normalizeSessionId('ses_other_xyz')).toBe('ses_other_xyz')
      expect(s.normalizeSessionId('session_acp_1')).toBe('session_acp_1')
      expect(s.normalizeSessionId('123e4567-e89b-12d3-a456-426614174000')).toBe('123e4567-e89b-12d3-a456-426614174000')
    })

    it('ignores suffixes shorter than 6 chars even when they match', () => {
      const s = createFileBackedState(join(dir, 'state.json'))
      s.setSessionBackend('ses_full_abcde', 'opencode')
      expect(s.normalizeSessionId('abcde')).toBe('abcde')
    })

    it('resolves a unique >= 6 char suffix to the full session id', () => {
      const s = createFileBackedState(join(dir, 'state.json'))
      s.setSessionBackend('ses_full_abcdef', 'opencode')
      s.setSessionBackend('session_other_123456', 'acp:kimi')
      expect(s.normalizeSessionId('abcdef')).toBe('ses_full_abcdef')
      expect(s.normalizeSessionId('123456')).toBe('session_other_123456')
    })

    it('returns the input unchanged when a suffix matches multiple sessions', () => {
      const s = createFileBackedState(join(dir, 'state.json'))
      s.setSessionBackend('ses_aaa_abcdef', 'opencode')
      s.setSessionBackend('session_bbb_abcdef', 'acp:kimi')
      expect(s.normalizeSessionId('abcdef')).toBe('abcdef')
    })

    it('returns the input unchanged when nothing matches', () => {
      const s = createFileBackedState(join(dir, 'state.json'))
      s.setSessionBackend('ses_full_abcdef', 'opencode')
      expect(s.normalizeSessionId('zzzzzz')).toBe('zzzzzz')
    })
  })
})
