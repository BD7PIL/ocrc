/**
 * 面板 → ocrc host 的窄口代理（2.0.0-alpha.8「对端能力」）。
 *
 * 面板页面在 guest 沙箱里只能打到本扩展的服务；而远程实例的档案/装机/隧道都在
 * **ocrc host**（`~/.ocrc/remote-instances.json` 与 `core/remote-instance-*`）。
 * 所以这里做一个**只放行 `/api/remote-instance*`** 的转发——不是一个通用代理：
 * 扩展被拿下时，它拿不到 ocrc host 的其它面（会话、设置、workflow…）。
 *
 * 地址来自 `OCRC_HOST_URL`（默认 `http://127.0.0.1:4099`，即本机 ocrc host）。
 */
export const DEFAULT_OCRC_HOST = 'http://127.0.0.1:4099';
/** 只放行这一族路径；前缀匹配之后还要挡 `..`。 */
export const ALLOWED_PATH_PREFIX = '/api/remote-instance';
export function isAllowedPath(path) {
    if (!path.startsWith('/'))
        return false;
    if (path.includes('..'))
        return false;
    return path === ALLOWED_PATH_PREFIX || path.startsWith(`${ALLOWED_PATH_PREFIX}/`) || path.startsWith(`${ALLOWED_PATH_PREFIX}?`);
}
export function resolveOp(op) {
    const id = 'id' in op ? encodeURIComponent(op.id) : '';
    switch (op.op) {
        case 'list': return { path: '/api/remote-instance', method: 'GET' };
        case 'add': return { path: '/api/remote-instance', method: 'POST', body: op.payload };
        case 'patch': return { path: `/api/remote-instance/${id}`, method: 'PATCH', body: op.payload };
        case 'plan': return { path: `/api/remote-instance/${id}/plan`, method: 'POST' };
        case 'apply': return { path: `/api/remote-instance/${id}/apply`, method: 'POST', body: op.payload ?? { confirm: true } };
        case 'up': return { path: `/api/remote-instance/${id}/up`, method: 'POST' };
        case 'down': return { path: `/api/remote-instance/${id}/down`, method: 'POST' };
        case 'status': return { path: `/api/remote-instance/${id}/status`, method: 'GET' };
        case 'logs': return { path: `/api/remote-instance/${id}/logs${op.tail ? `?tail=${op.tail}` : ''}`, method: 'GET' };
        case 'url': return { path: `/api/remote-instance/${id}/url`, method: 'GET' };
        case 'connect': return { path: `/api/remote-instance/${id}/connect`, method: 'GET' };
        case 'delete': return { path: `/api/remote-instance/${id}/delete`, method: 'POST' };
    }
}
export async function callOcrcHost(op, opts = {}) {
    const { path, method, body } = resolveOp(op);
    if (!isAllowedPath(path))
        throw new Error(`path not allowed: ${path}`);
    const base = (opts.baseUrl ?? process.env.OCRC_HOST_URL ?? DEFAULT_OCRC_HOST).replace(/\/+$/, '');
    const doFetch = opts.fetchImpl ?? fetch;
    const res = await doFetch(`${base}${path}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
    const text = await res.text();
    console.log(`[ocrc-connect] ${method} ${path} → ${res.status}`);
    return { status: res.status, body: text || '{}' };
}
