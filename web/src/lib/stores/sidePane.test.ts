import { describe, it, expect, beforeEach, vi } from 'vitest'

// The store persists via localStorage on every transition — fresh module per
// test so each starts from a clean (stubbed) storage.
let sidePane: typeof import('./sidePane.js')

async function fresh() {
  // No resetPane here: the point is to re-import the module so it loads from
  // localStorage — resetPane would wipe the persisted state under test.
  vi.resetModules()
  sidePane = await import('./sidePane.js')
}

describe('sidePane store', () => {
  beforeEach(async () => {
    localStorage.clear()
    await fresh()
  })

  it('opens a tab idempotently — same id replaces in place (ZCode semantics)', () => {
    const tab = { id: 'sub:s1', kind: 'subagent' as const, title: 'researcher', childId: 's1' }
    sidePane.openPaneTab(tab)
    sidePane.openPaneTab({ ...tab, title: 'renamed' })
    const s = sidePane.paneSnapshot()
    expect(s.tabs).toHaveLength(1)
    expect(s.activeId).toBe('sub:s1')
    expect(s.tabs[0].title).toBe('renamed')
  })

  it('openHome opens the five well-known singleton tabs, closable like any other', () => {
    sidePane.openHome('tasks')
    sidePane.openHome('config')
    let s = sidePane.paneSnapshot()
    expect(s.tabs.map((t) => t.id)).toEqual(['tasks', 'config'])
    expect(s.activeId).toBe('config')
    sidePane.closePaneTab('config')
    s = sidePane.paneSnapshot()
    expect(s.tabs.map((t) => t.id)).toEqual(['tasks'])
    expect(s.activeId).toBe('tasks')
  })

  it('closing the active tab activates the neighbor (prev first)', () => {
    sidePane.openPaneTab({ id: 'sub:s1', kind: 'subagent', title: 'one', childId: 's1' })
    sidePane.openPaneTab({ id: 'sub:s2', kind: 'subagent', title: 'two', childId: 's2' })
    sidePane.openPaneTab({ id: 'sub:s3', kind: 'subagent', title: 'three', childId: 's3' })
    sidePane.activatePane('sub:s2')
    sidePane.closePaneTab('sub:s2')
    expect(sidePane.paneSnapshot().activeId).toBe('sub:s1')
    // closing the first of one remaining falls forward
    sidePane.closePaneTab('sub:s1')
    expect(sidePane.paneSnapshot().activeId).toBe('sub:s3')
    // closing the last tab leaves an honest empty state
    sidePane.closePaneTab('sub:s3')
    const s = sidePane.paneSnapshot()
    expect(s.tabs).toHaveLength(0)
    expect(s.activeId).toBe('')
  })

  it('closing an inactive tab keeps the active id', () => {
    sidePane.openPaneTab({ id: 'sub:s1', kind: 'subagent', title: 'one', childId: 's1' })
    sidePane.openPaneTab({ id: 'sub:s2', kind: 'subagent', title: 'two', childId: 's2' })
    sidePane.activatePane('sub:s2')
    sidePane.closePaneTab('sub:s1')
    expect(sidePane.paneSnapshot().activeId).toBe('sub:s2')
  })

  it('reorders tabs without touching the active id', () => {
    sidePane.openPaneTab({ id: 'sub:s1', kind: 'subagent', title: 'one', childId: 's1' })
    sidePane.openPaneTab({ id: 'file:/a', kind: 'file', title: 'a.md', path: '/a', directory: '/w' })
    sidePane.openPaneTab({ id: 'git', kind: 'git', title: 'Git' })
    sidePane.activatePane('git')
    sidePane.reorderPaneTab(2, 0)
    const s = sidePane.paneSnapshot()
    expect(s.tabs.map((t) => t.id)).toEqual(['git', 'sub:s1', 'file:/a'])
    expect(s.activeId).toBe('git')
  })

  it('persists state across a module reload (roundtrip)', async () => {
    sidePane.openPaneTab({ id: 'file:/w/a.md', kind: 'file', title: 'a.md', path: '/w/a.md', directory: '/w' })
    await fresh()
    const s = sidePane.paneSnapshot()
    expect(s.tabs.map((t) => t.id)).toEqual(['file:/w/a.md'])
    expect(s.activeId).toBe('file:/w/a.md')
  })

  it('migrates pinned-era state: activeId on a well-known home reopens that home tab', async () => {
    localStorage.setItem('ocrc.sidePane.v1', JSON.stringify({ tabs: [], activeId: 'tasks' }))
    await fresh()
    const s = sidePane.paneSnapshot()
    expect(s.tabs.map((t) => t.id)).toEqual(['tasks'])
    expect(s.tabs[0].kind).toBe('home')
    expect(s.activeId).toBe('tasks')
  })

  it('caps the tab count, dropping the oldest', async () => {
    for (let i = 0; i < 15; i++) {
      sidePane.openPaneTab({ id: `file:/f${i}`, kind: 'file', title: `f${i}`, path: `/f${i}`, directory: '/w' })
    }
    const s = sidePane.paneSnapshot()
    expect(s.tabs).toHaveLength(12)
    expect(s.tabs[0].id).toBe('file:/f3')
  })

  it('survives corrupted persisted state', async () => {
    localStorage.setItem('ocrc.sidePane.v1', '{not json')
    await fresh()
    const s = sidePane.paneSnapshot()
    expect(s.tabs).toEqual([])
    expect(s.activeId).toBe('')
  })

  it('drops malformed persisted tabs', async () => {
    localStorage.setItem('ocrc.sidePane.v1', JSON.stringify({
      tabs: [{ id: 'sub:x', kind: 'subagent', title: 'ok', childId: 'x' }, { id: 'bad', kind: 'nonsense' }, null],
      activeId: 'sub:x',
    }))
    await fresh()
    const s = sidePane.paneSnapshot()
    expect(s.tabs).toHaveLength(1)
    expect((s.tabs[0] as { childId: string }).childId).toBe('x')
  })
})
