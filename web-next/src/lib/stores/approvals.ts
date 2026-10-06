// $lib/stores/approvals.ts — locally-answered approval/question tracking.
// The host republishes answered questions in place (card.resolved), but
// APPROVALS carry no server-side resolved marker — the old shell tracked the
// decision locally (CardApproval `done`), and so do we. Feeds the dock:
// pending items surface there; answered ones stay in the transcript.
import { create } from 'zustand'

interface ApprovalsState {
  answered: Record<string, 'once' | 'always' | 'reject' | 'skip'>
  markAnswered: (requestId: string, decision: 'once' | 'always' | 'reject' | 'skip') => void
  isAnswered: (requestId: string) => boolean
}

export const useApprovals = create<ApprovalsState>((set, get) => ({
  answered: {},
  markAnswered: (requestId, decision) => set((s) => ({ answered: { ...s.answered, [requestId]: decision } })),
  isAnswered: (requestId) => get().answered[requestId] !== undefined,
}))
