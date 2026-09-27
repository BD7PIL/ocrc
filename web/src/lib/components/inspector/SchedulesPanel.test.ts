import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/svelte'
import SchedulesPanel from './SchedulesPanel.svelte'
import { api, type ScheduleRow } from '$lib/api/client.js'

vi.mock('$lib/api/client.js', () => ({
  api: {
    schedules: vi.fn(),
    addSchedule: vi.fn(),
    setScheduleEnabled: vi.fn(),
    deleteSchedule: vi.fn(),
  },
}))

const ROWS: ScheduleRow[] = [
  { id: 'sc1', name: '', prompt: 'nightly checks', spec: { kind: 'every', minutes: 15 }, enabled: true, createdAt: 1 },
  { id: 'sc2', name: 'standup', prompt: 'write the standup summary', spec: { kind: 'daily', time: '09:00' }, enabled: false, createdAt: 2 },
]

describe('SchedulesPanel', () => {
  beforeEach(() => {
    cleanup()
    vi.mocked(api.schedules).mockReset()
    vi.mocked(api.schedules).mockResolvedValue({ schedules: ROWS })
  })

  it('lists schedules with spec labels and enabled state', async () => {
    const { container } = render(SchedulesPanel)
    await vi.waitFor(() => expect(container.textContent).toContain('nightly checks'))
    expect(container.textContent).toContain('every 15m')
    expect(container.textContent).toContain('daily 09:00')
    expect(container.textContent).toContain('standup')
    expect(container.querySelector('.row.off')).toBeTruthy()
  })

  it('toggles a schedule via the switch (optimistic, then server reload)', async () => {
    vi.mocked(api.setScheduleEnabled).mockResolvedValue({})
    const { container } = render(SchedulesPanel)
    await vi.waitFor(() => expect(container.textContent).toContain('nightly checks'))

    await fireEvent.click(container.querySelector('.switch')!)
    expect(vi.mocked(api.setScheduleEnabled)).toHaveBeenCalledWith('sc1', false)
    await vi.waitFor(() => expect(vi.mocked(api.schedules)).toHaveBeenCalledTimes(2))
  })

  it('creates a schedule from the inline form', async () => {
    vi.mocked(api.addSchedule).mockResolvedValue({})
    const { container, getByLabelText } = render(SchedulesPanel)
    await vi.waitFor(() => expect(container.textContent).toContain('nightly checks'))

    await fireEvent.click(getByLabelText('新建计划'))
    const ta = container.querySelector('.prompt-in') as HTMLTextAreaElement
    ta.value = 'hourly sweep'
    await fireEvent.input(ta)
    const num = container.querySelector('.num') as HTMLInputElement
    num.value = '60'
    await fireEvent.input(num)

    await fireEvent.click(container.querySelector('.go')!)
    await vi.waitFor(() =>
      expect(vi.mocked(api.addSchedule)).toHaveBeenCalledWith({ prompt: 'hourly sweep', spec: { kind: 'every', minutes: 60 } }),
    )
  })

  it('requires a second click (armed state) before deleting', async () => {
    vi.mocked(api.deleteSchedule).mockResolvedValue({ ok: true })
    const { container } = render(SchedulesPanel)
    await vi.waitFor(() => expect(container.textContent).toContain('nightly checks'))

    const del = container.querySelector('.del')!
    await fireEvent.click(del)
    expect(vi.mocked(api.deleteSchedule)).not.toHaveBeenCalled()
    expect(del.textContent).toBe('确认?')

    await fireEvent.click(del)
    expect(vi.mocked(api.deleteSchedule)).toHaveBeenCalledWith('sc1')
  })
})
