import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/svelte'
import { tick } from 'svelte'
import UsagePanel from './UsagePanel.svelte'
import { api } from '$lib/api/client.js'

vi.mock('$lib/api/client.js', () => ({
  api: {
    context: vi.fn(),
  },
}))

describe('UsagePanel', () => {
  beforeEach(() => {
    vi.mocked(api.context).mockReset()
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
})
