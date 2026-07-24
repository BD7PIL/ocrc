import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/svelte'
import { tick } from 'svelte'
import UsagePanel from './UsagePanel.svelte'
import { api } from '$lib/api/client.js'
import { feeds, upsertCard } from '$lib/stores/sessions.js'

vi.mock('$lib/api/client.js', () => ({
  api: {
    context: vi.fn(),
  },
}))

describe('UsagePanel', () => {
  beforeEach(() => {
    vi.mocked(api.context).mockReset()
    feeds.set({})
  })

  it('drops a stale response when the session switches mid-load', async () => {
    let resolveS1: (v: any) => void = () => {}
    vi.mocked(api.context).mockImplementation(((id: string) =>
      id === 's1'
        ? new Promise((r) => { resolveS1 = r })
        : Promise.resolve({ sessionId: id, tokens: { input: 42, output: 7 } })) as any)
    const { container, rerender } = render(UsagePanel, { props: { sessionId: 's1' } })
    await tick()
    // Switch session before s1's context request resolves.
    await rerender({ sessionId: 's2' })
    await vi.waitFor(() => expect(container.textContent).toContain('42'))
    resolveS1({ sessionId: 's1', tokens: { input: 999999, output: 7 } })
    await tick()
    expect(container.textContent).toContain('42')
    expect(container.textContent).not.toContain('999,999')
  })

  it('sums assistant-card meta only when the context endpoint has no tokens', async () => {
    vi.mocked(api.context).mockResolvedValue({ sessionId: 's1' } as any)
    upsertCard({ kind: 'assistant', sessionId: 's1', blocks: [], meta: { tokens: { input: 1200, output: 300 }, cost: 0.02 }, id: 'a1', seq: 1 })
    upsertCard({ kind: 'assistant', sessionId: 's1', blocks: [], meta: { tokens: { input: 34, output: 6 } }, id: 'a2', seq: 2 })
    const { container } = render(UsagePanel, { props: { sessionId: 's1' } })
    await vi.waitFor(() => expect(container.textContent).toContain('1,234'))
    expect(container.textContent).toContain('306')
    expect(container.textContent).toContain('$0.020')
  })

  it('prefers context tokens over the card-meta fallback', async () => {
    vi.mocked(api.context).mockResolvedValue({ sessionId: 's1', tokens: { input: 42, output: 7 }, cost: 0.5 } as any)
    upsertCard({ kind: 'assistant', sessionId: 's1', blocks: [], meta: { tokens: { input: 1200, output: 300 }, cost: 0.02 }, id: 'a1', seq: 1 })
    const { container } = render(UsagePanel, { props: { sessionId: 's1' } })
    await vi.waitFor(() => expect(container.textContent).toContain('42'))
    expect(container.textContent).not.toContain('1,200')
    expect(container.textContent).toContain('$0.500')
  })
})
