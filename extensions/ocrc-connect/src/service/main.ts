/** ocrc-connect service entry — openchamber spawns this on the PANEL HOST
 *  (Win/Mac) with OPENCHAMBER_SERVICE_PORT / OPENCHAMBER_SERVICE_TOKEN env.
 *  Contract (packages/sdk/GUEST_SERVICES.md): loopback only, /health must
 *  return 200 within 15 s, every request carries
 *  Authorization: Bearer <token>. */
import http from 'node:http'
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createTunnelSupervisor } from './tunnel.js'
import { normalizeProfile, type SshProfile } from '../shared/protocol.js'

const PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT ?? 0)
const TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN ?? ''
const PROFILES_FILE = process.env.OCRC_CONNECT_PROFILES
  ?? join(process.env.OPENCHAMBER_DATA_DIR ?? join(homedir(), '.config', 'openchamber'), 'ocrc-connect-profiles.json')

// Profiles mirror to disk so the service can auto-reconnect the last tunnel
// after a panel-host restart without any panel interaction.
function loadProfiles(): SshProfile[] {
  try {
    const raw = JSON.parse(readFileSync(PROFILES_FILE, 'utf-8')) as { profiles?: SshProfile[] }
    return (raw.profiles ?? []).map((p) => normalizeProfile(p))
  } catch { return [] }
}

function saveProfiles(profiles: SshProfile[]): void {
  mkdirSync(join(PROFILES_FILE, '..'), { recursive: true })
  writeFileSync(PROFILES_FILE, JSON.stringify({ profiles }, null, 2))
}

const supervisor = createTunnelSupervisor()

function json(res: http.ServerResponse, code: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body))
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': buf.length })
  res.end(buf)
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')
}

const server = http.createServer(async (req, res) => {
  // Guest-service contract: bearer token on everything (including /health).
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) {
    json(res, 401, { error: 'unauthorized' })
    return
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, { ok: true })
      return
    }
    if (req.method === 'GET' && url.pathname === '/status') {
      json(res, 200, { status: await supervisor.statusProbed(), profiles: loadProfiles() })
      return
    }
    if (req.method === 'POST' && url.pathname === '/profiles') {
      const body = (await readBody(req)) as { profile: Partial<SshProfile> & { host: string } }
      const profiles = loadProfiles()
      const p = normalizeProfile(body.profile)
      const next = [...profiles.filter((x) => x.id !== p.id), p]
      saveProfiles(next)
      json(res, 200, { profiles: next })
      return
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/profiles/')) {
      const id = decodeURIComponent(url.pathname.split('/').pop() ?? '')
      const next = loadProfiles().filter((p) => p.id !== id)
      saveProfiles(next)
      json(res, 200, { profiles: next })
      return
    }
    if (req.method === 'POST' && url.pathname === '/connect') {
      const body = (await readBody(req)) as { profileId?: string }
      const profiles = loadProfiles()
      const p = profiles.find((x) => x.id === body.profileId)
      if (!p) { json(res, 404, { error: 'profile not found' }); return }
      if (!existsSync('/usr/bin/ssh') && !existsSync('/bin/ssh') && process.platform !== 'win32') {
        // Best-effort guard; ssh may live elsewhere on PATH — the spawn error
        // path reports it properly if truly missing.
      }
      supervisor.start(p)
      json(res, 200, { status: await supervisor.statusProbed() })
      return
    }
    if (req.method === 'POST' && url.pathname === '/disconnect') {
      supervisor.stop()
      json(res, 200, { status: supervisor.status() })
      return
    }
    json(res, 404, { error: 'not found' })
  } catch (e) {
    json(res, 500, { error: e instanceof Error ? e.message : String(e) })
  }
})

if (!PORT) {
  console.error('[ocrc-connect] OPENCHAMBER_SERVICE_PORT missing — not launched by openchamber?')
  process.exit(1)
}
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[ocrc-connect] service listening on 127.0.0.1:${PORT}`)
})

// Auto-reconnect the last-used profile (lowest-friction resume after a panel
// host reboot): the panel persists "lastProfileId" in host.storage and passes
// it on /connect; here we only restore if exactly one profile exists —
// ambiguity stays a manual choice.
const saved = loadProfiles()
if (saved.length === 1) supervisor.start(saved[0])
