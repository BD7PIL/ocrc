import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/svelte'
import CardStreaming from './CardStreaming.svelte'
import type { ExtractStructuredCard } from '../api/types.js'

type StreamingCard = ExtractStructuredCard<'streaming'>

const card = (blocks: StreamingCard['blocks']): StreamingCard =>
  ({ kind: 'streaming', sessionId: 's1', blocks, id: 'turn1', seq: 1 })

describe('CardStreaming', () => {
  it('renders blocks in true order — text and tools interleave (no tools-on-top)', async () => {
    const { container } = render(CardStreaming, {
      props: {
        card: card([
          { type: 'text', text: 'First I will check the directory.' },
          { type: 'tool', tool: 'bash', args: 'ls', status: 'done' },
          { type: 'text', text: 'Now the file contents say:' },
          { type: 'tool', tool: 'read', args: 'a.md', status: 'running' },
        ]),
      },
    })

    const order = [...container.querySelectorAll('.text, .execution')].map(
      (el) => el.classList.contains('text') ? 'text' : 'tools',
    )
    expect(order).toEqual(['text', 'tools', 'text', 'tools'])
    // Streaming markdown parses on a 45ms throttle — wait for the text lands.
    await vi.waitFor(() => {
      expect(container.textContent).toContain('First I will check the directory.')
      expect(container.textContent).toContain('Now the file contents say:')
    })
  })

  it('renders live reasoning as a collapsed block that pulses only at the frontier', async () => {
    const live = render(CardStreaming, {
      props: { card: card([{ type: 'reasoning', text: 'thinking hard' }]) },
    })
    expect(live.container.textContent).toContain('思考中')
    expect(live.container.querySelector('.think-dot')).toBeTruthy()
    expect(live.container.textContent).not.toContain('thinking hard') // collapsed

    // A following text segment means the thought is finished — no pulse.
    const done = render(CardStreaming, {
      props: { card: card([{ type: 'reasoning', text: 'old thought' }, { type: 'text', text: 'Answer' }]) },
    })
    expect(done.container.textContent).toContain('思考过程')
    expect(done.container.querySelector('.think-dot')).toBeNull()
  })
})
