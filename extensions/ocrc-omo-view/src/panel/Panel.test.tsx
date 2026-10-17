import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { act } from 'react'
import { makeHost, THEME, type FakeHost } from '../test/host-mock.js'
import { Panel } from './Panel.js'

const held = vi.hoisted(() => ({ host: null as unknown as FakeHost }))
vi.mock('@openchamber/sdk', async (original) => {
  const actual = await original<typeof import('@openchamber/sdk')>()
  return { ...actual, connectHost: () => held.host.client }
})

const PROJECTS = [
  { id: 'p1', name: 'alpha', directory: '/srv/a' },
  { id: 'p2', name: 'beta', directory: '/srv/b' },
]

const SESSIONS = {
  p1: [
    { id: 's1', title: '编排会话', projectId: 'p1', directory: '/srv/a', parentId: null, createdAt: 1, updatedAt: 30, archivedAt: null, worktree: null, activity: 'running' as const, outcome: null, items: [] },
    { id: 's2', title: '探索任务', projectId: 'p1', directory: '/srv/a', parentId: 's1', createdAt: 2, updatedAt: 20, archivedAt: null, worktree: null, activity: 'idle' as const, outcome: 'completed' as const, items: [] },
    { id: 's3', title: '评审任务', projectId: 'p1', directory: '/srv/a', parentId: 's1', createdAt: 3, updatedAt: 10, archivedAt: null, worktree: null, activity: 'idle' as const, outcome: 'failed' as const, items: [] },
  ],
  p2: [
    { id: 't9', title: '另一个项目的编排', projectId: 'p2', directory: '/srv/b', parentId: null, createdAt: 4, updatedAt: 40, archivedAt: null, worktree: null, activity: 'running' as const, outcome: null, items: [] },
    { id: 't10', title: '子任务', projectId: 'p2', directory: '/srv/b', parentId: 't9', createdAt: 5, updatedAt: 5, archivedAt: null, worktree: null, activity: 'idle' as const, outcome: null, items: [] },
  ],
}

beforeEach(() => {
  held.host = makeHost({ projects: PROJECTS, sessions: SESSIONS })
  document.documentElement.removeAttribute('style')
})

describe('Panel — host integration', () => {
  it('paints the host theme onto the document root', async () => {
    render(<Panel />)
    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--surface-background')).toBe('#fdfdfd')
    })
    expect(document.documentElement.dataset.ocTheme).toBe('light')
    expect(THEME.tokens.mono).toBe('ui-monospace, monospace')
  })

  it('follows the project the user switches to', async () => {
    render(<Panel />)
    await waitFor(() => { expect(held.host.subscriptions).toEqual([{ kind: 'sessions', projectId: 'p1' }]) })
    expect(await screen.findByText('编排会话')).toBeTruthy()

    act(() => { held.host.emitDirectory('/srv/b') })

    await waitFor(() => {
      expect(held.host.subscriptions.at(-1)).toEqual({ kind: 'sessions', projectId: 'p2' })
    })
    expect(await screen.findByText('另一个项目的编排')).toBeTruthy()
  })

  it('marks the session an action ran on and opens the root that holds it', async () => {
    render(<Panel />)
    await screen.findByText('编排会话')

    // Collapse first, so the mark is what has to bring the row back.
    act(() => { (screen.getByText('编排会话').closest('button') as HTMLButtonElement).click() })
    await waitFor(() => { expect(screen.queryByText('探索任务')).toBeNull() })

    act(() => {
      held.host.emitItem({
        kind: 'session',
        action: 'ocrc-omo-inspect',
        sessionId: 's2',
        sessionTitle: '探索任务',
        directory: '/srv/a',
      })
    })

    const row = (await screen.findByText('探索任务')).closest('.oc-sdk-row') as HTMLElement
    expect(row.getAttribute('aria-selected')).toBe('true')
  })

  it('shows the orchestration expanded, and collapses on demand', async () => {
    render(<Panel />)
    // The tree is the point of this panel: it arrives open.
    expect(await screen.findByText('探索任务')).toBeTruthy()
    expect(screen.getByText('评审任务')).toBeTruthy()

    act(() => { (screen.getByText('编排会话').closest('button') as HTMLButtonElement).click() })
    await waitFor(() => { expect(screen.queryByText('探索任务')).toBeNull() })
  })

  it('renders tree rows as real buttons and opens a session on click', async () => {
    render(<Panel />)
    await screen.findByText('探索任务')

    const child = screen.getByText('探索任务').closest('button') as HTMLButtonElement
    expect(child).toBeTruthy()
    act(() => { child.click() })
    await waitFor(() => { expect(held.host.opened).toEqual(['s2']) })
  })

  it('reads activity and outcome from the sessions snapshot as badges', async () => {
    render(<Panel />)
    await screen.findByText('探索任务')

    const failed = (screen.getByText('评审任务').closest('.oc-sdk-row') as HTMLElement)
    expect(within(failed).getByText('失败').dataset.tone).toBe('error')
    const ok = (screen.getByText('探索任务').closest('.oc-sdk-row') as HTMLElement)
    expect(within(ok).getByText('已完成').dataset.tone).toBe('info')
  })

  it('says so when the project has no orchestration yet', async () => {
    held.host = makeHost({ projects: [{ id: 'p1', name: 'alpha', directory: '/srv/a' }], sessions: { p1: [] } })
    render(<Panel />)
    expect(await screen.findByText('本项目暂无会话')).toBeTruthy()
  })
})
