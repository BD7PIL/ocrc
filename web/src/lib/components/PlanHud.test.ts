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
    localStorage.removeItem('ocrc.planHud.v3')
    sessionStorage.clear()
    // jsdom's matchMedia reports desktop widths — pin the MOBILE form (orb)
    // for these tests; the desktop bar/window gets its own coverage.
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: false,
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    cleanup()
  })

  it('renders nothing when the session has no todos', async () => {
    vi.mocked(api.todo).mockResolvedValue([])
    const { container } = render(PlanHud, { props: { sessionId: 's-empty' } })
    await vi.waitFor(() => expect(vi.mocked(api.todo)).toHaveBeenCalledWith('s-empty'))
    expect(container.querySelector('.ball')).toBeNull()
  })

  it('shows the enso orb and expands to grouped items on tap', async () => {
    vi.mocked(api.todo).mockResolvedValue(TODOS)
    const { container } = render(PlanHud, { props: { sessionId: 's-groups' } })
    await vi.waitFor(() => expect(container.querySelector('.ball')).toBeTruthy())
    // The ring: dim full track + the accent progress arc.
    expect(container.querySelector('.track')).toBeTruthy()
    expect(container.querySelector('.arc')!.getAttribute('stroke-dasharray')).toMatch(/^[\d.]+ /)
    // Expanded card is closed while the orb shows.
    expect(container.querySelector('.plan-card')).toBeNull()

    await fireEvent.click(container.querySelector('.ball')!)
    const card = container.querySelector('.plan-card')!
    expect(card).toBeTruthy()
    expect(card.textContent).toContain('active task')
    expect(card.textContent).toContain('已完成 1')
    // Small plans stay flat: all 3 pending are inline, no remainder group.
    expect(card.textContent).toContain('queued task one')
    expect(card.textContent).toContain('queued task two')
    expect(card.textContent).toContain('queued task three')
    expect(card.textContent).not.toContain('待处理 1')
  })

  it('auto-collapses when tapping outside the card and orb', async () => {
    vi.mocked(api.todo).mockResolvedValue(TODOS)
    const { container } = render(PlanHud, { props: { sessionId: 's-auto' } })
    await vi.waitFor(() => expect(container.querySelector('.ball')).toBeTruthy())
    await fireEvent.click(container.querySelector('.ball')!)
    expect(container.querySelector('.plan-card')).toBeTruthy()

    // A tap on the page (outside card + orb) collapses the card…
    await fireEvent.pointerDown(document.body)
    expect(container.querySelector('.plan-card')).toBeNull()
    // …and the collapse is persisted.
    const stored = JSON.parse(localStorage.getItem('ocrc.planHud.v3') ?? '{}')
    expect(stored.expanded).toBe(false)
  })

  it('lists subagent progress and jumps into a child on tap', async () => {
    vi.mocked(api.todo).mockResolvedValue(TODOS)
    vi.mocked(api.subagents).mockResolvedValue({
      subagents: [{ id: 'sub_abc123', title: 'researcher', done: 2, total: 3 }],
    })
    const jumps: string[] = []
    const { container } = render(PlanHud, {
      props: { sessionId: 's-subs', onJump: (id: string) => jumps.push(id) },
    })
    await vi.waitFor(() => expect(container.querySelector('.ball')).toBeTruthy())

    await fireEvent.click(container.querySelector('.ball')!) // expand → fetches subagents
    await vi.waitFor(() => expect(container.textContent).toContain('researcher'))
    expect(container.textContent).toContain('2/3')

    await fireEvent.click(container.querySelector('.row.sub.jump')!)
    expect(jumps).toEqual(['sub_abc123'])
    // Parent stashed so the child card can offer the way back.
    expect(sessionStorage.getItem('ocrc.subparent.sub_abc123')).toBe('s-subs')
  })

  it('offers the parent breadcrumb on a child session and jumps back', async () => {
    sessionStorage.setItem('ocrc.subparent.s-child', 's-parent')
    vi.mocked(api.todo).mockResolvedValue([]) // child has no todos of its own
    const jumps: string[] = []
    const { container } = render(PlanHud, {
      props: { sessionId: 's-child', onJump: (id: string) => jumps.push(id) },
    })
    // The orb renders even without todos — the breadcrumb needs an exit.
    await vi.waitFor(() => expect(container.querySelector('.ball')).toBeTruthy())

    await fireEvent.click(container.querySelector('.ball')!)
    expect(container.querySelector('.plan-card')!.textContent).toContain('返回父会话')

    await fireEvent.click(container.querySelector('.crumb')!)
    expect(jumps).toEqual(['s-parent'])
  })

  it('hides via the ⋯ menu and persists the dismissal per session', async () => {
    vi.mocked(api.todo).mockResolvedValue(TODOS)
    const { container } = render(PlanHud, { props: { sessionId: 's-hide' } })
    await vi.waitFor(() => expect(container.querySelector('.ball')).toBeTruthy())

    await fireEvent.click(container.querySelector('.ball')!) // expand to reveal the card menu
    await fireEvent.click(container.querySelector('.dots')!)
    const hide = [...container.querySelectorAll('.menu button')].find((b) => b.textContent === '本会话隐藏')!
    await fireEvent.click(hide)
    // Hidden = the window disappears; a quiet ghost chip remains as the
    // re-open affordance (dismissals are no longer dead ends).
    expect(container.querySelector('.plan-card')).toBeNull()
    expect(container.querySelector('.ball')).toBeNull()
    expect(container.querySelector('.ghost')).toBeTruthy()

    const stored = JSON.parse(localStorage.getItem('ocrc.planHud.v3') ?? '{}')
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
