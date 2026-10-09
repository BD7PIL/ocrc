// Minimal OpenAI-compatible streaming stub, for the P0 gate only.
//
// Why it exists: the gate has to prove a MODEL can call the attached tool and get
// the host's value back — a tool list is not "取回值". Standing up a real provider
// would mean real spend and real network; this stub speaks just enough of the
// /v1/chat/completions SSE dialect for opencode's openai-compatible provider:
//
//   turn 1 (no tool result in the transcript) → emit a tool_call for $PROBE_TOOL
//   turn 2 (a role:"tool" message is present) → emit text containing the tool output
//
// So the final assistant text carries whatever the tool returned, which is exactly
// what the gate asserts on.
import { createServer } from 'node:http'

const PORT = Number(process.env.STUB_PORT ?? 4300)
const PROBE_TOOL = process.env.STUB_TOOL ?? 'wf_echo'
const PROBE_ARG = process.env.STUB_ARG ?? 'ping'

const sse = (res, chunks) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

const chunk = (delta, finish) => ({
  id: 'chatcmpl-stub', object: 'chat.completion.chunk', created: 1, model: 'stub-model',
  choices: [{ index: 0, delta, finish_reason: finish }],
})

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'stub-model', object: 'model', owned_by: 'stub' }] }))
    return
  }
  if (req.method !== 'POST' || !req.url?.startsWith('/v1/chat/completions')) {
    res.writeHead(404).end()
    return
  }
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    let messages = []
    try { messages = JSON.parse(body).messages ?? [] } catch { /* keep empty */ }
    const toolMsg = [...messages].reverse().find((m) => m.role === 'tool')
    process.stderr.write(`[stub] turn: ${messages.length} msg(s), tool result ${toolMsg ? 'present' : 'absent'}\n`)

    if (toolMsg) {
      const text = String(toolMsg.content ?? '')
      sse(res, [
        chunk({ role: 'assistant', content: 'TOOL RESULT: ' }, null),
        chunk({ content: text }, null),
        chunk({}, 'stop'),
      ])
      return
    }
    sse(res, [
      chunk({ role: 'assistant', tool_calls: [{
        index: 0, id: 'call_probe_1', type: 'function',
        function: { name: PROBE_TOOL, arguments: JSON.stringify({ value: PROBE_ARG }) },
      }] }, null),
      chunk({}, 'tool_calls'),
    ])
  })
})

server.listen(PORT, '127.0.0.1', () => process.stderr.write(`[stub] listening on 127.0.0.1:${PORT}, tool=${PROBE_TOOL}\n`))
