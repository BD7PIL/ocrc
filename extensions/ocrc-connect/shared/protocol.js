export const DEFAULT_REMOTE_PORT = 4096;
export const DEFAULT_LOCAL_PORT = 4096;
export function normalizeProfile(raw) {
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
                .map((p) => ({ path: String(p.path ?? '').trim(), label: p.label?.trim() || undefined }))
                .filter((p) => p.path.startsWith('/'))
            : undefined,
        forwards: Array.isArray(raw.forwards) ? raw.forwards : undefined,
        engineVersion: raw.engineVersion?.trim() || undefined,
    };
}
/** argv for the tunnel spawn. One ssh process = every forward + keepalive:
 *  ServerAliveInterval detects a dead peer, ExitOnForwardFailure makes a
 *  busy local port fatal (so the supervisor can report it) instead of
 *  silently sitting on an unforwarded session.
 *
 *  能力补充的转发与主隧道**同一个进程**（D15）：生命周期完全一致，隧道断则
 *  它们一起断，不会留下半条活的侧路。 */
export function buildSshArgs(p) {
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
    ];
    if (p.keyPath)
        args.push('-i', p.keyPath);
    args.push('-L', `127.0.0.1:${p.localPort}:127.0.0.1:${p.remotePort}`);
    for (const forward of p.forwards ?? []) {
        // 端口 0 = 还没分配：分配之前不进 argv，避免 ssh 起在随机端口上而我们不知道。
        if (!forward.port)
            continue;
        args.push(forward.direction === 'local' ? '-L' : '-R', `127.0.0.1:${forward.port}:${forward.peerHost}:${forward.peerPort}`);
    }
    args.push(`${p.user}@${p.host}`);
    return args;
}
