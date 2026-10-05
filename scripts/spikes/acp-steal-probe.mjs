// Probe: spawn `kimi acp`, session/load the session that was stolen by the TUI
// mid-turn on 2026-07-24, and dump what the replay contains. Question: does the
// replayed history include the post-steal content (i.e. can OCRC resync), and
// does load on a non-owned session even work?
import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'

const SID = 'session_18e56da4-ade3-4722-90c0-02bdeff4a41f'
const CWD = '/Users/xtation/AgentWorks/Code_Opencode/opencode-remote-control'

const child = spawn('kimi', ['acp'], { stdio: ['pipe', 'pipe', 'inherit'], env: process.env })
child.on('error', (e) => { console.error('[probe] spawn error', e); process.exit(1) })

const counts = {}
const tail = []
const conn = new ClientSideConnection(
  () => ({
    sessionUpdate: (p) => {
      const u = p.update ?? p
      counts[u.sessionUpdate] = (counts[u.sessionUpdate] ?? 0) + 1
      tail.push(JSON.stringify(u).slice(0, 300))
      if (tail.length > 8) tail.shift()
      return Promise.resolve()
    },
    requestPermission: () => Promise.resolve({ outcome: { outcome: 'cancelled' } }),
  }),
  ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
)

await conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
console.error('[probe] initialized')

try {
  const r = await conn.loadSession({ sessionId: SID, cwd: CWD, mcpServers: [] })
  console.error('[probe] loadSession OK:', JSON.stringify(r).slice(0, 300))
} catch (e) {
  console.error('[probe] loadSession FAILED:', e?.message ?? String(e))
}

await new Promise((r) => setTimeout(r, 3000))
console.error('[probe] update counts:', JSON.stringify(counts))
console.error('[probe] last updates:')
for (const t of tail) console.error('  ', t)
child.kill()
process.exit(0)
