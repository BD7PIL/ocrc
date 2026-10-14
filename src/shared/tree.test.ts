import { describe, expect, it } from 'vitest'
import { buildTree, countSubagents, flatten, type SessionNode } from './tree.js'

const s = (over: Partial<SessionNode> & { id: string }): SessionNode => ({
  title: over.id,
  parentId: null,
  updatedAt: 0,
  ...over,
})

describe('buildTree (E1 session-tree contract)', () => {
  it('nests omo subagents under their orchestrator via parentId', () => {
    const tree = buildTree([
      s({ id: 'orch', title: 'delegate task', agent: 'orchestrator', updatedAt: 10 }),
      s({ id: 'sub1', parentId: 'orch', agent: 'explorer', updatedAt: 12 }),
      s({ id: 'sub2', parentId: 'orch', agent: 'librarian', updatedAt: 11 }),
    ])
    expect(tree).toHaveLength(1)
    expect(tree[0].node.id).toBe('orch')
    expect(tree[0].children.map((c) => c.node.id)).toEqual(['sub1', 'sub2']) // newest first
  })

  it('degrades a dangling parentId to a root (never drops the node)', () => {
    const tree = buildTree([
      s({ id: 'orphan', parentId: 'ghost-parent', agent: 'explorer' }),
    ])
    expect(tree).toHaveLength(1)
    expect(tree[0].node.id).toBe('orphan')
  })

  it('handles multiple roots and deep nesting', () => {
    const tree = buildTree([
      s({ id: 'a', updatedAt: 1 }),
      s({ id: 'b', updatedAt: 2 }),
      s({ id: 'a1', parentId: 'a', agent: 'oracle', updatedAt: 3 }),
      s({ id: 'a1x', parentId: 'a1', agent: 'fixer', updatedAt: 4 }),
    ])
    expect(tree.map((t) => t.node.id)).toEqual(['b', 'a'])
    expect(tree[1].children[0].children[0].node.id).toBe('a1x')
  })
})

describe('countSubagents', () => {
  it('counts parented non-build sessions only', () => {
    expect(countSubagents([
      s({ id: 'r1' }),
      s({ id: 'r2', agent: 'build' }),
      s({ id: 'c1', parentId: 'r1', agent: 'explorer' }),
      s({ id: 'c2', parentId: 'r1' }), // parented but no agent → not counted
    ])).toBe(1)
  })
})

describe('flatten', () => {
  it('walks depth-first with depth metadata', () => {
    const flat = flatten(buildTree([
      s({ id: 'root', updatedAt: 5 }),
      s({ id: 'kid', parentId: 'root', agent: 'explorer', updatedAt: 6 }),
    ]))
    expect(flat.map((f) => [f.node.id, f.depth])).toEqual([['root', 0], ['kid', 1]])
  })
})
