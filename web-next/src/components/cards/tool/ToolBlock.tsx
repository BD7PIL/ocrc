// components/cards/tool/ToolBlock.tsx — the PART registry's tool branch:
// routes todo / edit-write-diff / bash to specialized renderers, everything
// else falls back to the generic status row.
// M9 视觉复刻（ZCode ToolCallBlocks register）：摘要行是无底 inline 文本行
// （图标 + 工具名 + 参数摘要，text-ui-base，status 用旋转 loader/静默）；
// 专门内容（todo 清单裸排 / diff·bash 在 rounded-lg bg-card 卡）。
import { memo, useState } from 'react'
import { CheckCircle2, Circle, CircleDot, Loader2 } from 'lucide-react'
import type { ContentBlock } from '$lib/api/types.js'
import { parseToolArgs, todoItems, diffSides, bashCommand, toolRendererKind, type TodoItem } from './pure.js'

/** ZCode ToolSummaryRow：inline 无底行，status 前置（running=旋转 loader）。 */
export const ToolBlock = memo(function ToolBlock({ b }: { b: Extract<ContentBlock, { type: 'tool' }> }) {
  const kind = toolRendererKind(b.tool)
  const parsed = parseToolArgs(b.args)
  const running = b.status === 'running'

  const summary = (detail?: string) => (
    <div className="flex max-w-full items-center gap-2 self-start text-left text-ui-base" data-status={b.status}>
      <span className="flex size-4 shrink-0 items-center justify-center">
        {running ? (
          <Loader2 className="size-3.5 animate-spin text-foreground-subtle" />
        ) : b.status === 'error' ? (
          <CircleDot className="size-3.5 text-destructive" strokeWidth={1.75} />
        ) : (
          <CheckCircle2 className="size-3.5 text-foreground-subtlest" strokeWidth={1.75} />
        )}
      </span>
      <span className="shrink-0 font-medium text-foreground-subtle">{b.tool}</span>
      {detail && (
        <span className="mono min-w-0 truncate text-ui-sm text-foreground-subtlest">
          {detail}
        </span>
      )}
    </div>
  )

  if (!parsed.ok) return summary(b.args.replace(/\s+/g, ' ').slice(0, 160))

  if (kind === 'todo') {
    const items = todoItems(parsed.args)
    if (items.length > 0) return <TodoCard items={items} summary={summary()} />
  } else if (kind === 'diff') {
    const sides = diffSides(parsed.args)
    if (sides) return <DiffCard sides={sides} summary={summary(sides.filePath?.split('/').pop())} />
  } else if (kind === 'bash') {
    const cmd = bashCommand(parsed.args)
    if (cmd) return <BashCard command={cmd} summary={summary()} />
  }
  return summary(b.args.replace(/\s+/g, ' ').slice(0, 160))
})

function TodoCard({ items, summary }: { items: TodoItem[]; summary: React.ReactNode }) {
  return (
    <div className="w-full">
      {summary}
      <ul className="flex flex-col gap-1 pt-2">
        {items.map((t, i) => (
          <li key={i} className="flex items-start gap-1.5 text-ui-sm">
            {t.status === 'completed' ? (
              <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" strokeWidth={1.75} />
            ) : t.status === 'in_progress' ? (
              <CircleDot className="mt-0.5 size-3.5 shrink-0 text-info" strokeWidth={1.75} />
            ) : (
              <Circle className="mt-0.5 size-3.5 shrink-0 text-foreground-subtlest" strokeWidth={1.75} />
            )}
            <span className={t.status === 'completed' ? 'text-foreground-subtle' : t.status === 'in_progress' ? 'text-foreground' : 'text-foreground-subtle'}>
              {t.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function DiffCard({ sides, summary }: { sides: NonNullable<ReturnType<typeof diffSides>>; summary: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const shownR = open ? sides.removals : sides.removals.slice(0, 6)
  const shownA = open ? sides.additions : sides.additions.slice(0, 6)
  const truncated = sides.removals.length > 6 || sides.additions.length > 6
  return (
    <div className="w-full">
      {summary}
      <div className="pt-2">
        {sides.removals.length > 0 && (
          <pre className="diff-lines removals">{shownR.map((l, i) => <div key={i}>- {l}</div>)}{!open && sides.removals.length > 6 && <div>…</div>}</pre>
        )}
        {shownA.length > 0 && (
          <pre className="diff-lines additions">{shownA.map((l, i) => <div key={i}>+ {l}</div>)}{!open && sides.additions.length > 6 && <div>…</div>}</pre>
        )}
        {truncated && (
          <button type="button" className="mt-1 text-ui-2xs text-foreground-subtle transition-colors hover:text-foreground" onClick={() => setOpen((v) => !v)}>
            {open ? '收起' : '展开全部'}
          </button>
        )}
      </div>
    </div>
  )
}

function BashCard({ command, summary }: { command: string; summary: React.ReactNode }) {
  const long = command.length > 200 || command.includes('\n')
  const shown = long ? command.slice(0, 200) : command
  return (
    <div className="w-full">
      {summary}
      <pre className="mono mt-2 overflow-x-auto rounded-lg border border-border bg-card p-2.5 text-ui-xs text-foreground">
        <span className="text-info">$ </span>
        {shown}
        {long ? '…' : ''}
      </pre>
    </div>
  )
}
