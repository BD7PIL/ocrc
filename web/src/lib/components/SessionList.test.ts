import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/svelte'
import { tick } from 'svelte'
import SessionList from './SessionList.svelte'
import { sessionList, feeds } from '../stores/sessions.js'
import { connection } from '../stores/connection.js'

vi.mock('$app/navigation', () => ({ goto: vi.fn() }))
vi.mock('../api/client.js', () => ({
  api: { sessions: vi.fn(), renameSession: vi.fn(), deleteSession: vi.fn() },
}))

const session = (id: string, lastActiveAt = Date.now()) => ({
  id,
  title: `Session ${id}`,
  lastActiveAt,
  unread: false,
})

describe('SessionList status derivation', () => {
  beforeEach(() => {
    sessionList.set([])
    feeds.set({})
    connection.set('offline')
  })

  it('exposes a text alternative for the status dot', async () => {
    sessionList.set([session('s1')])
    const { container } = render(SessionList)
    await tick()
    const dot = container.querySelector('.dot')!
    expect(dot.classList.contains('offline')).toBe(true)
    expect(dot.querySelector('.sr-only')?.textContent).toBe('offline')
  })

  it('recomputes status reactively when the feed or connection changes', async () => {
    connection.set('connected')
    sessionList.set([session('s1')])
    const { container } = render(SessionList)
    await tick()
    expect(container.querySelector('.dot')!.classList.contains('idle')).toBe(true)

    // Tail of the live feed becomes a thinking card → busy, without a re-render.
    feeds.set({
      s1: {
        order: ['c1'],
        byId: { c1: { kind: 'thinking', sessionId: 's1', id: 'c1' } as any },
        lastSeq: 0,
      },
    })
    await tick()
    const dot = container.querySelector('.dot')!
    expect(dot.classList.contains('busy')).toBe(true)
    expect(dot.querySelector('.sr-only')?.textContent).toBe('busy')
    expect(container.querySelector('.session')!.classList.contains('busy')).toBe(true)
    expect(container.querySelector('.progress')).not.toBeNull()

    // Feed tail clears → back to idle.
    feeds.set({})
    await tick()
    expect(container.querySelector('.dot')!.classList.contains('idle')).toBe(true)
    expect(container.querySelector('.progress')).toBeNull()
  })
})
