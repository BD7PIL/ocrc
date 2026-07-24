import { describe, it, expect } from 'vitest'
import { render, fireEvent } from '@testing-library/svelte'
import { tick } from 'svelte'
import ToolCallList from './ToolCallList.svelte'
import TerminalBlock from './TerminalBlock.svelte'

describe('ToolCallList terminal rendering', () => {
  it('renders short single-line args inline, no terminal block', () => {
    const { container } = render(ToolCallList, {
      props: { tools: [{ tool: 'read', args: 'src/foo.ts', status: 'done' }] },
    })
    expect(container.querySelector('.term')).toBeNull()
    expect(container.querySelector('.row .arg')?.textContent).toBe('src/foo.ts')
  })

  it('renders multi-line args as a terminal block with header glyph and name', () => {
    const { container } = render(ToolCallList, {
      props: { tools: [{ tool: 'bash', args: 'line1\nline2', status: 'done' }] },
    })
    const term = container.querySelector('.term.done')
    expect(term).not.toBeNull()
    expect(term!.querySelector('.glyph')?.textContent).toBe('✓')
    expect(term!.querySelector('.tname')?.textContent).toBe('bash')
    expect(term!.querySelector('.term-body')?.textContent).toContain('line1')
  })

  it('shows ● for running and ✗ for error', () => {
    const { container } = render(ToolCallList, {
      props: {
        tools: [
          { tool: 'bash', args: 'a\nb', status: 'running' },
          { tool: 'bash', args: 'c\nd', status: 'error' },
        ],
      },
    })
    const glyphs = [...container.querySelectorAll('.term .glyph')].map((g) => g.textContent)
    expect(glyphs).toEqual(['●', '✗'])
  })

  it('renders long single-line args (>100 chars) as a terminal block', () => {
    const { container } = render(ToolCallList, {
      props: { tools: [{ tool: 'bash', args: 'x'.repeat(120), status: 'done' }] },
    })
    expect(container.querySelector('.term')).not.toBeNull()
  })

  it('keeps an entry long once it crossed the threshold (no inline↔terminal flip)', async () => {
    const { container, rerender } = render(ToolCallList, {
      props: { tools: [{ tool: 'bash', args: 'short', status: 'running' }] },
    })
    expect(container.querySelector('.term')).toBeNull()
    // Streaming args grow past the threshold → terminal block.
    await rerender({ tools: [{ tool: 'bash', args: 'x'.repeat(120), status: 'running' }] })
    expect(container.querySelector('.term')).not.toBeNull()
    // Args shrink again → stays a terminal block (hysteresis, no layout jump).
    await rerender({ tools: [{ tool: 'bash', args: 'short again', status: 'running' }] })
    expect(container.querySelector('.term')).not.toBeNull()
  })
})

describe('TerminalBlock', () => {
  it('converts ANSI SGR colors to spans, no raw escape noise', () => {
    const { container } = render(TerminalBlock, {
      props: { text: '\x1b[31mred\x1b[0m plain', status: 'done' },
    })
    const body = container.querySelector('.term-body')!
    expect(body.textContent).toBe('red plain')
    expect(body.innerHTML).not.toContain('\x1b')
    expect(body.querySelector('span')?.getAttribute('style')).toContain('color:')
  })

  it('collapses output longer than 20 lines behind a show-more toggle', async () => {
    const text = Array.from({ length: 25 }, (_, i) => `line${i + 1}`).join('\n')
    const { container } = render(TerminalBlock, { props: { text, status: 'done' } })
    const body = container.querySelector('.term-body')!
    expect(body.textContent).toContain('line20')
    expect(body.textContent).not.toContain('line21')
    const toggle = container.querySelector('.toggle')!
    expect(toggle.textContent).toContain('5 more lines')
    await fireEvent.click(toggle)
    expect(container.querySelector('.term-body')!.textContent).toContain('line25')
    expect(container.querySelector('.toggle')!.textContent).toContain('show less')
  })

  it('does not offer a toggle for short output', () => {
    const { container } = render(TerminalBlock, { props: { text: 'a\nb', status: 'done' } })
    expect(container.querySelector('.toggle')).toBeNull()
  })

  it('shows full output while running (no collapse, no toggle)', async () => {
    const text = Array.from({ length: 25 }, (_, i) => `line${i + 1}`).join('\n')
    const { container } = render(TerminalBlock, { props: { text, status: 'running' } })
    // Running output is throttled to the next animation frame — flush it.
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    await tick()
    expect(container.querySelector('.term-body')!.textContent).toContain('line25')
    expect(container.querySelector('.toggle')).toBeNull()
  })

  it('collapses once the tool finishes (toggle reappears)', async () => {
    const text = Array.from({ length: 25 }, (_, i) => `line${i + 1}`).join('\n')
    const { container, rerender } = render(TerminalBlock, { props: { text, status: 'running' } })
    await rerender({ text, status: 'done' })
    expect(container.querySelector('.term-body')!.textContent).not.toContain('line25')
    expect(container.querySelector('.toggle')).not.toBeNull()
  })
})
