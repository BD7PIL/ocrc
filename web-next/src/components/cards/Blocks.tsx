// components/cards/Blocks.tsx — ContentBlock[] rendering. Streaming context:
// text/reasoning go through the 24ms paced reveal (plain text, markdown parses
// at finalize); tool blocks route through the PART registry (ToolBlock).
import { memo } from 'react'
import type { ContentBlock } from '$lib/api/types.js'
import { MarkdownView } from '../markdown/MarkdownView.js'
import { PacedText } from '../markdown/PacedText.js'
import { ToolBlock } from './tool/ToolBlock.js'
import { useCurrentSessionId } from '../transcript/sessionContext.js'
import { openPaneTab } from '$lib/stores/sidePane.js'

export const Blocks = memo(function Blocks({ blocks, streaming = false }: { blocks: ContentBlock[]; streaming?: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      {blocks.map((b, i) =>
        b.type === 'tool' ? (
          <ToolRow key={b.partId ?? i} b={b} />
        ) : (
          <BlockView key={b.partId ?? i} b={b} streaming={streaming} />
        ),
      )}
    </div>
  )
})

function BlockView({ b, streaming }: { b: ContentBlock; streaming: boolean }) {
  if (b.type === 'text') {
    return streaming ? <PacedText text={b.text} streaming={streaming} /> : <MarkdownView text={b.text} />
  }
  if (b.type === 'reasoning') {
    return (
      <details className="reasoning-blk">
        <summary>思考</summary>
        <div style={{ color: 'var(--text-3)' }}>
          {streaming ? <PacedText text={b.text} streaming={streaming} /> : <MarkdownView text={b.text} />}
        </div>
      </details>
    )
  }
  return null
}

/** Tool row wrapper: click opens the tool-output tab (messageRaw part page). */
function ToolRow({ b }: { b: Extract<ContentBlock, { type: 'tool' }> }) {
  const sessionId = useCurrentSessionId()
  return (
    <div
      className="cursor-pointer transition-opacity hover:opacity-80"
      role="button"
      tabIndex={0}
      title="打开工具输出"
      onClick={() => {
        if (!sessionId || !b.messageId || !b.partId) return
        openPaneTab({ id: `tool:${b.partId}`, kind: 'tool', title: `${b.tool} 输出`, sessionId, messageId: b.messageId, partId: b.partId })
      }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.currentTarget as HTMLElement).click() }}
    >
      <ToolBlock b={b} />
    </div>
  )
}
