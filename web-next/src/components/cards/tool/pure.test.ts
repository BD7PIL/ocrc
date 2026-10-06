import { describe, it, expect } from 'vitest'
import {
  paceStep, snapPunctuation, nextReveal, parseToolArgs, todoItems,
  diffSides, bashCommand, toolRendererKind,
} from './pure.js'

describe('paceStep', () => {
  it('short blocks crawl at 2 chars', () => {
    expect(paceStep(5)).toBe(2)
    expect(paceStep(12)).toBe(2)
  })
  it('large blocks sweep, capped at 256', () => {
    expect(paceStep(320)).toBe(10)
    expect(paceStep(10_000)).toBe(256)
  })
})

describe('snapPunctuation', () => {
  it('extends to a sentence ender within the lookahead', () => {
    const text = '你好世界。后面还有'
    // head lands exactly before 。 → snap past it
    expect(snapPunctuation(4, text)).toBe(5)
  })
  it('does not reach beyond the lookahead', () => {
    const text = 'abcd。efg'
    expect(snapPunctuation(0, text, 3)).toBe(0)
  })
  it('newlines count as clean ends', () => {
    expect(snapPunctuation(2, 'ab\ncd')).toBe(3)
  })
})

describe('nextReveal', () => {
  it('advances by the adaptive step then snaps', () => {
    const text = 'aaaa…bbbb'
    const n = nextReveal(0, text)
    expect(n).toBeGreaterThanOrEqual(4)
    expect(text.slice(0, n).endsWith('…')).toBe(true) // … at index 4 snapped
  })
  it('never exceeds the text length', () => {
    expect(nextReveal(10, 'short')).toBe(5)
  })
})

describe('parseToolArgs', () => {
  it('parses json objects', () => {
    expect(parseToolArgs('{"command":"ls"}')).toEqual({ ok: true, args: { command: 'ls' } })
  })
  it('fails soft on prose/non-object/plain text', () => {
    expect(parseToolArgs('not json').ok).toBe(false)
    expect(parseToolArgs('[1,2]').ok).toBe(false)
    expect(parseToolArgs('').ok).toBe(false)
  })
})

describe('todoItems', () => {
  it('extracts content/status from todos array', () => {
    expect(todoItems({ todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }] }))
      .toEqual([{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }])
  })
  it('returns empty for malformed args', () => {
    expect(todoItems({ todos: 'nope' })).toEqual([])
    expect(todoItems({})).toEqual([])
  })
})

describe('diffSides', () => {
  it('splits edit old/new into removals/additions', () => {
    expect(diffSides({ filePath: '/a.ts', oldString: 'x\ny', newString: 'x\nz' })).toEqual({
      filePath: '/a.ts', removals: ['x', 'y'], additions: ['x', 'z'],
    })
  })
  it('treats write content as additions', () => {
    expect(diffSides({ filePath: '/b.md', content: 'hello' })?.additions).toEqual(['hello'])
  })
  it('null when nothing recognizable', () => {
    expect(diffSides({})).toBeNull()
  })
})

describe('bashCommand', () => {
  it('joins array commands', () => {
    expect(bashCommand({ command: ['a', 'b'] })).toBe('a b')
  })
})

describe('toolRendererKind', () => {
  it('routes todo/edit/bash families', () => {
    expect(toolRendererKind('todowrite')).toBe('todo')
    expect(toolRendererKind('edit')).toBe('diff')
    expect(toolRendererKind('multiedit')).toBe('diff')
    expect(toolRendererKind('write')).toBe('diff')
    expect(toolRendererKind('bash')).toBe('bash')
    expect(toolRendererKind('read')).toBeNull()
  })
})
