/** 工件解析与缓存——按**目标平台**选官方 npm 平台包（D4），身份用 sha512（D17）。
 *
 * 面板是 Win/Mac、被控端是 Linux，这是常态而非例外：所以这里从不用
 * `process.platform` 决定取哪个包，目标三元组一律由 target 参数给出。
 *
 * 两条取件路（远端直取 / 面板推送）产物必须是同一个字节序列，因此解析只做一件事：
 * 拿到 `{package, version, integrity, tarball}`。谁去下载是调用方的事。
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { platformPackage } from '../shared/provision.js';
export const NPM_REGISTRY = 'https://registry.npmjs.org';
/** 官方安装脚本下载下来的 tar 内部布局（`package/bin/opencode`）。 */
export const TAR_BINARY_PATH = 'package/bin/opencode';
const packageMetadataUrl = (registry, name, version) => `${registry}/${name.replace('/', '%2F')}/${version}`;
/** 解析某个版本的平台包元数据。版本固定才继续——「跟 latest」是面板宿主的
 *  事，不是被控端的事（D6）。 */
export async function resolveArtifact(target, variant, version, deps = {}) {
    const registry = deps.registry ?? NPM_REGISTRY;
    const fetchImpl = deps.fetchImpl ?? fetch;
    const name = platformPackage(target, variant);
    const response = await fetchImpl(packageMetadataUrl(registry, name, version), {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
        throw new Error(`官方没有 ${name}@${version}（HTTP ${response.status}）——换一个版本或换 baseline 变体`);
    }
    const body = (await response.json());
    const tarball = body.dist?.tarball;
    const integrity = body.dist?.integrity;
    if (typeof tarball !== 'string' || typeof integrity !== 'string') {
        throw new Error(`${name}@${version} 的元数据里没有 dist.tarball/dist.integrity`);
    }
    if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) {
        throw new Error(`${name}@${version} 的 integrity 不是 sha512：${integrity.slice(0, 24)}…`);
    }
    // 官方脚本也只接受 registry 自托管的 tarball（其 v2-install 同款判断）：
    // 指向别处的 integrity 没有意义，因为校验的是那个 URL 的内容。
    if (new URL(tarball).origin !== new URL(registry).origin) {
        throw new Error(`${name}@${version} 的 tarball 不在 npm registry 上（${tarball}）`);
    }
    return {
        package: name,
        version,
        integrity,
        tarballUrl: tarball,
        unpackedBytes: typeof body.dist?.unpackedSize === 'number' ? body.dist.unpackedSize : undefined,
    };
}
/** `sha512-<base64>` 是 npm 的写法；URL-safe 变体也要能比。 */
export function sha512Of(bytes) {
    return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}
export function verifyIntegrity(bytes, integrity) {
    const actual = sha512Of(bytes);
    if (actual !== integrity) {
        throw new Error(`工件校验失败：期望 ${integrity.slice(0, 20)}…，实得 ${actual.slice(0, 20)}…`);
    }
}
const cachePathFor = (dir, ref) => join(dir, `${ref.package.replace('/', '__')}-${ref.version}.tgz`);
/** 面板宿主上的缓存。命中（且校验通过）就不再联网；不命中则下载、
 *  校验、原子落盘——半截文件永远不进缓存，否则 air-gapped 推送会把脏件
 *  送到被控端。 */
export async function fetchArtifactToCache(ref, deps) {
    const target = cachePathFor(deps.dir, ref);
    const cached = await readFile(target).catch(() => null);
    if (cached && sha512Of(cached) === ref.integrity)
        return target;
    if (cached)
        await rm(target, { force: true });
    await mkdir(deps.dir, { recursive: true });
    const fetchImpl = deps.fetchImpl ?? fetch;
    const response = await fetchImpl(ref.tarballUrl, { signal: AbortSignal.timeout(10 * 60_000) });
    if (!response.ok)
        throw new Error(`下载 ${ref.package}@${ref.version} 失败（HTTP ${response.status}）`);
    const bytes = Buffer.from(await response.arrayBuffer());
    verifyIntegrity(bytes, ref.integrity);
    const staging = `${target}.tmp-${process.pid}`;
    await writeFile(staging, bytes);
    await rename(staging, target);
    return target;
}
/** 已有缓存时直接给路径（air-gapped 推送不允许在推送那一刻联网）。 */
export async function cachedArtifactPath(ref, dir) {
    const target = cachePathFor(dir, ref);
    const info = await stat(target).catch(() => null);
    if (!info?.isFile())
        return null;
    const bytes = await readFile(target);
    return sha512Of(bytes) === ref.integrity ? target : null;
}
export function cacheFileName(ref) {
    return `${ref.package.replace('/', '__')}-${ref.version}.tgz`;
}
/** 只保留一个版本的缓存在磁盘上的大小，供 UI 如实提示传输量。 */
export function describeArtifact(ref) {
    const size = ref.unpackedBytes ? `约 ${(ref.unpackedBytes / 1024 / 1024).toFixed(0)} MB（解包后）` : '体积未知';
    return `${ref.package}@${ref.version} · ${size}`;
}
/** 缓存目录：面板宿主自己的命名空间，绝不写别人的 dotfile。 */
export function defaultCacheDir(home) {
    return join(home, '.ocrc', 'artifacts');
}
