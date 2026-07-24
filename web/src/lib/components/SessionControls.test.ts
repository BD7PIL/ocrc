import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/svelte'
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

const controlsFixture = () => ({
  mode: { current: 'm1', options: [{ id: 'm1', name: 'Build' }] },
  model: { current: 'x', options: [{ id: 'x', name: 'x' }] },
})

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

  it('exposes listbox semantics and aria-expanded on the chip trigger', async () => {
    vi.mocked(api.controls).mockResolvedValue(controlsFixture() as any)
    const { container } = render(SessionControls, { props: { sessionId: 's1' } })
    await vi.waitFor(() => expect(container.textContent).toContain('Build'))
    const chip = container.querySelector('.chip') as HTMLElement
    expect(chip.getAttribute('aria-haspopup')).toBe('listbox')
    expect(chip.getAttribute('aria-expanded')).toBe('false')

    await fireEvent.click(chip)
    expect(chip.getAttribute('aria-expanded')).toBe('true')
    const pop = container.querySelector('.pop')!
    expect(pop.getAttribute('role')).toBe('listbox')
    const option = pop.querySelector('[role="option"]')!
    expect(option.getAttribute('aria-selected')).toBe('true')
  })

  it('closes the popover on Escape', async () => {
    vi.mocked(api.controls).mockResolvedValue(controlsFixture() as any)
    const { container } = render(SessionControls, { props: { sessionId: 's1' } })
    await vi.waitFor(() => expect(container.textContent).toContain('Build'))
    await fireEvent.click(container.querySelector('.chip') as HTMLElement)
    expect(container.querySelector('.pop')).not.toBeNull()
    await fireEvent.keyDown(window, { key: 'Escape' })
    expect(container.querySelector('.pop')).toBeNull()
  })

  it('closes the popover on a click outside the chip', async () => {
    vi.mocked(api.controls).mockResolvedValue(controlsFixture() as any)
    const { container } = render(SessionControls, { props: { sessionId: 's1' } })
    await vi.waitFor(() => expect(container.textContent).toContain('Build'))
    await fireEvent.click(container.querySelector('.chip') as HTMLElement)
    expect(container.querySelector('.pop')).not.toBeNull()
    await fireEvent.click(document.body)
    expect(container.querySelector('.pop')).toBeNull()
  })
})
