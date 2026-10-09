import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, isAbsolute, join, normalize, relative } from 'node:path'
import {
  ARTIFACT_CAPS,
  WorkflowError,
  type ArtifactPublishRequest,
  type ArtifactVersionRecord,
} from '../../../vendor/zcode-dwf/dist/dynamic-workflow/src/index.js'

/**
 * Artifact bytes — the driver's `executeArtifactPublish`.
 *
 * The vendored contract is explicit about where bytes live: never in the journal
 * (which carries only `uri` + `bytes`), always in a store keyed by the artifact id
 * and version. ocrc's store is the filesystem, `<workflows>/artifacts/<runId>/`, and
 * the `uri` we hand back is the handle the HTTP byte endpoint serves.
 *
 * Only CONTENT members (`file` / `markdown`) reach the driver: preset declarations
 * (chart/table/metrics/board) are journal-only by construction — see the vendored
 * `ARTIFACT_REGISTRY` and its "预置成员根本不过 driver" note.
 *
 * Caps follow the same discipline as world reads: probe cap+1, then REJECT — a
 * half-written deliverable is worse than a refused one.
 */

export interface ArtifactStoreDeps {
  /** Directory holding per-run artifact directories — normally `<ocrcHome>/workflows`. */
  dir: string
  /** Default workspace root; each publish may override it (a run carries its own). */
  cwd: string
  now?: () => number
}

export interface ArtifactByte {
  bytes: Buffer
  contentType: string
}

/** Per-run artifact index: `<id>.v<version>` → what it is. Kept beside the bytes
 *  so the byte endpoint can answer with the right Content-Type without re-deriving
 *  it from a file name that deliberately has no extension. */
interface IndexEntry {
  contentType: string
  bytes: number
  publishedAt: number
  sourcePath?: string
}
type RunIndex = Record<string, IndexEntry>

export interface ArtifactStore {
  /** `cwd` overrides the store's default root — the run's workspace. */
  publish(request: ArtifactPublishRequest, cwd?: string): Promise<ArtifactVersionRecord>
  /** Read back one published version (the byte endpoint). */
  readVersion(runId: string, id: string, version: number): ArtifactByte | undefined
  /** Where a version's bytes live (diagnostics). */
  versionPath(runId: string, id: string, version: number): string
  /** Every published version of a run (the UI artifact list). */
  listVersions(runId: string): Array<{ id: string; version: number; contentType: string; bytes: number; publishedAt: number; sourcePath?: string }>
}

const CONTENT_TYPES: Record<string, string> = {
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.ts': 'text/plain; charset=utf-8',
  '.tsx': 'text/plain; charset=utf-8',
  '.js': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.diff': 'text/plain; charset=utf-8',
  '.patch': 'text/plain; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
}

function contentTypeFor(name: string, override?: unknown): string {
  if (typeof override === 'string' && override.trim()) return override.trim()
  return CONTENT_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream'
}

/** Driver-side artifact failures carry the engine's own codes — the vocabulary is
 *  closed and these are exactly the ones the vendored contract reserves for us. */
type ArtifactErrorCode = ConstructorParameters<typeof WorkflowError>[0]
function fail(code: ArtifactErrorCode, message: string): never {
  throw new WorkflowError(code, message)
}

