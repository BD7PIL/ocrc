// Mock opencode engine — isolated release-gate engine (NEVER touches the
// user's real opencode). Implements just enough of the opencode HTTP API for
// ocrc's backend: session CRUD, prompt_async, status, config, command list,
// todo, children, and the /global/event SSE stream that drives streaming.
//
// A prompt echoes a fixed reply in ~6 text chunks over ~3s, then goes idle —
// enough for the smoke's "WS streaming delivers" assertion with zero tokens.
//
// Usage: node scripts/mock-opencode.mjs [port]   (default 4098)
import { createServer } from 'node:http'

const PORT = Number(process.argv[2] ?? 4098)
const sessions = new Map() // id -> { info, messages: [{info, parts}] }
const sseClients = new Set()

const now = () => Date.now()
const SESSION = (id) => sessions.get(id)

function publish(directory, payload) {
  const frame = `data: ${JSON.stringify({ directory, payload })}\n\n`
  for (const res of sseClients) {
    try { res.write(frame) } catch { sseClients.delete(res) }
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = ''
    req.on('data', (c) => { b += c })
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')) } catch { resolve({}) } })
  })
}

const json = (res, code, data) => {
  const body = JSON.stringify(data)
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

let seq = 0
const mkId = (p) => `${p}_${(++seq).toString(36)}${now().toString(36)}`

async function runPrompt(sessionId, text) {
  const s = SESSION(sessionId)
  if (!s) return
  const userMsg = {
    info: { id: mkId('msg'), sessionID: sessionId, role: 'user', time: { created: now() }, parts: [] },
    parts: [{ id: mkId('prt'), type: 'text', text }],
  }
  const aid = mkId('msg')
  const assistantMsg = {
    info: { id: aid, sessionID: sessionId, role: 'assistant', time: { created: now() }, agent: 'mock', modelID: 'mock-model', providerID: 'mock', tokens: { input: 10, output: 0, total: 10 } },
    parts: [],
  }
  s.messages.push(userMsg, assistantMsg)
  publish(s.info.directory, { type: 'message.updated', properties: { info: userMsg.info } })
  publish(s.info.directory, { type: 'message.updated', properties: { info: assistantMsg.info } })
  publish(s.info.directory, { type: 'session.status', properties: { sessionID: sessionId, status: { type: 'busy' } } })

  const partId = mkId('prt')
  const reply = `OK — mock engine reply to: ${text.slice(0, 80)}`
  // grow the text in chunks (real part snapshots, opencode style)
  const chunks = 6
  for (let i = 1; i <= chunks; i++) {
    await new Promise((r) => setTimeout(r, 450))
    const part = { id: partId, messageID: aid, sessionID: sessionId, type: 'text', text: reply.slice(0, Math.ceil((reply.length * i) / chunks)) }
    const idx = s.messages.findIndex((m) => m.info.id === aid)
    if (idx >= 0) {
      s.messages[idx].parts = [part]
      assistantMsg.info.tokens.output = part.text.length
    }
    publish(s.info.directory, { type: 'message.part.updated', properties: { part } })
  }
  assistantMsg.info.time = { created: assistantMsg.info.time.created, completed: now() }
  assistantMsg.info.tokens = { input: 10, output: reply.length, total: 10 + reply.length }
  publish(s.info.directory, { type: 'message.part.updated', properties: { part: { id: partId, messageID: aid, sessionID: sessionId, type: 'text', text: reply, time: { end: now() } } } })
  publish(s.info.directory, { type: 'session.status', properties: { sessionID: sessionId, status: { type: 'idle' } } })
  publish(s.info.directory, { type: 'session.idle', properties: { sessionID: sessionId } })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  const path = url.pathname
  const m = req.method ?? 'GET'

  if (path === '/global/event') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    res.write(`: connected\n\n`)
    sseClients.add(res)
    req.on('close', () => sseClients.delete(res))
    return
  }

  if (path === '/session' && m === 'POST') {
    const body = await readBody(req)
    const id = mkId('ses')
    const info = { id, title: body.title ?? 'New session', directory: url.searchParams.get('directory') ?? '/', time: { created: now(), updated: now() } }
    sessions.set(id, { info, messages: [] })
    // opencode returns the session object directly (the SDK wraps it as data).
    return json(res, 200, info)
  }
  if (path === '/session' && m === 'GET') {
    return json(res, 200, [...sessions.values()].map((s) => s.info))
  }
  const sm = path.match(/^\/session\/([^/]+)(\/.*)?$/)
  if (sm) {
    const id = decodeURIComponent(sm[1])
    const sub = sm[2] ?? ''
    const s = SESSION(id)
    if (path === '/session/status' || path === '/session/status/') {
      // global status map {sessionId: {type}}
      const map = {}
      for (const [sid, s] of sessions) map[sid] = { type: s.busy ? 'busy' : 'idle' }
      return json(res, 200, map)
    }
    if (!s) return json(res, 404, { error: 'not found' })
    if (sub === '' && m === 'GET') return json(res, 200, s.info)
    if (sub === '' && m === 'DELETE') { sessions.delete(id); return json(res, 200, { ok: true }) }
    if (sub === '' && (m === 'POST' || m === 'PATCH')) {
      const body = await readBody(req)
      if (body?.title) s.info.title = body.title
      return json(res, 200, s.info)
    }
    if (sub === '/prompt_async' && m === 'POST') {
      const body = await readBody(req)
      const text = (body?.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('')
      s.busy = true
      void runPrompt(id, text)
      return json(res, 200, { ok: true })
    }
    if (sub === '/abort' && m === 'POST') { s.busy = false; return json(res, 200, { ok: true }) }
    if (sub === '/message' && m === 'GET') return json(res, 200, s.messages)
    if (sub === '/children' && m === 'GET') return json(res, 200, [])
    if (sub === '/todo' && m === 'GET') return json(res, 200, [])
    if (sub?.startsWith('/message/') && m === 'GET') {
      const mid = decodeURIComponent(sub.split('/')[2])
      const found = s.messages.find((x) => x.info.id === mid)
      return found ? json(res, 200, found) : json(res, 404, { error: 'not found' })
    }
  }
  if (path === '/config') return json(res, 200, { model: 'mock/mock-model', providers: {} })
  if (path === '/config/providers') {
    return json(res, 200, { providers: [{ id: 'mock', models: [{ id: 'mock-model', name: 'Mock Model', limit: { context: 128000 } }] }] })
  }
  if (path === '/command') return json(res, 200, [])
  if (path === '/agent') return json(res, 200, [])
  return json(res, 200, {})
})

server.listen(PORT, '127.0.0.1', () => console.log(`mock opencode engine on http://127.0.0.1:${PORT}`))
