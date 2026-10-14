/** fs/git-over-ssh — batch 4 (2.0.0-alpha.4).
 *
 * The openchamber panel's Files/Git routes are bound to the PANEL HOST disk
 * (upstream refuses remote proxying — #3113/#3306), so the remote-workspace
 * face lives HERE: the service (running on the panel host) spawns
 * `ssh <profile> <command>` and every read/write lands on the CONTROLLED
 * host's filesystem. No daemon is added to the remote — ssh exec IS the
 * remote.
 *
 * Write semantics follow the syncConfig family: atomic (temp + mv) and
 * collisions are backed up to *.bak — never silently overwritten.
 * Path safety: every path argument must resolve INSIDE one of the profile's
 * declared workspace roots (allowedRoots); `..` segments and symlinked
 * escapes are rejected before any ssh runs.
 */
import { spawn } from 'node:child_process';
export function sshExec(p, command, opts = {}) {
    return new Promise((resolve) => {
        const args = [
            '-o', 'BatchMode=yes',
            '-o', 'ConnectTimeout=10',
            '-o', 'StrictHostKeyChecking=no',
            '-p', String(p.port || 22),
        ];
        if (p.keyPath)
            args.push('-i', p.keyPath);
        args.push(`${p.user}@${p.host}`, command);
        const child = spawn('ssh', args, { stdio: opts.stdin === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let truncated = false;
        const cap = opts.maxStdout ?? 512 * 1024;
        const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs) : undefined;
        child.stdout?.on('data', (d) => {
            if (stdout.length < cap)
                stdout += d.toString();
            else
                truncated = true;
        });
        child.stderr?.on('data', (d) => { stderr += d.toString(); });
        child.on('error', (err) => {
            if (timer)
                clearTimeout(timer);
            resolve({ code: null, stdout, stderr: `${stderr}\n${err.message}`.trim() });
        });
        child.on('close', (code) => {
            if (timer)
                clearTimeout(timer);
            resolve({ code, stdout: truncated ? stdout + '\n…[truncated]' : stdout, stderr });
        });
        if (opts.stdin !== undefined)
            child.stdin?.end(opts.stdin);
    });
}
/** Reject `..` (dot-segment) paths outright and normalize duplicate slashes. */
export function normalizeVirtualPath(vpath) {
    if (typeof vpath !== 'string' || !vpath.startsWith('/'))
        return null;
    const norm = vpath.replace(/\/+/g, '/');
    if (norm.split('/').includes('..'))
        return null;
    return norm;
}
/** Is `vpath` inside one of the allowed roots? Root boundaries are exact
 *  prefix matches on `/`-separated segments (no `/foo-bar` via root `/foo`). */
export function isInsideRoots(vpath, roots) {
    const n = vpath.replace(/\/+$/, '') || '/';
    return roots.some((r) => {
        const rr = r.replace(/\/+$/, '') || '/';
        return n === rr || n.startsWith(`${rr}/`);
    });
}
/**
 * Build the remote-side sh script for one logical operation. Everything is
 * keyed= output so the caller never scrapes ambiguous text.
 */
export function buildListScript(vpath) {
    const q = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
    return [
        'set -e',
        `P=${q(vpath)}`,
        'if [ ! -d "$P" ]; then echo "ERR: not-a-directory"; exit 0; fi',
        'cd "$P"',
        'ls -1Ap | while IFS= read -r name; do',
        '  case "$name" in',
        '    */) echo "d ${name%/}";;',
        '    *)',
        '      if [ -f "$name" ]; then',
        '        sz=$(wc -c < "$name" | tr -d " ")',
        '        echo "f $name $sz"',
        '      fi',
        '      ;;',
        '  esac',
        'done',
    ].join('\n');
}
export function parseListOutput(stdout) {
    if (stdout.startsWith('ERR: not-a-directory'))
        return { entries: [], error: 'not a directory' };
    const entries = [];
    for (const line of stdout.split('\n')) {
        const t = line.trim();
        if (!t)
            continue;
        if (t.startsWith('d '))
            entries.push({ name: t.slice(2).trim(), type: 'dir' });
        else if (t.startsWith('f ')) {
            const rest = t.slice(2);
            const sp = rest.lastIndexOf(' ');
            if (sp > 0) {
                const size = Number(rest.slice(sp + 1));
                entries.push({ name: rest.slice(0, sp), type: 'file', size: Number.isFinite(size) ? size : undefined });
            }
            else
                entries.push({ name: rest, type: 'file' });
        }
    }
    return { entries };
}
/** Read a file (capped); base64 round-trip so binary/encoding never mangles. */
export function buildReadScript(vpath, maxBytes) {
    const q = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
    return [
        'set -e',
        `P=${q(vpath)}`,
        'if [ ! -f "$P" ]; then echo "ERR: not-a-file"; exit 0; fi',
        `SZ=$(wc -c < "$P" | tr -d " ")`,
        'echo "SIZE:$SZ"',
        `if [ "$SZ" -gt ${maxBytes} ]; then echo "ERR: too-large:$SZ"; exit 0; fi`,
        'base64 < "$P"',
    ].join('\n');
}
/** Atomic write: base64 decode to a temp file in the SAME directory, back up
 *  any existing file to *.bak, then mv over — a crash mid-write never tears
 *  the original (mv within one filesystem is atomic on Linux/macOS/Windows). */
export function buildWriteScript(vpath, b64) {
    const q = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
    const script = [
        'set -e',
        `P=${q(vpath)}`,
        'D=$(dirname "$P")',
        'mkdir -p "$D"',
        'T=$(mktemp "$D/.ocrc-w.XXXXXX")',
        'base64 -d > "$T"',
        'if [ -f "$P" ]; then cp -p "$P" "$P.bak"; echo "bak: $P.bak"; fi',
        'mv "$T" "$P"',
        'echo "written: $P"',
    ].join('\n');
    return { script, stdin: b64 };
}
export function buildStatScript(vpath) {
    const q = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
    return [
        'set -e',
        `P=${q(vpath)}`,
        'if [ -d "$P" ]; then echo "type:dir"',
        'elif [ -f "$P" ]; then',
        '  echo "type:file"',
        '  echo "size:$(wc -c < "$P" | tr -d " ")"',
        '  echo "mtime:$(stat -c %Y "$P" 2>/dev/null || stat -f %m "$P" 2>/dev/null || echo 0)"',
        'else echo "type:missing"; fi',
    ].join('\n');
}
export function buildMkdirScript(vpath) {
    const q = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
    return `mkdir -p ${q(vpath)} && echo "mkdir-ok"`;
}
/** git command builder — always `cd <root> && git …`, no shell interpolation
 *  of user text beyond the quoted root. Subcommands map 1:1 to the endpoints. */
export function buildGitScript(root, sub, args = {}) {
    const q = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
    const cd = `cd ${q(root)} || { echo "ERR: no-root"; exit 0; }`;
    switch (sub) {
        case 'status':
            return [cd, 'git status --porcelain=v1 -b 2>&1 || echo "ERR: not-a-repo"'].join('\n');
        case 'diff': {
            const cap = args.maxDiff ?? 200_000;
            return [cd, `git diff --no-color ${args.paths?.length ? '-- ' + args.paths.map(q).join(' ') : ''} 2>&1 | head -c ${cap}`].join('\n');
        }
        case 'log':
            return [cd, 'git log --oneline -n 30 2>&1 || echo "ERR: not-a-repo"'].join('\n');
        case 'stage':
            return [cd, `git add -- ${args.paths?.length ? args.paths.map(q).join(' ') : '-A'} && echo staged`].join('\n');
        case 'commit':
            return [
                cd,
                `git commit -m ${q(args.message ?? '(no message)')} 2>&1 || { git diff --cached --quiet && echo "nothing-to-commit" || echo "ERR: commit-failed"; }`,
            ].join('\n');
    }
}
export function parseGitStatus(stdout) {
    if (stdout.startsWith('ERR: not-a-repo'))
        return { entries: [], error: 'not a git repository' };
    const lines = stdout.split('\n').filter((l) => l.trim());
    let branch;
    const entries = [];
    for (const line of lines) {
        if (line.startsWith('## ')) {
            branch = line.slice(3).split(/[. ]/)[0] || undefined;
            continue;
        }
        if (line.length > 3)
            entries.push({ x: line[0], y: line[1], path: line.slice(3) });
    }
    return { branch, entries };
}
