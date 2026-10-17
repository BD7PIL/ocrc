/** Shared types between the panel and the service (imported by both). */
import type { ForwardRuntime, ProjectEntry } from './provision.js'

export interface SshProfile {
  id: string
  name: string
  host: string
  port: number
  user: string
  /** Path to the private key on the PANEL HOST machine (Win/Mac). */
  keyPath?: string
  /** Controlled-host engine port (default 4096). */
  remotePort: number
  /** Local forward port on the panel host (default 4096 — openchamber's
   *  auto-detect port; keeping the default means zero env config). */
  localPort: number
  /** Absolute directories ON THE REMOTE the workspace browser may touch
   *  (batch 4 fs/git endpoints). Empty = the whole face stays 403. */
  allowedRoots?: string[]
  /** 主机档案的**子项**：工作目录（D16）。隧道、引擎、运行时都绑主机，
   *  项目只是它下面的一个目录，所以这里是一张表而不是一个字段。 */
  projects?: ProjectEntry[]
  /** 额外转发，与主隧道共生（D15）。端口由服务在连接时分配并回写。 */
  forwards?: ForwardRuntime[]
  /** 面板宿主要镜像的引擎版本（D6）——探测时用来算出漂移。 */
  engineVersion?: string
}

export interface TunnelStatus {
  profileId: string | null
  tunnel: 'up' | 'down' | 'starting'
  engine: 'reachable' | 'unreachable' | 'unknown'
  detail?: string
  since?: number
}

export interface ServiceApiShape {
  status: TunnelStatus
  profiles: SshProfile[]
}

export const DEFAULT_REMOTE_PORT = 4096
export const DEFAULT_LOCAL_PORT = 4096

export function normalizeProfile(raw: Partial<SshProfile> & { host: string }): SshProfile {
  return {
    id: raw.id ?? `p-${Date.now().toString(36)}`,
    name: raw.name?.trim() || raw.host,
    host: raw.host.trim(),
    port: raw.port && raw.port > 0 ? raw.port : 22,
    user: raw.user?.trim() || 'root',
    keyPath: raw.keyPath?.trim() || undefined,
    remotePort: raw.remotePort && raw.remotePort > 0 ? raw.remotePort : DEFAULT_REMOTE_PORT,
    localPort: raw.localPort && raw.localPort > 0 ? raw.localPort : DEFAULT_LOCAL_PORT,
    allowedRoots: Array.isArray(raw.allowedRoots)
      ? raw.allowedRoots.map((r) => String(r).trim()).filter((r) => r.startsWith('/'))
      : undefined,
    projects: Array.isArray(raw.projects)
      ? raw.projects
        .map((p) => ({ path: String((p as ProjectEntry).path ?? '').trim(), label: (p as ProjectEntry).label?.trim() || undefined }))
        .filter((p) => p.path.startsWith('/'))
      : undefined,
    forwards: Array.isArray(raw.forwards) ? raw.forwards : undefined,
    engineVersion: raw.engineVersion?.trim() || undefined,
  }
}

/** argv for the tunnel spawn. One ssh process = every forward + keepalive:
 *  ServerAliveInterval detects a dead peer, ExitOnForwardFailure makes a
 *  busy local port fatal (so the supervisor can report it) instead of
 *  silently sitting on an unforwarded session.
 *
 *  能力补充的转发与主隧道**同一个进程**（D15）：生命周期完全一致，隧道断则
 *  它们一起断，不会留下半条活的侧路。 */
export function buildSshArgs(p: SshProfile): string[] {
  const args = [
    '-N',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    // accept-new is OpenSSH 8.0+; EL7-era ssh (5.3/7.4) rejects the whole
    // option line. Use the permissive classic form — hosts come from an
    // explicit user-authored profile, and the tunnel only forwards loopback.
    '-o', 'StrictHostKeyChecking=no',
    '-p', String(p.port),
  ]
  if (p.keyPath) args.push('-i', p.keyPath)
  args.push('-L', `127.0.0.1:${p.localPort}:127.0.0.1:${p.remotePort}`)
  for (const forward of p.forwards ?? []) {
    // 端口 0 = 还没分配：分配之前不进 argv，避免 ssh 起在随机端口上而我们不知道。
    if (!forward.port) continue
    args.push(
      forward.direction === 'local' ? '-L' : '-R',
      `127.0.0.1:${forward.port}:${forward.peerHost}:${forward.peerPort}`,
    )
  }
  args.push(`${p.user}@${p.host}`)
  return args
}
