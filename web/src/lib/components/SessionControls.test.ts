import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/svelte'
import { tick } from 'svelte'
import SessionControls from './SessionControls.svelte'
import { api } from '$lib/api/client.js'

vi.mock('$lib/api/client.js', () => ({
  api: {
    controls: vi.fn(),
    setMode: vi.fn(),
    setModel: vi.fn(),
  },
}))

describe('SessionControls', () => {
  beforeEach(() => {
    vi.mocked(api.controls).mockReset()
  })

  it('drops a stale response when the session switches mid-load', async () => {
    let resolveS1: (v: any) => void = () => {}
    const controlsFor = (name: string) => ({
      mode: { current: 'm1', options: [{ id: 'm1', name }] },
      model: { current: 'x', options: [{ id: 'x', name: 'x' }] },
    })
    vi.mocked(api.controls).mockImplementation(((id: string) =>
      id === 's1'
        ? new Promise((r) => { resolveS1 = r })
        : Promise.resolve(controlsFor(`mode-of-${id}`))) as any)
    const { container, rerender } = render(SessionControls, { props: { sessionId: 's1' } })
    await tick()
    // Switch session before s1's controls request resolves.
    await rerender({ sessionId: 's2' })
    await vi.waitFor(() => expect(container.textContent).toContain('mode-of-s2'))
    resolveS1(controlsFor('mode-of-s1'))
    await tick()
    expect(container.textContent).toContain('mode-of-s2')
    expect(container.textContent).not.toContain('mode-of-s1')
  })
})
