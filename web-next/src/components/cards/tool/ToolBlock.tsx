// components/cards/tool/ToolBlock.tsx — the PART registry's tool branch:
// routes todo / edit-write-diff / bash to specialized renderers, everything
// else falls back to the generic status row.
import { memo, useState } from 'react'
import { CheckCircle2, Circle, CircleDot, FileDiff, TerminalSquare } from 'lucide-react'
import type { ContentBlock } from '$lib/api/types.js'
import { parseToolArgs, todoItems, diffSides, bashCommand, toolRendererKind, type TodoItem } from './pure.js'

export const ToolBlock = memo(function ToolBlock({ b }: { b: Extract<ContentBlock, { type: 'tool' }> }) {
  const kind = toolRendererKind(b.tool)
  const parsed = parseToolArgs(b.args)
  const running = b.status === 'running'

  const header = (
    <div className="tool-row" data-status={b.status}>
      <span
        className={`size-1.5 shrink-0 rounded-full ${running ? 'ocrc-pulse-dot' : ''}`}
        style={{ background: b.status === 'error' ? 'var(--err)' : running ? 'var(--accent)' : 'var(--ok)' }}
        aria-hidden
      />
      <span className="mono shrink-0" style={{ color: 'var(--toolcmd)' }}>{b.tool}</span>
    </div>
  )

  if (!parsed.ok) {
    return (
      <div>
        {header}
        <div className="mono min-w-0 flex-1 truncate pl-4" style={{ color: 'var(--toolout)', fontSize: 'var(--ui-2xs)' }}>
          {b.args.replace(/\s+/g, ' ').slice(0, 160)}
        </div>
      </div>
    )
  }

  if (kind === 'todo') {
    const items = todoItems(parsed.args)
    if (items.length > 0) return <TodoCard tool={b.tool} items={items} running={running} />
  } else if (kind === 'diff') {
    const sides = diffSides(parsed.args)
    if (sides) return <DiffCard tool={b.tool} sides={sides} running={running} />
  } else if (kind === 'bash') {
    const cmd = bashCommand(parsed.args)
    if (cmd) return <BashCard tool={b.tool} command={cmd} running={running} />
  }
  return (
    <div>
      {header}
      <div className="mono min-w-0 flex-1 truncate pl-4" style={{ color: 'var(--toolout)', fontSize: 'var(--ui-2xs)' }}>
        {b.args.replace(/\s+/g, ' ').slice(0, 160)}
      </div>
    </div>
  )
})

function CardShell({ icon, title, children, running }: { icon: React.ReactNode; title: string; children: React.ReactNode; running: boolean }) {
  return (
    <div className="rounded-[9px] p-2" style={{ background: 'var(--bg-code)', border: running ? '1px solid var(--accent-line)' : '1px solid var(--border-2)' }}>
      <div className="mb-1.5 flex items-center gap-1.5" style={{ color: 'var(--text-3)' }}>
        {icon}
        <span className="label" style={{ fontSize: 'var(--ui-2xs)' }}>{title}</span>
        {running && <span className="ocrc-pulse-dot ml-auto size-1.5 rounded-full" style={{ background: 'var(--accent)' }} aria-hidden />}
      </div>
      {children}
    </div>
  )
}

function TodoCard({ tool, items, running }: { tool: string; items: TodoItem[]; running: boolean }) {
  return (
    <CardShell icon={<CircleDot size={12} strokeWidth={1.75} />} title={tool} running={running}>
      <ul className="flex flex-col gap-1">
        {items.map((t, i) => (
          <li key={i} className="flex items-start gap-1.5" style={{ fontSize: 'var(--ui-sm)' }}>
            {t.status === 'completed' ? (
              <CheckCircle2 size={13} strokeWidth={1.75} style={{ color: 'var(--ok)', flexShrink: 0, marginTop: 2 }} />
            ) : t.status === 'in_progress' ? (
              <CircleDot size={13} strokeWidth={1.75} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 2 }} />
            ) : (
              <Circle size={13} strokeWidth={1.75} style={{ color: 'var(--text-4)', flexShrink: 0, marginTop: 2 }} />
            )}
            <span style={{ color: t.status === 'completed' ? 'var(--text-3)' : t.status === 'in_progress' ? 'var(--text)' : 'var(--text-2)' }}>
              {t.content}
            </span>
          </li>
        ))}
      </ul>
    </CardShell>
  )
}

function DiffCard({ tool, sides, running }: { tool: string; sides: NonNullable<ReturnType<typeof diffSides>>; running: boolean }) {
  const [open, setOpen] = useState(false)
  const shownR = open ? sides.removals : sides.removals.slice(0, 6)
  const shownA = open ? sides.additions : sides.additions.slice(0, 6)
  const truncated = sides.removals.length > 6 || sides.additions.length > 6
  return (
    <CardShell icon={<FileDiff size={12} strokeWidth={1.75} />} title={`${tool}${sides.filePath ? ` · ${sides.filePath.split('/').pop()}` : ''}`} running={running}>
      {sides.removals.length > 0 && (
        <pre className="diff-lines removals">{shownR.map((l, i) => <div key={i}>- {l}</div>)}{!open && sides.removals.length > 6 && <div>…</div>}</pre>
      )}
      {shownA.length > 0 && (
        <pre className="diff-lines additions">{shownA.map((l, i) => <div key={i}>+ {l}</div>)}{!open && sides.additions.length > 6 && <div>…</div>}</pre>
      )}
      {truncated && (
        <button type="button" className="mt-1" style={{ fontSize: 'var(--ui-2xs)', color: 'var(--accent)' }} onClick={() => setOpen((v) => !v)}>
          {open ? '收起' : '展开全部'}
        </button>
      )}
    </CardShell>
  )
}

function BashCard({ tool, command, running }: { tool: string; command: string; running: boolean }) {
  const long = command.length > 200 || command.includes('\n')
  const shown = long ? command.slice(0, 200) : command
  return (
    <CardShell icon={<TerminalSquare size={12} strokeWidth={1.75} />} title={tool} running={running}>
      <pre className="mono overflow-x-auto" style={{ fontSize: 'var(--ui-xs)', color: 'var(--toolcmd)' }}>
        <span style={{ color: 'var(--accent)' }}>$ </span>
        {shown}
        {long ? '…' : ''}
      </pre>
    </CardShell>
  )
}
