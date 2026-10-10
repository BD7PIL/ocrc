import { analyzeWorkflowScript, UNPHASED_ID } from '../../../vendor/zcode-dwf/dist/dynamic-workflow/src/index.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('workflow-phases')

/**
 * P4-1a: the *declared* phase table a run launches with.
 *
 * `run-launched.phaseNames` is host-supplied ("由提交方从因果图填入") — the engine never
 * reads it. The submitter is us, and the causality graph is where the analyzer puts the
 * author's `phase("…")` vocabulary (unphased first when it has members, then the author's
 * phases in first-reach order). So this module turns a script into the two aligned tables
 * the panel's mini rail draws:
 *
 *   phaseNames     the declared table, in declaration order;
 *   phaseAlongside phaseAlongside[i] = indices of the phases that may still be in flight
 *                  when phaseNames[i] is entered.
 *
 * The parallelism map is derived from the analyzer's phase quotient: two phases are
 * concurrent exactly when neither reaches the other through `phaseEdges` (an edge is a
 * happens-before fact, so no path means "not ordered" — they may overlap). This is a
 * *may* answer on purpose; the vendored schema documents absence as "this rail is a
 * straight line", which is what an empty result means here too.
 *
 * Cost: the full analysis (taint fixpoint) is not free, so this runs only when the script
 * actually contains a `phase(` marker — a script without one has no phase vocabulary at
 * all, and its graph would be byte-identical to the pre-phase one.
 */
export interface DeclaredPhases {
  phaseNames?: string[]
  phaseAlongside?: number[][]
}

export function analyzePhases(scriptText: string): DeclaredPhases {
  if (!/\bphase\s*\(/.test(scriptText)) return {}
  try {
    const result = analyzeWorkflowScript(scriptText)
    const phases = result.causality?.phases
    if (!phases?.length) return {}
    const named = phases.filter((p) => p.id !== UNPHASED_ID && typeof p.name === 'string' && p.name.trim())
    if (!named.length) return {}
    const phaseNames = named.map((p) => p.name!)
    const index = new Map(named.map((p, i) => [p.id, i]))

    // Happens-before closure over the phase quotient (≤32 nodes: a DFS per node is plenty).
    const successors = new Map<string, Set<string>>()
    for (const edge of result.causality?.phaseEdges ?? []) {
      const set = successors.get(edge.from) ?? new Set<string>()
      set.add(edge.to)
      successors.set(edge.from, set)
    }
    const reaches = (from: string, to: string): boolean => {
      const seen = new Set<string>([from])
      const stack = [from]
      while (stack.length) {
        const cur = stack.pop()!
        for (const next of successors.get(cur) ?? []) {
          if (next === to) return true
          if (seen.has(next)) continue
          seen.add(next)
          stack.push(next)
        }
      }
      return false
    }

    const alongside: number[][] = []
    let anyParallel = false
    for (let i = 0; i < named.length; i++) {
      const peers: number[] = []
      for (let j = 0; j < i; j++) {
        const a = named[j]!.id
        const b = named[i]!.id
        if (reaches(a, b) || reaches(b, a)) continue
        peers.push(j)
      }
      alongside.push(peers)
      if (peers.length) anyParallel = true
    }
    return {
      phaseNames,
      // Absent when nothing is parallel: the vendored schema reads absence as a
      // straight line, and an all-empty table would be the same fact spelled louder.
      ...(anyParallel ? { phaseAlongside: alongside } : {}),
    }
  } catch (err) {
    log.warn(`phase analysis failed (rail falls back to a straight line): ${(err as Error).message}`)
    return {}
  }
}
