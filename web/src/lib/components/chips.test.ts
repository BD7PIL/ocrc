import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/svelte'
import AgentChip from './AgentChip.svelte'
import ModelChip from './ModelChip.svelte'
import { api } from '$lib/api/client.js'

vi.mock('$lib/api/client.js', () => ({
  api: {
    agents: vi.fn(),
    models: vi.fn(),
    getOverrides: vi.fn(),
    setOverrides: vi.fn(),
  },
}))

describe('AgentChip / ModelChip — two separate pickers', () => {
  beforeEach(() => {
    vi.mocked(api.agents).mockReset().mockResolvedValue([{ name: 'build', model: 'openai/gpt-5' }] as any)
    vi.mocked(api.models).mockReset().mockResolvedValue([
      { id: 'xiaomi', name: 'xiaomi', models: [{ id: 'mimo-v2.6-pro', name: 'MiMo-V2.6-Pro' }] },
    ] as any)
    vi.mocked(api.getOverrides).mockReset().mockResolvedValue({ agent: null, model: null } as any)
    vi.mocked(api.setOverrides).mockReset().mockResolvedValue({ ok: true } as any)
  })

  it('agent chip posts agent-only overrides', async () => {
    const { container } = render(AgentChip)
    await fireEvent.click(container.querySelector('.chip')!)
    await vi.waitFor(() => expect(container.textContent).toContain('build'))
    const row = [...container.querySelectorAll('[role="option"]')].find((b) => b.textContent?.includes('build')) as HTMLElement
    await fireEvent.click(row)
    await vi.waitFor(() => expect(vi.mocked(api.setOverrides)).toHaveBeenCalledWith({ agent: 'build' }))
  })

  it('model chip posts model-only overrides', async () => {
    const { container } = render(ModelChip)
    await fireEvent.click(container.querySelector('.chip')!)
    await vi.waitFor(() => expect(container.textContent).toContain('MiMo-V2.6-Pro'))
    const row = [...container.querySelectorAll('[role="option"]')].find((b) => b.textContent?.includes('MiMo-V2.6-Pro')) as HTMLElement
    await fireEvent.click(row)
    await vi.waitFor(() =>
      expect(vi.mocked(api.setOverrides)).toHaveBeenCalledWith({ model: { providerID: 'xiaomi', modelID: 'mimo-v2.6-pro' } }),
    )
  })

  it('chips stay distinct: neither renders the other section', async () => {
    const a = render(AgentChip)
    await fireEvent.click(a.container.querySelector('.chip')!)
    await vi.waitFor(() => expect(a.container.textContent).toContain('build'))
    expect(a.container.textContent).not.toContain('MiMo-V2.6-Pro')

    const m = render(ModelChip)
    await fireEvent.click(m.container.querySelector('.chip')!)
    await vi.waitFor(() => expect(m.container.textContent).toContain('MiMo-V2.6-Pro'))
    expect(m.container.textContent).not.toContain('build')
  })
})
