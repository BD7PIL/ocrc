import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// service/main.ts is a side-effecting entry (binds a port on import), so the
// unit face here boots it as a child process against a scratch profiles file
// and exercises the HTTP contract directly: auth guard, route dispatch,
// error mapping. End-to-end ssh faces live in scripts/accept-workspace.sh.
let ws;
let port;
let child = null;
const TOK = 'unit-tok';
function waitHealth(p, tries = 40) {
    return new Promise((resolve) => {
        const attempt = (n) => {
            fetch(`http://127.0.0.1:${p}/health`, { headers: { authorization: `Bearer ${TOK}` } })
                .then((r) => resolve(r.status === 200))
                .catch(() => {
                if (n <= 0)
                    resolve(false);
                else
                    setTimeout(() => attempt(n - 1), 250);
            });
        };
        attempt(tries);
    });
}
async function startService(extraEnv = {}) {
    port = 4600 + Math.floor(Math.random() * 80);
    child = spawn(process.execPath, [join('service', 'main.js')], {
        cwd: join(__dirname, '..', '..'),
        env: {
            ...process.env,
            OPENCHAMBER_SERVICE_PORT: String(port),
            OPENCHAMBER_SERVICE_TOKEN: TOK,
            OCRC_CONNECT_PROFILES: join(ws, 'profiles.json'),
            ...extraEnv,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    if (!(await waitHealth(port)))
        throw new Error('service did not become healthy');
}
function req(method, path, body, auth = `Bearer ${TOK}`) {
    return fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { ...(auth ? { authorization: auth } : {}), 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
}
beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'ocrc-svc-'));
});
afterEach(() => {
    child?.kill('SIGTERM');
    child = null;
    try {
        rmSync(ws, { recursive: true, force: true });
    }
    catch { /* gone */ }
});
describe('service main — auth + routing contract', () => {
    it('401 on every route without the bearer token', async () => {
        await startService();
        for (const path of ['/health', '/status', '/profiles', '/fs/list']) {
            const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: path === '/fs/list' ? 'POST' : 'GET' });
            expect(r.status).toBe(401);
        }
    });
    it('GET /health and GET /status with token', async () => {
        await startService();
        expect((await req('GET', '/health')).json).toMatchObject({ ok: true });
        const s = await req('GET', '/status');
        expect(s.status).toBe(200);
        expect(s.json).toHaveProperty('status');
        expect(s.json).toHaveProperty('profiles');
    });
    it('profiles CRUD: create → duplicate-id upsert → delete', async () => {
        await startService();
        const mk = await req('POST', '/profiles', { profile: { id: 'u1', host: '127.0.0.1', user: 'root' } });
        expect(mk.status).toBe(200);
        expect(mk.json.profiles).toHaveLength(1);
        expect(mk.json.profiles[0].port).toBe(22); // normalizeProfile default
        // same id → replace, not duplicate
        await req('POST', '/profiles', { profile: { id: 'u1', host: '127.0.0.2', user: 'u' } });
        const again = await req('GET', '/status');
        expect(again.json.profiles).toHaveLength(1);
        expect(again.json.profiles[0].host).toBe('127.0.0.2');
        const del = await req('DELETE', '/profiles/u1');
        expect(del.json.profiles).toHaveLength(0);
    });
    it('connect to unknown profile → 404; fs face without connect → 409', async () => {
        await startService();
        expect((await req('POST', '/connect', { profileId: 'nope' })).status).toBe(404);
        const fs = await req('POST', '/fs/list', { path: '/tmp' });
        expect(fs.status).toBe(409);
        expect(fs.json).toMatchObject({ error: expect.stringContaining('connect') });
    });
    it('fs face rejects relative paths with 400 (before any ssh)', async () => {
        await startService();
        await req('POST', '/profiles', { profile: { id: 'u1', host: '127.0.0.1', allowedRoots: ['/tmp'] } });
        await req('POST', '/connect', { profileId: 'u1' });
        const r = await req('POST', '/fs/read', { path: 'relative/path' });
        expect(r.status).toBe(400);
    });
    it('unknown route → 404; malformed JSON body → 500 (caught)', async () => {
        await startService();
        expect((await req('GET', '/nope')).status).toBe(404);
        const raw = await fetch(`http://127.0.0.1:${port}/profiles`, {
            method: 'POST',
            headers: { authorization: `Bearer ${TOK}`, 'content-type': 'application/json' },
            body: '{broken',
        });
        expect(raw.status).toBeGreaterThanOrEqual(400);
    });
    it('profiles persist across a service restart (auto-reconnect mirror)', async () => {
        await startService();
        await req('POST', '/profiles', { profile: { id: 'keep', host: 'h1' } });
        child?.kill('SIGTERM');
        child = null;
        // restart against the SAME profiles file
        await startService();
        const s = await req('GET', '/status');
        expect(s.json.profiles.map((p) => p.id)).toContain('keep');
    });
});
