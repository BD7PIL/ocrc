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
import {
  sshExec, normalizeVirtualPath, isInsideRoots,
  buildListScript, parseListOutput,
  buildReadScript, buildWriteScript, buildStatScript, buildMkdirScript,
  buildGitScript, parseGitStatus,
} from './remote-fs.js'

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

    // ── batch 4: fs/git-over-ssh (remote workspace face) ────────────────────
    // Every endpoint resolves the ACTIVE profile (last connected), requires the
    // path to be absolute and inside that profile's allowedRoots, then spawns
    // one `ssh <profile> <script>` round-trip. The active profile is the one
    // the supervisor last started — the workspace browser edits what the
    // tunnel points at, never an arbitrary machine.
    if (req.method === 'GET' && url.pathname === '/git-branch') {
      // Badge helper: the FIRST allowed root's branch (best-effort, fast fail).
      const profile = supervisor.activeProfile()
      const root = profile?.allowedRoots?.[0]
      if (!profile || !root) { json(res, 200, { branch: null }); return }
      const { code, stdout } = await sshExec(profile, buildGitScript(root, 'status'), { timeoutMs: 8_000 })
      if (code !== 0) { json(res, 200, { branch: null }); return }
      json(res, 200, { branch: parseGitStatus(stdout).branch ?? null })
      return
    }
    if (url.pathname.startsWith('/fs/') || url.pathname.startsWith('/git/')) {
      const profile = supervisor.activeProfile()
      if (!profile) { json(res, 409, { error: 'no active profile — connect first' }); return }
      const roots = profile.allowedRoots ?? []
      const body = (req.method === 'POST' ? await readBody(req) : {}) as Record<string, unknown>
      const vpath = normalizeVirtualPath(String(body.path ?? url.searchParams.get('path') ?? ''))
      if (!vpath) { json(res, 400, { error: 'path must be absolute without .. segments' }); return }
      if (roots.length === 0 || !isInsideRoots(vpath, roots)) {
        json(res, 403, { error: `path outside allowedRoots (${roots.join(', ') || 'none declared'})` })
        return
      }
      const R = profile

      if (req.method === 'POST' && url.pathname === '/fs/list') {
        const { code, stdout, stderr } = await sshExec(R, buildListScript(vpath), { timeoutMs: 20_000 })
        if (code !== 0) { json(res, 502, { error: stderr.trim().split('\n')[0] || `ssh exit ${code}` }); return }
        const { entries, error } = parseListOutput(stdout)
        if (error) { json(res, 404, { error }); return }
        json(res, 200, { path: vpath, entries })
        return
      }
      if (req.method === 'POST' && url.pathname === '/fs/read') {
        const max = Math.min(Number(body.maxBytes) || 512 * 1024, 2 * 1024 * 1024)
        const { code, stdout, stderr } = await sshExec(R, buildReadScript(vpath, max), { timeoutMs: 30_000 })
        if (code !== 0) { json(res, 502, { error: stderr.trim().split('\n')[0] || `ssh exit ${code}` }); return }
        if (stdout.startsWith('ERR: not-a-file')) { json(res, 404, { error: 'not a file' }); return }
        if (stdout.startsWith('ERR: too-large:')) { json(res, 413, { error: `file larger than ${max} bytes (${stdout.split(':')[2]} total)` }); return }
        const sizeLine = stdout.split('\n').find((l) => l.startsWith('SIZE:'))
        const b64 = stdout.split('\n').filter((l) => !l.startsWith('SIZE:')).join('')
        json(res, 200, { path: vpath, size: sizeLine ? Number(sizeLine.slice(5)) : undefined, encoding: 'base64', content: b64.trim() })
        return
      }
      if (req.method === 'POST' && url.pathname === '/fs/write') {
        const content = typeof body.content === 'string' ? body.content : ''
        const b64 = Buffer.from(content, 'utf-8').toString('base64')
        const { script, stdin } = buildWriteScript(vpath, b64)
        const { code, stdout, stderr } = await sshExec(R, script, { timeoutMs: 30_000, stdin })
        if (code !== 0) { json(res, 502, { error: stderr.trim().split('\n')[0] || `ssh exit ${code}` }); return }
        json(res, 200, { path: vpath, backup: stdout.includes('bak:') ? `${vpath}.bak` : null })
        return
      }
      if (req.method === 'POST' && url.pathname === '/fs/stat') {
        const { code, stdout, stderr } = await sshExec(R, buildStatScript(vpath), { timeoutMs: 15_000 })
        if (code !== 0) { json(res, 502, { error: stderr.trim().split('\n')[0] || `ssh exit ${code}` }); return }
        const kv = new Map(stdout.split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1)]))
        json(res, 200, { path: vpath, type: kv.get('type') ?? 'missing', size: kv.get('size') ? Number(kv.get('size')) : undefined, mtime: kv.get('mtime') ? Number(kv.get('mtime')) : undefined })
        return
      }
      if (req.method === 'POST' && url.pathname === '/fs/mkdir') {
        const { code, stderr } = await sshExec(R, buildMkdirScript(vpath), { timeoutMs: 15_000 })
        if (code !== 0) { json(res, 502, { error: stderr.trim().split('\n')[0] || `ssh exit ${code}` }); return }
        json(res, 200, { path: vpath })
        return
      }

      // git/*: the ROOT is the allowed root itself (or body.root — still
      // allowlist-checked above via vpath).
      const root = vpath
      if (req.method === 'POST' && url.pathname === '/git/status') {
        const { code, stdout } = await sshExec(R, buildGitScript(root, 'status'), { timeoutMs: 20_000 })
        if (code !== 0) { json(res, 502, { error: `ssh exit ${code}` }); return }
        json(res, 200, { root, ...parseGitStatus(stdout) })
        return
      }
      if (req.method === 'POST' && url.pathname === '/git/diff') {
        const paths = Array.isArray(body.paths) ? body.paths.map(String) : undefined
        const { code, stdout } = await sshExec(R, buildGitScript(root, 'diff', { paths }), { timeoutMs: 30_000, maxStdout: 300_000 })
        if (code !== 0) { json(res, 502, { error: `ssh exit ${code}` }); return }
        json(res, 200, { root, diff: stdout })
        return
      }
      if (req.method === 'POST' && url.pathname === '/git/log') {
        const { code, stdout } = await sshExec(R, buildGitScript(root, 'log'), { timeoutMs: 20_000 })
        if (code !== 0) { json(res, 502, { error: `ssh exit ${code}` }); return }
        json(res, 200, { root, log: stdout.split('\n').filter((l) => l.trim()).slice(0, 30) })
        return
      }
      if (req.method === 'POST' && url.pathname === '/git/stage') {
        const paths = Array.isArray(body.paths) ? body.paths.map(String) : undefined
        const { code, stdout, stderr } = await sshExec(R, buildGitScript(root, 'stage', { paths }), { timeoutMs: 30_000 })
        if (code !== 0) { json(res, 502, { error: stderr.trim().split('\n')[0] || `ssh exit ${code}` }); return }
        json(res, 200, { root, ok: stdout.includes('staged') })
        return
      }
      if (req.method === 'POST' && url.pathname === '/git/commit') {
        const message = typeof body.message === 'string' && body.message.trim() ? body.message.trim() : undefined
        if (!message) { json(res, 400, { error: 'message required' }); return }
        const { code, stdout } = await sshExec(R, buildGitScript(root, 'commit', { message }), { timeoutMs: 30_000 })
        if (code !== 0) { json(res, 502, { error: `ssh exit ${code}` }); return }
        const nothing = stdout.includes('nothing-to-commit')
        json(res, nothing ? 409 : 200, { root, committed: !nothing, output: stdout.trim().split('\n')[0] })
        return
      }
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
