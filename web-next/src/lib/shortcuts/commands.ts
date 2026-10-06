// $lib/shortcuts/commands.ts — the command table (ZCode shortcutCommands.ts
// register): declarative id/label/keys; the shell registers runners. Scope
// keeps composer-level keys from being intercepted globally later (M2).
import { parseBinding, type ParsedBinding } from './bindings.js'

export interface ShortcutCommand {
  id: string
  label: string
  /** Default binding spec, e.g. 'Ctrl+N', 'Ctrl+Shift+[', 'Escape'. */
  keys: string
  scope?: 'global' | 'composer'
  /** When false the shortcut is registered but inert (hidden from hints). */
  enabled?: () => boolean
  run: () => void
}

const registry = new Map<string, ShortcutCommand & { binding: ParsedBinding }>()

export function registerCommands(cmds: ShortcutCommand[]): void {
  registry.clear()
  for (const c of cmds) {
    registry.set(c.id, { ...c, binding: parseBinding(c.keys) })
  }
}

export function allCommands(): Array<ShortcutCommand & { binding: ParsedBinding }> {
  return [...registry.values()]
}

export function commandById(id: string): (ShortcutCommand & { binding: ParsedBinding }) | undefined {
  return registry.get(id)
}
