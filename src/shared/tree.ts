/** Orchestration tree derivation from the sessions snapshot. Pure logic —
 *  no React, no SDK imports — per the E1 verdict (docs/research/e1-verdict.md):
 *  the v2 engine exposes parentId on sessions, so omo-slim's orchestrator →
 *  specialist structure needs NO private metadata parsing. */

export interface SessionNode {
  id: string
  title: string
  /** Parent session id (null = root). omo subagents always carry one. */
  parentId: string | null
  /** Agent that ran this session ('orchestrator' | 'explorer' | …). */
  agent?: string
  activity?: string
  outcome?: string | null
  updatedAt?: number
  tokens?: number
}

export interface TreeNode {
  node: SessionNode
  children: TreeNode[]
}

/** Build the forest: roots = sessions whose parentId is null or missing from
 *  the snapshot (defensive: a dangling parent degrades to a root, never a
 *  silent drop). Sort children by update time, newest first. */
export function buildTree(sessions: SessionNode[]): TreeNode[] {
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const childrenOf = new Map<string | null, SessionNode[]>()
  for (const s of sessions) {
    // Dangling parent (not in snapshot) → treat as root so the node stays visible.
    const parent = s.parentId !== null && byId.has(s.parentId) ? s.parentId : null
    const list = childrenOf.get(parent) ?? []
    list.push(s)
    childrenOf.set(parent, list)
  }
  const sortNewest = (a: SessionNode, b: SessionNode) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
  const attach = (s: SessionNode): TreeNode => ({
    node: s,
    children: (childrenOf.get(s.id) ?? []).sort(sortNewest).map(attach),
  })
  return (childrenOf.get(null) ?? []).sort(sortNewest).map(attach)
}

/** Sessions that look like omo subagents: they have a parent AND a non-default
 *  agent name. Used to badge the panel ("N 个子代理会话"). */
export function countSubagents(sessions: SessionNode[]): number {
  return sessions.filter((s) => s.parentId !== null && s.agent && s.agent !== 'build').length
}

/** Flatten depth-first for rendering. */
export function flatten(tree: TreeNode[], depth = 0): Array<{ node: SessionNode; depth: number }> {
  const out: Array<{ node: SessionNode; depth: number }> = []
  for (const t of tree) {
    out.push({ node: t.node, depth })
    out.push(...flatten(t.children, depth + 1))
  }
  return out
}
