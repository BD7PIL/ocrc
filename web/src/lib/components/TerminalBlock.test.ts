import { describe, it, expect, vi, afterEach } from 'vitest'
import { render } from '@testing-library/svelte'
import { tick } from 'svelte'
import TerminalBlock from './TerminalBlock.svelte'

describe('TerminalBlock', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('renders done output synchronously', () => {
    const { container } = render(TerminalBlock, { props: { text: 'hello', tool: 'bash', status: 'done' } })
    expect(container.querySelector('.term-body')?.textContent).toContain('hello')
  })

  it('coalesces running deltas into one scheduled animation frame', async () => {
    let frame: FrameRequestCallback | null = null
    const raf = vi.fn((cb: FrameRequestCallback) => { frame = cb; return 1 })
    vi.stubGlobal('requestAnimationFrame', raf)
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const { container, rerender } = render(TerminalBlock, { props: { text: 'a', tool: 'bash', status: 'running' } })
    expect(raf).toHaveBeenCalledTimes(1)
    // Nothing applied before the frame fires.
    expect(container.querySelector('.term-body')?.textContent).toBe('')

    await rerender({ text: 'ab', tool: 'bash', status: 'running' })
    await rerender({ text: 'abc', tool: 'bash', status: 'running' })
    // Deltas pile onto the same pending frame instead of re-rendering each time.
    expect(raf).toHaveBeenCalledTimes(1)

    frame!(0)
    await tick()
    expect(container.querySelector('.term-body')?.textContent).toContain('abc')
  })

  it('cancels the pending frame and applies the final output when status leaves running', async () => {
    const cancel = vi.fn()
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 7))
    vi.stubGlobal('cancelAnimationFrame', cancel)

    const { container, rerender } = render(TerminalBlock, { props: { text: 'a', tool: 'bash', status: 'running' } })
    expect(container.querySelector('.term-body')?.textContent).toBe('')

    await rerender({ text: 'ab', tool: 'bash', status: 'done' })
    expect(cancel).toHaveBeenCalledWith(7)
    // Final state is complete without waiting for a frame.
    expect(container.querySelector('.term-body')?.textContent).toContain('ab')
  })
})
