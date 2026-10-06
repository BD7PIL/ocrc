// components/cards/tool/pure.ts — pure helpers for paced streaming text and
// specialized tool renderers. No React, fully unit-testable.
// Registers: opencode message-part.tsx TEXT_RENDER_PACE_MS/step/next (24ms,
// length-adaptive step, punctuation snap) + PART_MAPPING dispatch.

// ── paced streaming reveal ────────────────────────────────────────────────
export const PACE_MS = 24

/** Length-adaptive step: short blocks crawl (2 chars — reads as typing),
 *  large blocks sweep (capped 256 — never lags seconds behind the data). */
export function paceStep(textLength: number): number {
  if (textLength <= 12) return 2
  return Math.min(256, Math.max(4, Math.ceil(textLength / 32)))
}

/** Punctuation snap: if a sentence-ender sits within `lookahead` chars of the
 *  reveal head, extend to it — lines end cleanly instead of mid-word. */
const PUNCT = new Set(['。', '！', '？', '…', '；', '，', '.', '!', '?', ';', ',', '\n'])

export function snapPunctuation(target: number, text: string, lookahead = 6): number {
  const end = Math.min(text.length, target + lookahead)
  for (let i = target; i < end; i++) {
    if (PUNCT.has(text[i]!)) return i + 1
  }
  return target
}

/** Advance the reveal head one 24ms tick. Pure so the component stays thin.
 *  Also clamps down when a snapshot replaced the text with a shorter one. */
export function nextReveal(shown: number, text: string): number {
  if (shown >= text.length) return text.length
  const target = Math.min(text.length, shown + paceStep(text.length))
  return snapPunctuation(target, text)
}

// ── tool args parsing ─────────────────────────────────────────────────────
export interface ParsedTool {
  ok: boolean
  args: Record<string, unknown>
}

export function parseToolArgs(rawArgs: string): ParsedTool {
  if (!rawArgs.trim()) return { ok: false, args: {} }
  try {
    const v = JSON.parse(rawArgs)
    return v && typeof v === 'object' && !Array.isArray(v)
      ? { ok: true, args: v as Record<string, unknown> }
      : { ok: false, args: {} }
  } catch {
    return { ok: false, args: {} }
  }
}

// ── todo renderer ──────────────────────────────────────────────────────────
export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed' | string
}

export function todoItems(args: Record<string, unknown>): TodoItem[] {
  const todos = args.todos ?? args.items
  if (!Array.isArray(todos)) return []
  return todos
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map((t) => ({
      content: typeof t.content === 'string' ? t.content : typeof t.text === 'string' ? t.text : '',
      status: typeof t.status === 'string' ? t.status : 'pending',
    }))
    .filter((t) => t.content)
}

// ── edit/write diff renderer ───────────────────────────────────────────────
export interface DiffSide {
  filePath: string
  removals: string[]
  additions: string[]
}

/** oldString→removals / newString→additions (ocrc's lightweight diff card —
 *  the full @pierre/diffs virtualized view is a later-register upgrade). */
export function diffSides(args: Record<string, unknown>): DiffSide | null {
  const filePath = typeof args.filePath === 'string' ? args.filePath : typeof args.file === 'string' ? args.file : ''
  const oldStr = typeof args.oldString === 'string' ? args.oldString : ''
  const newStr = typeof args.newString === 'string' ? args.newString : ''
  const content = typeof args.content === 'string' ? args.content : '' // write tool: full content = addition
  if (!filePath && !oldStr && !newStr && !content) return null
  return {
    filePath,
    removals: oldStr ? oldStr.split('\n').slice(0, 40) : [],
    additions: newStr ? newStr.split('\n').slice(0, 40) : content ? content.split('\n').slice(0, 40) : [],
  }
}

// ── bash renderer ──────────────────────────────────────────────────────────
export function bashCommand(args: Record<string, unknown>): string {
  const cmd = args.command
  if (typeof cmd === 'string') return cmd
  if (Array.isArray(cmd)) return cmd.filter((c): c is string => typeof c === 'string').join(' ')
  return ''
}

/** Which specialized renderer handles this tool name (null = generic row). */
export function toolRendererKind(tool: string): 'todo' | 'diff' | 'bash' | null {
  const t = tool.toLowerCase()
  if (t.includes('todo')) return 'todo'
  if (t === 'edit' || t === 'write' || t.includes('multiedit') || t.includes('apply_patch')) return 'diff'
  if (t === 'bash' || t === 'shell' || t.includes('command')) return 'bash'
  return null
}
