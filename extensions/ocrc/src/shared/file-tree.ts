/**
 * Pure tree helpers for the config-diff card: 14k-file regions render as a
 * collapsible tree with directory-level checkboxes and an inline direction
 * toggle, and the action buttons need a minimal covering list of what is
 * actually selected. All of it is state-in/state-out so the panel component
 * stays thin and the semantics are pinned by unit tests.
 */

export interface TreeNode {
  /** Last path segment ('' for the root). */
  name: string
  /** Config-dir-relative posix path ('' for the root). */
  path: string
  dir: boolean
  /** Directories sort ahead of files, both a→z (stable, reviewable). */
  children: TreeNode[]
  /** Number of file leaves under this node (1 for a file). */
  count: number
}

export type CheckState = 'on' | 'off' | 'mixed'

/** Build one tree from rel paths. Input order does not matter. */
export function buildFileTree(paths: readonly string[]): TreeNode {
  const root: TreeNode = { name: '', path: '', dir: true, children: [], count: 0 }
  const dirs = new Map<string, TreeNode>([['', root]])
  const ensureDir = (path: string): TreeNode => {
    const found = dirs.get(path)
    if (found) return found
    const slash = path.lastIndexOf('/')
    const parent = ensureDir(slash < 0 ? '' : path.slice(0, slash))
    const node: TreeNode = { name: slash < 0 ? path : path.slice(slash + 1), path, dir: true, children: [], count: 0 }
    parent.children.push(node)
    dirs.set(path, node)
    return node
  }
  for (const rel of paths) {
    if (!rel) continue
    const slash = rel.lastIndexOf('/')
    const parent = ensureDir(slash < 0 ? '' : rel.slice(0, slash))
    parent.children.push({ name: slash < 0 ? rel : rel.slice(slash + 1), path: rel, dir: false, children: [], count: 1 })
  }
  const tally = (node: TreeNode): number => {
    if (!node.dir) return node.count
    node.children.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
    node.count = node.children.reduce((sum, c) => sum + tally(c), 0)
    return node.count
  }
  tally(root)
  return root
}

/** Every file leaf under `node`, in display order. */
export function leafPaths(node: TreeNode): string[] {
  if (!node.dir) return [node.path]
  return node.children.flatMap(leafPaths)
}

/** Aggregate state of a node: an explicit override per leaf on top of the
 *  region's default (会推 defaults on, 只在远程 defaults off, direction
 *  defaults push — same machinery, different default). */
export function checkState(node: TreeNode, overrides: Record<string, boolean>, def: boolean): CheckState {
  if (!node.dir) return (overrides[node.path] ?? def) ? 'on' : 'off'
  let on = 0
  let total = 0
  for (const leaf of leafPaths(node)) {
    total += 1
    if (overrides[leaf] ?? def) on += 1
  }
  if (on === 0) return 'off'
  if (on === total) return 'on'
  return 'mixed'
}

/** Toggle a whole node: every leaf under it gets the explicit value. */
export function setSubtree(node: TreeNode, overrides: Record<string, boolean>, value: boolean): Record<string, boolean> {
  for (const leaf of leafPaths(node)) overrides[leaf] = value
  return overrides
}

/**
 * Minimal covering entries for the "on" leaves: a directory whose leaves are
 * all on contributes just the directory path (the bridge expands prefixes);
 * a mixed directory recurses; off contributes nothing.
 */
export function minCover(node: TreeNode, overrides: Record<string, boolean>, def: boolean): string[] {
  if (!node.dir) return checkState(node, overrides, def) === 'on' ? [node.path] : []
  const state = checkState(node, overrides, def)
  if (state === 'off') return []
  // The root's own path is '' — meaningless downstream, so it always recurses
  // into its children instead of covering with itself.
  if (state === 'on' && node.path !== '') return [node.path]
  return node.children.flatMap((c) => minCover(c, overrides, def))
}
