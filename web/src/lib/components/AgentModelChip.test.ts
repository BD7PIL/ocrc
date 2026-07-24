import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/svelte'
import AgentModelChip from './AgentModelChip.svelte'
import { api } from '$lib/api/client.js'

vi.mock('$lib/api/client.js', () => ({
  api: {
    agents: vi.fn(),
    getOverrides: vi.fn(),
    setOverrides: vi.fn(),
  },
}))

describe('AgentModelChip', () => {
  beforeEach(() => {
    vi.mocked(api.agents).mockReset().mockResolvedValue([{ name: 'build', model: 'openai/gpt-5' }] as any)
    vi.mocked(api.getOverrides).mockReset().mockResolvedValue({ agent: null, model: null } as any)
  })

  it('exposes listbox semantics and aria-expanded on the chip trigger', async () => {
    const { container } = render(AgentModelChip)
    const chip = container.querySelector('.chip') as HTMLElement
    expect(chip.getAttribute('aria-haspopup')).toBe('listbox')
    expect(chip.getAttribute('aria-expanded')).toBe('false')

    await fireEvent.click(chip)
    expect(chip.getAttribute('aria-expanded')).toBe('true')
    await vi.waitFor(() => expect(container.textContent).toContain('build'))
    const pop = container.querySelector('.pop')!
    expect(pop.getAttribute('role')).toBe('listbox')
    expect(pop.querySelectorAll('[role="option"]').length).toBeGreaterThan(0)
  })

  it('closes the popover on Escape', async () => {
    const { container } = render(AgentModelChip)
    await fireEvent.click(container.querySelector('.chip') as HTMLElement)
    expect(container.querySelector('.pop')).not.toBeNull()
    await fireEvent.keyDown(window, { key: 'Escape' })
    expect(container.querySelector('.pop')).toBeNull()
  })

  it('closes the popover on a click outside the chip', async () => {
    const { container } = render(AgentModelChip)
    await fireEvent.click(container.querySelector('.chip') as HTMLElement)
    expect(container.querySelector('.pop')).not.toBeNull()
    await fireEvent.click(document.body)
    expect(container.querySelector('.pop')).toBeNull()
  })

  it('keeps the popover open on a click inside it', async () => {
    const { container } = render(AgentModelChip)
    await fireEvent.click(container.querySelector('.chip') as HTMLElement)
    await vi.waitFor(() => expect(container.textContent).toContain('build'))
    // Clicking the popover background (not an option) must not dismiss it.
    await fireEvent.click(container.querySelector('.pop') as HTMLElement)
    expect(container.querySelector('.pop')).not.toBeNull()
  })
})
