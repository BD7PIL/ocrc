// components/cards/Blocks.tsx — ContentBlock[] rendering (M2 core set): text
// → markdown, tool → one-line status row (full output lands with the M3 tool
// pane), reasoning → muted collapsed block. The PART registry (registerPartComponent)
// grows around this dispatcher in M2-2.
import { memo } from 'react'
import type { ContentBlock } from '$lib/api/types.js'
import { MarkdownView } from '../markdown/MarkdownView.js'

export const Blocks = memo(function Blocks({ blocks }: { blocks: ContentBlock[] }) {
  return (
    <div className="flex flex-col gap-2">
      {blocks.map((b, i) => (
        <BlockView key={b.partId ?? i} b={b} />
      ))}
    </div>
  )
})

function BlockView({ b }: { b: ContentBlock }) {
  if (b.type === 'text') return <MarkdownView text={b.text} />
  if (b.type === 'reasoning') {
    return (
      <details className="reasoning-blk">
        <summary>思考</summary>
        <div style={{ color: 'var(--text-3)' }}><MarkdownView text={b.text} /></div>
      </details>
    )
  }
  // tool row
  const running = b.status === 'running'
  return (
    <div className="tool-row" data-status={b.status}>
      <span
        className={`size-1.5 shrink-0 rounded-full ${running ? 'ocrc-pulse-dot' : ''}`}
        style={{ background: b.status === 'error' ? 'var(--err)' : running ? 'var(--accent)' : 'var(--ok)' }}
        aria-hidden
      />
      <span className="mono shrink-0" style={{ color: 'var(--toolcmd)' }}>{b.tool}</span>
      <span className="mono min-w-0 flex-1 truncate" style={{ color: 'var(--toolout)' }}>
        {b.args.replace(/\s+/g, ' ').slice(0, 160)}
      </span>
    </div>
  )
}
