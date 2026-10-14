/** Shared types between the panel and the service (imported by both). */
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
    };
}
/** argv for the tunnel spawn. One ssh process = forward + keepalive:
 *  ServerAliveInterval detects a dead peer, ExitOnForwardFailure makes a
 *  busy local port fatal (so the supervisor can report it) instead of
 *  silently sitting on an unforwarded session. */
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
    args.push(`${p.user}@${p.host}`);
    return args;
}
