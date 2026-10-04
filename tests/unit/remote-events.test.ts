import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { startRemoteEvents } from '../../src/core/remote-events'

/** One-shot SSE test server: replies to the first request with the given
 *  frames, keeps the stream open; records auth so per-remote Basic is proven. */
function sseServer(frames: string[]): { server: Server; url: Promise<string>; authSeen: Promise<string | undefined> } {
  let resolveUrl: (u: string) => void
  let resolveAuth: (a: string | undefined) => void
  const url = new Promise<string>((r) => (resolveUrl = r))
  const authSeen = new Promise<string | undefined>((r) => (resolveAuth = r))
  const server = createServer((req, res) => {
    resolveAuth(req.headers.authorization)
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(frames.join(''))
    // hold the stream open like a real SSE endpoint
  })
  server.listen(0, '127.0.0.1', () => resolveUrl(`http://127.0.0.1:${(server.address() as any).port}/global/event`))
  return { server, url, authSeen }
}

describe('startRemoteEvents', () => {
  const handles: Array<{ stop(): void }> = []
  const servers: Server[] = []
  afterEach(() => {
    for (const h of handles) h.stop()
    for (const s of servers) s.close()
    handles.length = 0
    servers.length = 0
  })

  it('parses the envelope and forwards frames to dispatch (with auth header)', async () => {
    const { server, url, authSeen } = sseServer([
      'data: ' + JSON.stringify({ directory: '/x', payload: { type: 'session.idle', properties: { sessionID: 's1' } } }) + '\n\n',
      ': keepalive comment\n\n',
      'garbage line\n\n',
      'data: ' + JSON.stringify({ payload: { type: 'message.part.delta', properties: { partID: 'p', delta: 'hi' } } }) + '\n\n',
    ])
    servers.push(server)

    const seen: Array<{ type?: string; properties?: unknown }> = []
    handles.push(startRemoteEvents({
      name: 'test',
      url: await url,
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
      dispatch: async (ev) => { seen.push(ev) },
    }))

    await new Promise((r) => setTimeout(r, 300))
    expect(seen.map((s) => s.type)).toEqual(['session.idle', 'message.part.delta'])
    expect(seen[1].properties).toEqual({ partID: 'p', delta: 'hi' })
    expect(await authSeen).toBe('Basic dXNlcjpwYXNz')
  })

  it('stop() ends the consumer', async () => {
    const { server, url } = sseServer(['data: ' + JSON.stringify({ payload: { type: 'x' } }) + '\n\n'])
    servers.push(server)
    const seen: unknown[] = []
    const handle = startRemoteEvents({ name: 't2', url: await url, headers: {}, dispatch: async (ev) => { seen.push(ev) } })
    await new Promise((r) => setTimeout(r, 150))
    handle.stop()
    const n = seen.length
    await new Promise((r) => setTimeout(r, 250))
    expect(seen.length).toBe(n)
  })
})
