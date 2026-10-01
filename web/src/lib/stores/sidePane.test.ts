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

  it('opens a tab idempotently — same id activates in place, no duplicate', () => {
    const tab = { id: 'sub:s1', kind: 'subagent' as const, title: 'researcher', childId: 's1' }
    sidePane.openPaneTab(tab)
    sidePane.openPaneTab({ ...tab, title: 'renamed' })
    const s = sidePane.paneSnapshot()
    expect(s.tabs).toHaveLength(1)
    expect(s.activeId).toBe('sub:s1')
    expect(s.tabs[0].title).toBe('renamed')
  })

  it('activates without adding when a pinned id is activated', () => {
    sidePane.openPaneTab({ id: 'file:/a.md', kind: 'file', title: 'a.md', path: '/a.md', directory: '/w' })
    sidePane.activatePinned('tasks')
    const s = sidePane.paneSnapshot()
    expect(s.tabs).toHaveLength(1)
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
    // closing the last dynamic tab falls back to a pinned default
    sidePane.closePaneTab('sub:s3')
    expect(sidePane.paneSnapshot().activeId).toBe('tasks')
    expect(sidePane.paneSnapshot().tabs).toHaveLength(0)
  })

  it('closing an inactive tab keeps the active id', () => {
    sidePane.openPaneTab({ id: 'sub:s1', kind: 'subagent', title: 'one', childId: 's1' })
    sidePane.openPaneTab({ id: 'sub:s2', kind: 'subagent', title: 'two', childId: 's2' })
    sidePane.activatePane('sub:s2')
    sidePane.closePaneTab('sub:s1')
    expect(sidePane.paneSnapshot().activeId).toBe('sub:s2')
  })

  it('persists state across a module reload (roundtrip)', async () => {
    sidePane.openPaneTab({ id: 'file:/w/a.md', kind: 'file', title: 'a.md', path: '/w/a.md', directory: '/w' })
    await fresh()
    const s = sidePane.paneSnapshot()
    expect(s.tabs.map((t) => t.id)).toEqual(['file:/w/a.md'])
    expect(s.activeId).toBe('file:/w/a.md')
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
    expect(s.activeId).toBe('tasks')
  })

  it('drops malformed persisted tabs', async () => {
    localStorage.setItem('ocrc.sidePane.v1', JSON.stringify({
      tabs: [{ id: 'sub:x', kind: 'subagent', title: 'ok', childId: 'x' }, { id: 'bad', kind: 'nonsense' }, null],
      activeId: 'sub:x',
    }))
    await fresh()
    const s = sidePane.paneSnapshot()
    expect(s.tabs).toHaveLength(1)
    expect(s.tabs[0].childId).toBe('x')
  })
})
