// $lib/shortcuts/bindings.ts — pure shortcut-matching kernel (ZCode
// shortcuts/bindings.ts register, compacted to ocrc's needs). No DOM access,
// fully unit-testable.
//
// Key normalizations handled:
//  - Ctrl (platform meta): Ctrl on Win/Linux, Cmd on macOS
//  - event.code reverse lookup for letters/digits (layout-safe physical keys)
//  - IME safety: keyCode 229 (composition) never matches
//  - Shift+symbol keys match by event.key (e.g. 'Ctrl+Shift+[')

export interface ParsedBinding {
  ctrl: boolean
  shift: boolean
  alt: boolean
  /** Normalized key: uppercase letter/digit, or literal symbol from event.key. */
  key: string
  /** event.code candidates (physical key), e.g. KeyN / Digit1. */
  codes: string[]
}

const isMac = (): boolean =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent)

/** Physical code lookup for punctuation (Shift produces shifted chars —
 *  e.g. Shift+[ types '{' — so symbols must match by event.code, not key). */
const SYMBOL_CODES: Record<string, string> = {
  '[': 'BracketLeft', ']': 'BracketRight', ',': 'Comma', '.': 'Period',
  '/': 'Slash', ';': 'Semicolon', "'": 'Quote', '-': 'Minus', '=': 'Equal',
  '`': 'Backquote', '\\': 'Backslash',
}

export function parseBinding(spec: string): ParsedBinding {
  const parts = spec.split('+').map((p) => p.trim())
  const key = (parts.pop() ?? '').toUpperCase()
  const up = parts.map((p) => p.toUpperCase())
  const shift = up.includes('SHIFT')
  const alt = up.includes('ALT') || up.includes('OPTION')
  const ctrl = up.includes('CTRL') || up.includes('CMD') || up.includes('CMDORCTRL') || up.includes('META')
  const codes: string[] = []
  if (/^[A-Z]$/.test(key)) codes.push(`Key${key}`)
  else if (/^[0-9]$/.test(key)) codes.push(`Digit${key}`)
  else if (key.length === 1 && SYMBOL_CODES[key]) codes.push(SYMBOL_CODES[key]!)
  return { ctrl, shift, alt, key, codes }
}

/** Meta key name shown in the UI ('Ctrl' on Win/Linux, '⌘' on macOS). */
export function metaLabel(): string {
  return isMac() ? '⌘' : 'Ctrl'
}

/** UI-facing label with the platform meta substituted (Ctrl+N → ⌘N on mac). */
export function bindingLabel(spec: string): string {
  if (!isMac()) return spec
  return spec
    .split('+')
    .map((p) => (p === 'Ctrl' || p === 'Cmd' || p === 'CmdOrCtrl' ? '⌘' : p))
    .join('')
}

export function matchesBinding(e: Pick<KeyboardEvent, 'key' | 'code' | 'keyCode' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>, binding: ParsedBinding): boolean {
  // IME composition events carry keyCode 229 — never treat them as shortcuts.
  if (e.keyCode === 229) return false
  const ctrlWanted = binding.ctrl
  // Ctrl (spec) matches Ctrl on Win/Linux, Cmd on macOS.
  const ctrlPressed = isMac() ? e.metaKey : e.ctrlKey
  if (ctrlWanted !== ctrlPressed) return false
  if (binding.shift !== e.shiftKey) return false
  if (binding.alt !== e.altKey) return false
  // Symbol keys ('[', ',', '='...) match by event.key; physical codes match
  // letters/digits across layouts.
  if (binding.codes.length > 0) return binding.codes.includes(e.code)
  return e.key.toUpperCase() === binding.key
}
