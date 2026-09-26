import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/svelte'
import PlanHud from './PlanHud.svelte'
import { api } from '$lib/api/client.js'
import { feeds } from '$lib/stores/sessions.js'

vi.mock('$lib/api/client.js', () => ({
  api: {
    todo: vi.fn(),
    subagents: vi.fn(),
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
    vi.mocked(api.subagents).mockReset?.()
    vi.mocked(api.subagents).mockResolvedValue({ subagents: [] })
    localStorage.removeItem('ocrc.planHud')
  })
  afterEach(cleanup)

  it('renders nothing when the session has no todos', async () => {
    vi.mocked(api.todo).mockResolvedValue([])
    const { container } = render(PlanHud, { props: { sessionId: 's-empty' } })
    await vi.waitFor(() => expect(vi.mocked(api.todo)).toHaveBeenCalledWith('s-empty'))
    expect(container.querySelector('.ball')).toBeNull()
  })

  it('shows the progress orb and expands to grouped items on tap', async () => {
    vi.mocked(api.todo).mockResolvedValue(TODOS)
    const { container } = render(PlanHud, { props: { sessionId: 's-groups' } })
    await vi.waitFor(() => expect(container.querySelector('.ball')).toBeTruthy())
    // Orb shows the done/total count and the progress arc.
    expect(container.textContent).toContain('1')
    expect(container.querySelector('.arc')!.getAttribute('stroke-dashoffset')).toBeTruthy()
    // Expanded card is closed while the orb shows.
    expect(container.querySelector('.plan-card')).toBeNull()

    await fireEvent.click(container.querySelector('.ball')!)
    const card = container.querySelector('.plan-card')!
    expect(card).toBeTruthy()
    expect(card.textContent).toContain('active task')
    expect(card.textContent).toContain('Completed 1')
    // Only the first 2 pending are previewed — the rest collapse into a group.
    expect(card.textContent).toContain('queued task one')
    expect(card.textContent).toContain('queued task two')
    expect(card.textContent).not.toContain('queued task three')
    expect(card.textContent).toContain('Pending 1')
  })

  it('lists subagent progress inside the expanded card', async () => {
    vi.mocked(api.todo).mockResolvedValue(TODOS)
    vi.mocked(api.subagents).mockResolvedValue({
      subagents: [{ id: 'sub_1', title: 'researcher', done: 2, total: 3 }],
    })
    const { container } = render(PlanHud, { props: { sessionId: 's-subs' } })
    await vi.waitFor(() => expect(container.querySelector('.ball')).toBeTruthy())

    await fireEvent.click(container.querySelector('.ball')!) // expand → fetches subagents
    await vi.waitFor(() => expect(container.textContent).toContain('researcher'))
    expect(container.textContent).toContain('2/3')
    expect(vi.mocked(api.subagents)).toHaveBeenCalledWith('s-subs')
  })

  it('hides via the ⋯ menu and persists the dismissal per session', async () => {
    vi.mocked(api.todo).mockResolvedValue(TODOS)
    const { container } = render(PlanHud, { props: { sessionId: 's-hide' } })
    await vi.waitFor(() => expect(container.querySelector('.ball')).toBeTruthy())

    await fireEvent.click(container.querySelector('.ball')!) // expand to reveal the card menu
    await fireEvent.click(container.querySelector('.dots')!)
    const hide = [...container.querySelectorAll('.menu button')].find((b) => b.textContent === 'Hide for this session')!
    await fireEvent.click(hide)
    expect(container.querySelector('.ball')).toBeNull()
    expect(container.querySelector('.plan-card')).toBeNull()

    const stored = JSON.parse(localStorage.getItem('ocrc.planHud') ?? '{}')
    expect(stored.dismissed).toContain('s-hide')
  })

  it('re-pulls todos when the session feed produces events', async () => {
    vi.mocked(api.todo).mockResolvedValue(TODOS)
    const { container } = render(PlanHud, { props: { sessionId: 's-feed' } })
    await vi.waitFor(() => expect(container.querySelector('.ball')).toBeTruthy())
    const callsFor = (sid: string) => vi.mocked(api.todo).mock.calls.filter(([id]) => id === sid).length
    expect(callsFor('s-feed')).toBe(1)

    // Any feed event schedules a debounced re-pull (~1s, like the Inspector).
    feeds.update((f) => ({ ...f, 's-feed': { ...((f as any)['s-feed'] ?? {}), lastSeq: 42 } }))
    await vi.waitFor(() => expect(callsFor('s-feed')).toBeGreaterThanOrEqual(2), { timeout: 3000 })
  })
})
