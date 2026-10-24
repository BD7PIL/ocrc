import { describe, expect, it } from 'vitest'
import { buildFileTree, checkState, leafPaths, minCover, setSubtree } from './file-tree'

describe('file tree', () => {
  const tree = buildFileTree([
    'skills/a/deep/file.md',
    'skills/a/top.md',
    'skills/b/other.md',
    'AGENTS.md',
  ])

  it('builds dirs-first trees with leaf counts', () => {
    expect(tree.children.map((c) => `${c.dir ? 'd' : 'f'}:${c.name}:${c.count}`)).toEqual([
      'd:skills:3', 'f:AGENTS.md:1',
    ])
    const skills = tree.children[0]!
    expect(skills.children.map((c) => `${c.name}:${c.count}`)).toEqual(['a:2', 'b:1'])
    expect(leafPaths(tree)).toEqual(['skills/a/deep/file.md', 'skills/a/top.md', 'skills/b/other.md', 'AGENTS.md'])
  })

  it('checkState aggregates overrides over the region default', () => {
    expect(checkState(tree, {}, true)).toBe('on')
    expect(checkState(tree, {}, false)).toBe('off')
    const mixed: Record<string, boolean> = { 'AGENTS.md': true }
    expect(checkState(tree, mixed, false)).toBe('mixed')
    const a = tree.children[0]!.children[0]!
    expect(checkState(a, { 'skills/a/top.md': true }, false)).toBe('mixed')
  })

  it('setSubtree writes every leaf under the node', () => {
    const ovr: Record<string, boolean> = {}
    setSubtree(tree.children[0]!, ovr, true)
    expect(Object.keys(ovr).sort()).toEqual(['skills/a/deep/file.md', 'skills/a/top.md', 'skills/b/other.md'])
  })

  it('minCover sends whole directories when fully selected, recurses when mixed', () => {
    // default on, one file deselected → `skills` goes mixed, but its fully-on
    // subdirectories still compress to one entry each
    const ovr: Record<string, boolean> = { 'skills/a/top.md': false }
    expect(minCover(tree, ovr, true).sort()).toEqual(['AGENTS.md', 'skills/a/deep', 'skills/b'])
    // everything on → two covering entries
    expect(minCover(tree, {}, true).sort()).toEqual(['AGENTS.md', 'skills'])
    // default off, one subtree picked → just that subtree
    expect(minCover(tree, setSubtree(tree.children[0]!.children[1]!, {}, true), false)).toEqual(['skills/b'])
  })

  it('empty and pathological inputs do not explode', () => {
    const empty = buildFileTree([])
    expect(leafPaths(empty)).toEqual([])
    expect(checkState(empty, {}, true)).toBe('off')
    expect(minCover(empty, {}, true)).toEqual([])
  })
})
