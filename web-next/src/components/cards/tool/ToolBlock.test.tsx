// ToolBlock component tests — synthetic JSON args (live-stream shape).
// History-reconstructed blocks carry summary text and fall back to the
// generic row; the specialized cards below render only from JSON args.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { ToolBlock } from './ToolBlock.js'

afterEach(cleanup)

// lucide-react resolves its dev/source condition under vitest and blows up on
// context; the icons are irrelevant to these assertions.
vi.mock('lucide-react', () => ({
  CheckCircle2: () => null,
  Circle: () => null,
  CircleDot: () => null,
  FileDiff: () => null,
  TerminalSquare: () => null,
}))

const block = (tool: string, args: string) =>
  ({ type: 'tool', tool, args, status: 'done' }) as any

describe('ToolBlock', () => {
  it('renders a todo checklist from JSON args', () => {
    render(<ToolBlock b={block('todowrite', JSON.stringify({ todos: [
      { content: '装订单', status: 'completed' },
      { content: '排料', status: 'in_progress' },
      { content: '质检', status: 'pending' },
    ] }))} />)
    expect(screen.getByText('装订单')).toBeTruthy()
    expect(screen.getByText('排料')).toBeTruthy()
    expect(screen.getByText('质检')).toBeTruthy()
  })

  it('renders edit diffs as removals/additions', () => {
    render(<ToolBlock b={block('edit', JSON.stringify({ filePath: '/a.ts', oldString: 'old line', newString: 'new line' }))} />)
    expect(screen.getByText(/- old line/)).toBeTruthy()
    expect(screen.getByText(/\+ new line/)).toBeTruthy()
    expect(screen.getByText(/a\.ts/)).toBeTruthy()
  })

  it('renders bash commands with a $ prompt', () => {
    render(<ToolBlock b={block('bash', JSON.stringify({ command: 'ls -la' }))} />)
    expect(screen.getByText(/ls -la/)).toBeTruthy()
  })

  it('falls back to the summary row for prose args (history shape)', () => {
    render(<ToolBlock b={block('edit', '2 edits')} />)
    expect(screen.getByText('2 edits')).toBeTruthy()
    expect(screen.queryByText(/- /)).toBeNull()
  })
})
