// components/transcript/sessionContext.ts — the viewed session id, provided
// by SessionPage; cards (thinking stop button) and the composer read it
// without prop drilling.
import { createContext, useContext } from 'react'

export const SessionIdContext = createContext<string | null>(null)

export function useCurrentSessionId(): string | null {
  return useContext(SessionIdContext)
}
