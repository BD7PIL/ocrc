import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/svelte'
import PlanHud from './PlanHud.svelte'
import { api } from '$lib/api/client.js'
import { feeds } from '$lib/stores/sessions.js'

vi.mock('$lib/api/client.js', () => ({
  api: {
    todo: vi.fn(),
  },
}))

// 1 done + 1 running + 3 pending — enough pending to exercise the preview cap.
const TODOS = [
  { content: 'finished task', status: 'completed' },
  { content: 'active task', status: 'in_progress' },
  { content: 'queued task one', status: 'pending' },
  { content: 'queued task two', status: 'pending' },
  { content: 'queued task three', status: 'pending' },
]

describe('PlanHud', () => {
  beforeEach(() => {
    cleanup() // no vitest globals → testing-library doesn't auto-clean
    vi.mocked(api.todo).mockReset()
    localStorage.removeItem('ocrc.planHud')
  })
  afterEach(cleanup)

  it('renders nothing when the session has no todos', async () => {
    vi.mocked(api.todo).mockResolvedValue([])
    const { container } = render(PlanHud, { props: { sessionId: 's-empty' } })
    await vi.waitFor(() => expect(vi.mocked(api.todo)).toHaveBeenCalledWith('s-empty'))
    expect(container.querySelector('.plan-hud')).toBeNull()
  })

  it('shows the collapsed progress card and expands to grouped items on tap', async () => {
    vi.mocked(api.todo).mockResolvedValue(TODOS)
    const { container } = render(PlanHud, { props: { sessionId: 's-groups' } })
    await vi.waitFor(() => expect(container.querySelector('.plan-hud')).toBeTruthy())
    // Collapsed: one-line progress, no task bodies.
    expect(container.textContent).toContain('1/5')
    expect(container.textContent).not.toContain('finished task')

    await fireEvent.click(container.querySelector('.hd')!)
    expect(container.querySelector('.plan-hud')!.classList.contains('expanded')).toBe(true)
    expect(container.textContent).toContain('active task')
    expect(container.textContent).toContain('Completed 1')
    // Only the first 2 pending are previewed — the rest collapse into a group.
    expect(container.textContent).toContain('queued task one')
    expect(container.textContent).toContain('queued task two')
    expect(container.textContent).not.toContain('queued task three')
    expect(container.textContent).toContain('Pending 1')
  })

  it('hides via the ⋯ menu and persists the dismissal per session', async () => {
    vi.mocked(api.todo).mockResolvedValue(TODOS)
    const { container } = render(PlanHud, { props: { sessionId: 's-hide' } })
    await vi.waitFor(() => expect(container.querySelector('.plan-hud')).toBeTruthy())

    await fireEvent.click(container.querySelector('.dots')!)
    const hide = [...container.querySelectorAll('.menu button')].find((b) => b.textContent === 'Hide for this session')!
    await fireEvent.click(hide)
    expect(container.querySelector('.plan-hud')).toBeNull()

    const stored = JSON.parse(localStorage.getItem('ocrc.planHud') ?? '{}')
    expect(stored.dismissed).toContain('s-hide')
  })

  it('re-pulls todos when the session feed produces events', async () => {
    vi.mocked(api.todo).mockResolvedValue(TODOS)
    const { container } = render(PlanHud, { props: { sessionId: 's-feed' } })
    await vi.waitFor(() => expect(container.querySelector('.plan-hud')).toBeTruthy())
    const callsFor = (sid: string) => vi.mocked(api.todo).mock.calls.filter(([id]) => id === sid).length
    expect(callsFor('s-feed')).toBe(1)

    // Any feed event schedules a debounced re-pull (~1s, like the Inspector).
    feeds.update((f) => ({ ...f, 's-feed': { ...((f as any)['s-feed'] ?? {}), lastSeq: 42 } }))
    await vi.waitFor(() => expect(callsFor('s-feed')).toBeGreaterThanOrEqual(2), { timeout: 3000 })
  })
})
