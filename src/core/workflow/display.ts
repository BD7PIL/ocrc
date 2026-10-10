import { analyzeWorkflowScript, FLOW_SINK, type CausalityGraph, type ControlFlowGraph, type HandoffGraph } from '../../../vendor/zcode-dwf/dist/dynamic-workflow/src/index.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('workflow-display')

/**
 * P4-2: the CreateWorkflow tool card's `display` payload.
 *
 * The panel's run pane draws a static picture of the script — steps, lanes, participants,
 * handoffs, phases — and it reads that picture from the tool ROW's `display`, not from
 * any query. The upstream CLI builds it from the analyzer; we have the same analyzer
 * vendored, so this is the same projection from the same source.
 *
 * Without it the pane renders "当前会话的可见历史里没有这张工作流程图" — which is exactly
 * what it said before this landed.
 *
 * Bounds are the vendored schema's own limits: an over-bound array does not lose an entry,
 * it makes the whole payload fail to parse and the card lose its picture entirely.
 */

const LIMITS = {
  steps: 64,
  lanes: 32,
  participants: 64,
  handoffs: 256,
  phases: 32,
  phaseEdges: 128,
  exits: 32,
  sink: 64,
  diagnostics: 100,
  label: 128,
  id: 64,
  message: 2_048,
} as const

export interface CreateWorkflowDisplay {
  kind: 'create_workflow'
  ok: boolean
  errorCount: number
  diagnostics: Array<{ line: number; column: number; code: number; message: string }>
  causalityGraph?: Record<string, unknown>
  truncated?: true
}

const clamp = (text: string, max: number): string => (text.length <= max ? text : text.slice(0, max))

/**
 * Build the payload for one script. Pure and cheap-ish (the analysis is the same one the
 * compile pass runs for a script with phase markers); a script that does not typecheck
 * still gets a display — with diagnostics and no graph, which is the honest picture.
 */
export function buildCreateWorkflowDisplay(scriptText: string): CreateWorkflowDisplay {
  let result: ReturnType<typeof analyzeWorkflowScript>
  try {
    result = analyzeWorkflowScript(scriptText)
  } catch (err) {
    log.warn(`display analysis failed: ${(err as Error).message}`)
    return { kind: 'create_workflow', ok: false, errorCount: 1, diagnostics: [] }
  }
  const diagnostics = result.diagnostics.slice(0, LIMITS.diagnostics).map((d) => ({
    line: d.line,
    column: d.column,
    code: d.code,
    message: clamp(d.message, LIMITS.message),
  }))
  const base: CreateWorkflowDisplay = {
    kind: 'create_workflow',
    ok: result.ok,
    errorCount: result.diagnostics.length,
    diagnostics,
  }
  if (!result.causality) return base
  const graph = buildGraph(result.causality, result.handoff, result.flow)
  return { ...base, ...(graph ? { causalityGraph: graph } : {}) }
}

