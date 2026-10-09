// Minimal OpenAI-compatible stub for the P2 workflow gate.
//
// Actors are ordinary opencode sessions, so a real model turn is what proves the
// driver's dispatch/turn-end path. This stub answers every chat completion with a
// short deterministic text (and, when asked, a tool call), which is all an untyped
// `ask()` needs to settle.
import { createServer } from 'node:http'

const PORT = Number(process.env.STUB_PORT ?? 4300)
const TEXT = process.env.STUB_TEXT ?? 'actor-report: ok'

const chunk = (delta, finish) => ({
  id: 'chatcmpl-stub', object: 'chat.completion.chunk', created: 1, model: 'stub-model',
  choices: [{ index: 0, delta, finish_reason: finish }],
})

function sse(res, chunks, usage) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`)
  if (usage) {
    res.write(`data: ${JSON.stringify({
      id: 'chatcmpl-stub', object: 'chat.completion.chunk', created: 1, model: 'stub-model',
      choices: [], usage,
    })}\n\n`)
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
  if (req.method !== 'POST' || !req.url?.startsWith('/v1/chat/completions')) {
    res.writeHead(404).end()
    return
  }
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    let messages = []
    try { messages = JSON.parse(body).messages ?? [] } catch { /* empty */ }
    const last = messages[messages.length - 1]
    const prompt = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '')
    // A slow branch, so the gate can cancel and restart a run mid-flight.
    const slow = /SLOW/.test(prompt)
    process.stderr.write(`[stub] turn (${messages.length} msgs)${slow ? ' SLOW' : ''}\n`)
    const chunks = [
      chunk({ role: 'assistant', content: TEXT }, null),
      chunk({}, 'stop'),
    ]
    // Usage is what the budget gate reads, so every turn reports tokens.
    const usage = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 }
    if (slow) setTimeout(() => sse(res, chunks, usage), 30_000)
    else sse(res, chunks, usage)
  })
})

server.listen(PORT, '127.0.0.1', () => process.stderr.write(`[stub] listening on 127.0.0.1:${PORT}\n`))
