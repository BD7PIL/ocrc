// hooks/useAppKeyboard.ts — the dispatch shell (ZCode useAppKeyboard register):
// one window keydown CAPTURE listener over the command table. Capture phase so
// the shell wins before content handlers; composers can stopDefault-scoped
// keys in M2 via the scope field.
import { useEffect } from 'react'
import { allCommands } from '$lib/shortcuts/commands.js'
import { matchesBinding } from '$lib/shortcuts/bindings.js'

export function useAppKeyboard(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      for (const cmd of allCommands()) {
        if (cmd.enabled && !cmd.enabled()) continue
        if (matchesBinding(e, cmd.binding)) {
          e.preventDefault()
          cmd.run()
          return
        }
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true } as EventListenerOptions)
  }, [])
}
