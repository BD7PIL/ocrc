import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/svelte'
import { tick } from 'svelte'
import TaskPanel from './TaskPanel.svelte'
import { api } from '$lib/api/client.js'

vi.mock('$lib/api/client.js', () => ({
  api: {
    todo: vi.fn(),
  },
}))

describe('TaskPanel', () => {
  beforeEach(() => {
    vi.mocked(api.todo).mockReset()
  })

  it('renders the todo summary for the session', async () => {
    vi.mocked(api.todo).mockResolvedValue([
      { content: 'first task', status: 'completed' },
      { content: 'second task', status: 'pending' },
    ])
    const { container } = render(TaskPanel, { props: { sessionId: 's1' } })
    await vi.waitFor(() => expect(container.textContent).toContain('first task'))
    expect(container.textContent).toContain('second task')
    expect(container.textContent).toContain('1/2')
  })

  it('drops a stale response when the session switches mid-load', async () => {
    let resolveS1: (v: any) => void = () => {}
    vi.mocked(api.todo).mockImplementation(((id: string) =>
      id === 's1'
        ? new Promise((r) => { resolveS1 = r })
        : Promise.resolve([{ content: `task-of-${id}`, status: 'pending' }])) as any)
    const { container, rerender } = render(TaskPanel, { props: { sessionId: 's1' } })
    await tick()
    // Switch session before s1's todo request resolves.
    await rerender({ sessionId: 's2' })
    await vi.waitFor(() => expect(container.textContent).toContain('task-of-s2'))
    resolveS1([{ content: 'task-of-s1', status: 'pending' }])
    await tick()
    expect(container.textContent).toContain('task-of-s2')
    expect(container.textContent).not.toContain('task-of-s1')
  })
})
