import { describe, it, expect } from 'vitest'
import { parseBinding, matchesBinding } from './bindings.js'

const ev = (over: Partial<KeyboardEvent> = {}): KeyboardEvent =>
  ({ key: '', code: '', keyCode: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...over }) as KeyboardEvent

describe('parseBinding', () => {
  it('parses Ctrl+N into physical code candidates', () => {
    expect(parseBinding('Ctrl+N')).toMatchObject({ ctrl: true, shift: false, key: 'N', codes: ['KeyN'] })
  })
  it('parses symbol combos with physical code candidates (shift-proof)', () => {
    expect(parseBinding('Ctrl+Shift+[')).toMatchObject({ ctrl: true, shift: true, key: '[', codes: ['BracketLeft'] })
  })
})

describe('matchesBinding', () => {
  it('Ctrl+N matches ctrlKey+KeyN', () => {
    const b = parseBinding('Ctrl+N')
    expect(matchesBinding(ev({ key: 'n', code: 'KeyN', keyCode: 78, ctrlKey: true }), b)).toBe(true)
  })
  it('does not match without the modifier', () => {
    const b = parseBinding('Ctrl+N')
    expect(matchesBinding(ev({ key: 'n', code: 'KeyN', keyCode: 78 }), b)).toBe(false)
  })
  it('symbol combo matches by event.key', () => {
    const b = parseBinding('Ctrl+Shift+[')
    expect(matchesBinding(ev({ key: '{', code: 'BracketLeft', keyCode: 219, ctrlKey: true, shiftKey: true }), b)).toBe(true)
  })
  it('IME keyCode 229 never matches', () => {
    const b = parseBinding('Ctrl+N')
    expect(matchesBinding(ev({ key: 'n', code: 'KeyN', keyCode: 229, ctrlKey: true }), b)).toBe(false)
  })
  it('plain key matches without modifiers', () => {
    const b = parseBinding('Escape')
    expect(matchesBinding(ev({ key: 'Escape', code: 'Escape', keyCode: 27 }), b)).toBe(true)
    expect(matchesBinding(ev({ key: 'Escape', code: 'Escape', keyCode: 27, ctrlKey: true }), b)).toBe(false)
  })
})