export function createArtifactStore(deps: ArtifactStoreDeps): ArtifactStore {
  const now = deps.now ?? (() => Date.now())

  const runDir = (runId: string) => {
    if (!/^[A-Za-z0-9._-]+$/.test(runId)) fail('DriverError', `artifact: unsafe runId "${runId}"`)
    return join(deps.dir, 'artifacts', runId)
  }
  const indexPath = (runId: string) => join(runDir(runId), 'index.json')
  const versionKey = (id: string, version: number) => `${id}.v${version}`

  function readIndex(runId: string): RunIndex {
    try { return JSON.parse(readFileSync(indexPath(runId), 'utf-8')) as RunIndex } catch { return {} }
  }
  function writeIndex(runId: string, index: RunIndex): void {
    try {
      mkdirSync(runDir(runId), { recursive: true })
      writeFileSync(indexPath(runId), JSON.stringify(index, null, 2))
    } catch { /* the bytes are already on disk; the index is a convenience */ }
  }

  /** File name on disk: `<id>.v<version><ext>` — the version is part of the name so
   *  a republish never clobbers the previous bytes. */
  function versionPath(runId: string, id: string, version: number): string {
    if (!/^[A-Za-z0-9_.-]+$/.test(id)) fail('DriverError', `artifact: unsafe id "${id}"`)
    // Any extension already on the id is preserved (id "report.md" → report.md.v1).
    return join(runDir(runId), `${id}.v${version}`)
  }

  return {
    versionPath,

    listVersions(runId) {
      const index = readIndex(runId)
      return Object.entries(index)
        .map(([key, entry]) => {
          const dot = key.lastIndexOf('.v')
          const id = dot > 0 ? key.slice(0, dot) : key
          const version = dot > 0 ? Number(key.slice(dot + 2)) : 1
          return { id, version, ...entry }
        })
        .filter((e) => Number.isInteger(e.version))
        .sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version)
    },

    async publish(request, cwdOverride) {
      const cwd = cwdOverride ?? deps.cwd
      const { runId, id, version, op } = request
      if (!/^[A-Za-z0-9_.-]+$/.test(id) || id.length > ARTIFACT_CAPS.maxIdLength) {
        fail('DriverError', `artifact id must match [A-Za-z0-9_.-]{1,${ARTIFACT_CAPS.maxIdLength}}, got "${id}"`)
      }
      const opts = (request.opts ?? {}) as { title?: unknown; description?: unknown; contentType?: unknown }
      const title = typeof opts.title === 'string' ? opts.title.slice(0, ARTIFACT_CAPS.maxTitleLength) : undefined
      const description = typeof opts.description === 'string'
        ? opts.description.slice(0, ARTIFACT_CAPS.maxDescriptionLength)
        : undefined

      let bytes: Buffer
      let contentType: string
      let sourcePath: string | undefined

      if (op === 'file') {
        const rel = request.path
        if (typeof rel !== 'string' || !rel) fail('DriverError', 'artifact.file requires a path')
        const abs = isAbsolute(rel) ? normalize(rel) : normalize(join(cwd, rel))
        const inside = relative(cwd, abs)
        if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
          fail('ArtifactPathOutsideWorkspace', `artifact.file path escapes the workspace: ${rel}`)
        }
        if (!existsSync(abs)) fail('ArtifactSourceMissing', `artifact.file source does not exist: ${rel}`)
        const st = statSync(abs)
        if (!st.isFile()) fail('ArtifactSourceMissing', `artifact.file source is not a file: ${rel}`)
        // cap+1 probe: reject rather than copy a 2 GB file and then notice.
        if (st.size > ARTIFACT_CAPS.maxFileBytes) {
          fail('ArtifactTooLarge', `artifact.file source is ${st.size} bytes, over the ${ARTIFACT_CAPS.maxFileBytes} byte cap`)
        }
        bytes = readFileSync(abs)
        if (bytes.byteLength > ARTIFACT_CAPS.maxFileBytes) {
          fail('ArtifactTooLarge', `artifact.file read ${bytes.byteLength} bytes, over the ${ARTIFACT_CAPS.maxFileBytes} byte cap`)
        }
        contentType = contentTypeFor(rel, opts.contentType)
        sourcePath = inside.split('\\').join('/')
      } else if (op === 'markdown') {
        const content = request.content
        if (typeof content !== 'string') fail('DriverError', 'artifact.markdown requires content')
        bytes = Buffer.from(content, 'utf-8')
        if (bytes.byteLength > ARTIFACT_CAPS.maxMarkdownBytes) {
          fail('ArtifactTooLarge', `artifact.markdown is ${bytes.byteLength} bytes, over the ${ARTIFACT_CAPS.maxMarkdownBytes} byte cap`)
        }
        contentType = contentTypeFor('x.md', opts.contentType)
      } else {
        // Preset families never reach the driver; anything else is a wiring error.
        fail('ArtifactKindMismatch', `artifact op "${String(op)}" is not a content member`)
      }

      const dir = runDir(runId)
      try { mkdirSync(dir, { recursive: true }) } catch { /* handled by the write below */ }
      const target = versionPath(runId, id, version)
      try {
        writeFileSync(target, bytes)
      } catch (err) {
        fail('ArtifactStoreUnavailable', `artifact store write failed: ${(err as Error).message}`)
      }

      const index = readIndex(runId)
      index[versionKey(id, version)] = {
        contentType,
        bytes: bytes.byteLength,
        publishedAt: now(),
        ...(sourcePath ? { sourcePath } : {}),
      }
      writeIndex(runId, index)

      return {
        id,
        kind: op,
        version,
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
        contentType,
        bytes: bytes.byteLength,
        uri: `ocrc-artifact://${runId}/${id}/v${version}`,
        ...(sourcePath ? { sourcePath } : {}),
        publishedAt: now(),
      }
    },

    readVersion(runId, id, version) {
      const file = versionPath(runId, id, version)
      if (!existsSync(file)) return undefined
      try {
        const indexed = readIndex(runId)[versionKey(id, version)]?.contentType
        return { bytes: readFileSync(file), contentType: indexed ?? contentTypeFor(id) }
      } catch { return undefined }
    },
  }
}
