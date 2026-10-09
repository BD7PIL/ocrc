// Scripted stub model for the P3 gate: it walks a plan of tool calls.
//
// The point is not to prove a model writes good scripts (that is a model-quality
// question) but to prove the PLUMBING end to end: the skill gate opens, a bad script
// comes back with located diagnostics, the corrected script starts a run, the run is
// followed with GetWorkflowRun, and an escalation is answered.
//
// Plan: STUB_PLAN = JSON array of steps, each {"tool": "...", "args": {...}} or
// {"text": "..."} (a plain answer). One step per request; the last step repeats.
import { createServer } from 'node:http'

const PORT = Number(process.env.STUB_PORT ?? 4300)
const plan = JSON.parse(process.env.STUB_PLAN ?? '[{"text":"done"}]')
let step = 0

const chunk = (delta, finish) => ({
  id: 'chatcmpl-stub', object: 'chat.completion.chunk', created: 1, model: 'stub-model',
  choices: [{ index: 0, delta, finish_reason: finish }],
})

function sse(res, chunks, usage) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`)
  if (usage) {
    res.write(`data: ${JSON.stringify({ id: 'chatcmpl-stub', object: 'chat.completion.chunk', created: 1, model: 'stub-model', choices: [], usage })}\n\n`)
  }
  res.write('data: [DONE]\n\n')
  res.end()
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'stub-model', object: 'model', owned_by: 'stub' }] }))
    return
  }
  if (req.method !== 'POST' || !req.url?.startsWith('/v1/chat/completions')) { res.writeHead(404).end(); return }
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    let messages = []
    try { messages = JSON.parse(body).messages ?? [] } catch { /* empty */ }
    const lastMsg = messages[messages.length - 1]
    const prompt = typeof lastMsg?.content === 'string' ? lastMsg.content : ''
    // A slow branch, so a gate can submit into an ask that is still in flight.
    if (/SLOW/.test(prompt)) {
      process.stderr.write('[stub] SLOW turn\n')
      setTimeout(() => sse(res, [chunk({ role: 'assistant', content: 'thinking…' }, null), chunk({}, 'stop')], { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }), 30_000)
      return
    }
    const current = plan[Math.min(step, plan.length - 1)]
    const alreadyAnswered = messages.some((m) => m.role === 'tool')
    // Advance only after a tool result has come back, so the model sees the result
    // of the call it just made before choosing the next one.
    if (alreadyAnswered && step < plan.length - 1) step++
    const next = plan[Math.min(step, plan.length - 1)]
    const usage = { prompt_tokens: 200, completion_tokens: 40, total_tokens: 240 }
    process.stderr.write(`[stub] step ${step}/${plan.length - 1} → ${current.tool ?? 'text'}\n`)

    if (alreadyAnswered && next !== current) {
      // Re-read the plan for the next step in this same turn.
      if (next.tool) {
        sse(res, [
          chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${step}`, type: 'function', function: { name: next.tool, arguments: JSON.stringify(next.args ?? {}) } }] }, null),
          chunk({}, 'tool_calls'),
        ], usage)
        return
      }
      sse(res, [chunk({ role: 'assistant', content: next.text ?? 'done' }, null), chunk({}, 'stop')], usage)
      return
    }

    if (current.tool) {
      sse(res, [
        chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${step}`, type: 'function', function: { name: current.tool, arguments: JSON.stringify(current.args ?? {}) } }] }, null),
        chunk({}, 'tool_calls'),
      ], usage)
      return
    }
    sse(res, [chunk({ role: 'assistant', content: current.text ?? 'done' }, null), chunk({}, 'stop')], usage)
  })
})

server.listen(PORT, '127.0.0.1', () => process.stderr.write(`[stub] listening on 127.0.0.1:${PORT} with ${plan.length} plan step(s)\n`))