function buildGraph(
  causality: CausalityGraph,
  handoff: HandoffGraph | undefined,
  flow: ControlFlowGraph | undefined,
): Record<string, unknown> | undefined {
  let truncated = false
  const cut = <T>(list: T[], max: number): T[] => {
    if (list.length <= max) return list
    truncated = true
    return list.slice(0, max)
  }

  const steps = cut(causality.steps, LIMITS.steps).map((s) => ({
    id: clamp(s.id, LIMITS.id),
    kind: s.kind,
    label: clamp(s.label, LIMITS.label),
    ...(s.labelPattern ? { labelPattern: s.labelPattern } : {}),
    ...(s.loc?.line !== undefined ? { line: s.loc.line } : {}),
    ...(s.loc?.column !== undefined ? { column: s.loc.column } : {}),
    lane: clamp(s.lane, LIMITS.id),
    ...(s.lanes ? { lanes: cut(s.lanes.map((l) => clamp(l, LIMITS.id)), LIMITS.lanes) } : {}),
    ...(s.source ? { source: clamp(s.source, LIMITS.id) } : {}),
    ...(s.phase ? { phase: clamp(s.phase, LIMITS.id) } : {}),
    ...(s.repeat ? { repeat: s.repeat } : {}),
  }))

  const lanes = cut(causality.lanes, LIMITS.lanes).map((l) => ({
    id: clamp(l.id, LIMITS.id),
    ...(l.name ? { name: clamp(l.name, LIMITS.label) } : {}),
    ...(l.loc?.line !== undefined ? { line: l.loc.line } : {}),
    ...(l.loc?.column !== undefined ? { column: l.loc.column } : {}),
  }))

  // Handoff participants / edges come from the analyzer's own handoff projection; without
  // it (an unanalyzable script) the graph is still drawn from steps + lanes.
  const participants = cut(handoff?.participants ?? [], LIMITS.participants).map((p) => ({
    id: clamp(p.id, LIMITS.id),
    phase: clamp(p.phase, LIMITS.id),
    lane: clamp(p.lane, LIMITS.id),
    steps: cut(p.steps.map((s) => clamp(s, LIMITS.id)), LIMITS.steps),
    ...(p.member ? { member: p.member } : {}),
    ...(p.many ? { many: true as const } : {}),
  }))
  const handoffs = cut(handoff?.handoffs ?? [], LIMITS.handoffs).map((h) => ({
    from: clamp(h.from, LIMITS.id),
    to: clamp(h.to, LIMITS.id),
    ...(h.back ? { back: true as const } : {}),
    ...(h.types ? { types: h.types.slice(0, 8).map((t) => clamp(t, LIMITS.label)) } : {}),
  }))

  // Phases: the control-flow projection carries `alongside` (which phases are still
  // running when this one is entered) — the causality graph does not, and that field is
  // what the timeline uses to draw a parallel band. Fall back to the causality vocabulary
  // when the flow projection is absent.
  const flowPhases = flow?.phases
  const phases = flowPhases?.length
    ? cut(flowPhases, LIMITS.phases).map((p) => ({
        id: clamp(p.id, LIMITS.id),
        ...(p.name ? { name: clamp(p.name, LIMITS.label) } : {}),
        ...(p.loc?.line !== undefined ? { line: p.loc.line } : {}),
        ...(p.loc?.column !== undefined ? { column: p.loc.column } : {}),
        ...(p.alongside?.length ? { alongside: p.alongside.slice(0, LIMITS.phases).map((a) => clamp(a, LIMITS.id)) } : {}),
      }))
    : causality.phases?.length
      ? cut(causality.phases, LIMITS.phases).map((p) => ({
          id: clamp(p.id, LIMITS.id),
          ...(p.name ? { name: clamp(p.name, LIMITS.label) } : {}),
          ...(p.loc?.line !== undefined ? { line: p.loc.line } : {}),
          ...(p.loc?.column !== undefined ? { column: p.loc.column } : {}),
        }))
      : []

  const phaseEdges = causality.phaseEdges?.length
    ? cut(causality.phaseEdges, LIMITS.phaseEdges).map((e) => ({
        from: clamp(e.from, LIMITS.id),
        to: clamp(e.to, LIMITS.id),
        // `carry` is the analyzer's name for a loop back edge; the payload has one bit
        // for it (`back`), because that is all the layout reads.
        ...(e.kind === 'carry' ? { back: true as const } : {}),
      }))
    : []

  // Phases from which control can complete normally: the phases of the nodes that reach
  // the flow graph's sink. Read off the projection rather than guessed from the graph.
  const exits = (() => {
    if (!flow) return [] as string[]
    const phaseOf = new Map(flow.nodes.map((n) => [n.id, n.phase]))
    const out = new Set<string>()
    for (const edge of flow.edges) {
      if (edge.to !== FLOW_SINK) continue
      const phase = phaseOf.get(edge.from)
      if (phase) out.add(phase)
    }
    return [...out].slice(0, LIMITS.exits).map((p) => clamp(p, LIMITS.id))
  })()

  return {
    steps,
    lanes,
    participants,
    handoffs,
    ...(phases.length ? { phases } : {}),
    ...(phaseEdges.length ? { phaseEdges } : {}),
    ...(exits.length ? { exits } : {}),
    ...(causality.sink?.fedBy?.length ? { sink: cut(causality.sink.fedBy, LIMITS.sink).map((s) => clamp(s, LIMITS.id)) } : {}),
    ...(truncated ? { truncated: true } : {}),
  }
}
