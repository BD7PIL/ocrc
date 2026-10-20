import { defaultComponentSources } from './components.js'
import { instanceIdFor, type RemoteInstance } from './remote-instance.js'
import type { InstancePlan, RemoteInstanceManager } from './remote-instance-bridge.js'
import type { RemoteInstancesStore } from './remote-instances.js'

/**
 * One-command takeover: the seven existing steps, in the order they have to run.
 *
 * This is a **sequencer, not a new capability** — every step is the same manager
 * call the panel and the individual CLI commands make. Its job is the thing a
 * sequence of shell commands gets wrong: the record has to survive later runs
 * (`uiPassword`, pinned engine path, custom ports), and a warning step
 * (`sync-auth` on a machine with no `auth.json`) must not abort a bootstrap that
 * can still finish.
 *
 * It never touches an adopted engine: `apply`/`up` only own the instance under
 * `~/.ocrc`, and `plan` is read-only.
 */

export type BootstrapStepName = 'record' | 'plan' | 'apply' | 'sync-auth' | 'sync-config' | 'up' | 'pairlink'
export type BootstrapStepStatus = 'ok' | 'warn' | 'failed' | 'skipped'

export interface BootstrapStep {
  name: BootstrapStepName
  status: BootstrapStepStatus
  detail: string
  /** Fatal steps decide `ok`; warning steps print and continue. */
  fatal: boolean
}

export interface BootstrapRecordInput extends Partial<Omit<RemoteInstance, 'id'>> {
  /** Existing record to update. Without it the id is derived from host + user. */
  id?: string
  host?: string
}

export interface BootstrapOptions {
  components?: string[]
  componentsFromPins?: boolean
  /** Default true: push the control side's provider credentials. */
  syncAuth?: boolean
  /** Default true: merge the whitelisted config onto the peer. */
  syncConfig?: boolean
  /** Default true: ask the peer for a fresh pairing link. */
  pairlink?: boolean
  force?: boolean
  engineVersion?: string
  /** Only the local record merge + `plan`; nothing is written to the peer. */
  dryRun?: boolean
  /** Called after `plan`. Returning false stops before `apply`. */
  confirm?: (plan: InstancePlan) => boolean | Promise<boolean>
  onStep?: (step: BootstrapStep) => void
  onLog?: (line: string) => void
}

export interface BootstrapResult {
  ok: boolean
  id: string
  /** The merged record as persisted (or as it would be, for `--dry-run`). */
  record?: RemoteInstance
  plan?: InstancePlan
  steps: BootstrapStep[]
  link?: string
  expiresAt?: string
  url?: string
  dryRun: boolean
  /** True when `confirm` said no — a cancellation, not a failure. */
  cancelled?: boolean
}

/** Drop `undefined` so a patch can never erase a stored field. */
function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>
}

/**
 * Merge the caller's explicit fields into the stored record — **never** a
 * fresh-record overwrite.
 *
 * `store.upsert` assigns its argument over the existing record, so an omitted
 * key passed as `undefined` (or a defaulted CLI flag) silently resets
 * `enginePath`, the ports and `uiPassword`. Bootstrap therefore sends only the
 * fields the user actually named; everything else stays as stored.
 */
export function mergeBootstrapRecord(store: RemoteInstancesStore, input: BootstrapRecordInput): RemoteInstance {
  const { id: inputId, ...fields } = input
  const explicit = defined(fields)
  const wantedId = inputId?.trim()
  const known = wantedId ? store.get(wantedId) : undefined
  const host = (typeof explicit.host === 'string' ? explicit.host.trim() : '') || known?.host
  if (!host) throw new Error('需要 host：给一个已存在的实例 id，或 --target/--host')
  const id = wantedId || instanceIdFor({ host, user: explicit.user ?? known?.user })
  const existing = known ?? store.get(id)

  // Password mode keeps the stored secret when the caller switched modes but
  // gave no new password; key mode still erases it (normalize does that too).
  if (explicit.sshAuth === 'password' && !explicit.sshPassword) {
    if (existing?.sshAuth !== 'password') {
      throw new Error('--ssh-auth password 需要密码：给 --ssh-password，或从终端/stdin 喂一行')
    }
    delete explicit.sshPassword
  }
  if (explicit.sshAuth === 'key') delete explicit.sshPassword

  return store.upsert({ ...explicit, host, id: existing?.id ?? id })
}

/** Component sources for the config steps: the explicit ones plus the pins. */
function componentSources(opts: BootstrapOptions): string[] {
  return [
    ...(opts.components ?? []),
    ...(opts.componentsFromPins ? defaultComponentSources() : []),
  ]
}

export async function bootstrapRemoteInstance(args: {
  store: RemoteInstancesStore
  manager: RemoteInstanceManager
  input: BootstrapRecordInput
  opts?: BootstrapOptions
}): Promise<BootstrapResult> {
  const { store, manager, input } = args
  const opts = args.opts ?? {}
  const dryRun = opts.dryRun === true
  const steps: BootstrapStep[] = []
  const record = (step: BootstrapStep): void => {
    steps.push(step)
    opts.onStep?.(step)
  }
  const skipped = (name: BootstrapStepName, fatal: boolean, detail: string): void => {
    record({ name, status: 'skipped', fatal, detail })
  }

  let merged: RemoteInstance
  try {
    merged = mergeBootstrapRecord(store, input)
    record({ name: 'record', status: 'ok', fatal: true, detail: `已登记 ${merged.id} → ${merged.host}:${merged.port}` })
  } catch (err) {
    record({ name: 'record', status: 'failed', fatal: true, detail: (err as Error).message })
    return { ok: false, id: input.id ?? '', steps, dryRun }
  }
  const id = merged.id

  const skipRest = (from: BootstrapStepName, detail: string): void => {
    const order: BootstrapStepName[] = ['apply', 'sync-auth', 'sync-config', 'up', 'pairlink']
    for (const name of order.slice(order.indexOf(from))) skipped(name, name === 'apply' || name === 'up', detail)
  }

  // ── plan ───────────────────────────────────────────────────────────────────
  let plan: InstancePlan
  try {
    plan = await manager.plan(id)
  } catch (err) {
    record({ name: 'plan', status: 'failed', fatal: true, detail: (err as Error).message })
    skipRest('apply', 'plan 失败，未执行')
    return { ok: false, id, record: merged, steps, dryRun }
  }
  if (!plan.reachable) {
    record({ name: 'plan', status: 'failed', fatal: true, detail: plan.sshError?.trim() || '远程机器不可达' })
    skipRest('apply', '远程机器不可达，未执行')
    return { ok: false, id, record: merged, plan, steps, dryRun }
  }
  record({ name: 'plan', status: 'ok', fatal: true, detail: `可达：${plan.target}（${plan.actions.length} 项动作）` })
  if (dryRun) {
    skipRest('apply', '--dry-run：只预演，未写远程机器')
    return { ok: true, id, record: merged, plan, steps, dryRun: true }
  }

  if (opts.confirm) {
    const yes = await opts.confirm(plan)
    if (!yes) {
      record({ name: 'apply', status: 'skipped', fatal: true, detail: '已取消（未写远程机器）' })
      skipRest('sync-auth', '已取消')
      return { ok: false, id, record: merged, plan, steps, dryRun, cancelled: true }
    }
  }

  // ── apply ──────────────────────────────────────────────────────────────────
  let applied: { ok: boolean; detail: string }
  try {
    applied = await manager.apply(id, {
      components: opts.components,
      componentsFromPins: opts.componentsFromPins,
      force: opts.force,
      engineVersion: opts.engineVersion,
      onLog: opts.onLog,
    })
  } catch (err) {
    applied = { ok: false, detail: (err as Error).message }
  }
  record({ name: 'apply', status: applied.ok ? 'ok' : 'failed', fatal: true, detail: applied.detail })
  if (!applied.ok) {
    skipRest('sync-auth', 'apply 失败，未执行')
    return { ok: false, id, record: merged, plan, steps, dryRun }
  }

  // ── warnings: credentials and config ───────────────────────────────────────
  if (opts.syncAuth === false) {
    skipped('sync-auth', false, '按 --no-sync-auth 跳过')
  } else {
    try {
      const auth = await manager.syncAuth(id)
      record({ name: 'sync-auth', status: auth.ok ? 'ok' : 'warn', fatal: false, detail: auth.detail })
    } catch (err) {
      record({ name: 'sync-auth', status: 'warn', fatal: false, detail: (err as Error).message })
    }
  }

  const sources = componentSources(opts)
  if (opts.syncConfig === false) {
    skipped('sync-config', false, '按 --no-sync-config 跳过')
  } else {
    try {
      const config = await manager.syncConfig(id, sources.length > 0 ? { components: sources } : {})
      record({ name: 'sync-config', status: config.ok ? 'ok' : 'warn', fatal: false, detail: config.detail })
    } catch (err) {
      record({ name: 'sync-config', status: 'warn', fatal: false, detail: (err as Error).message })
    }
  }

  // ── up ─────────────────────────────────────────────────────────────────────
  let up: { ok: boolean; detail: string }
  try {
    up = await manager.up(id)
  } catch (err) {
    up = { ok: false, detail: (err as Error).message }
  }
  record({ name: 'up', status: up.ok ? 'ok' : 'failed', fatal: true, detail: up.detail })
  if (!up.ok) {
    skipped('pairlink', false, '实例没起来，配对链接未生成')
    return { ok: false, id, record: merged, plan, steps, dryRun }
  }

  // ── pairlink ───────────────────────────────────────────────────────────────
  let link: string | undefined
  let expiresAt: string | undefined
  let url: string | undefined
  if (opts.pairlink === false) {
    skipped('pairlink', false, '按 --no-pairlink 跳过')
  } else {
    try {
      const pair = await manager.pairLink(id)
      if (pair.ok && pair.link) {
        link = pair.link
        expiresAt = pair.expiresAt
        record({ name: 'pairlink', status: 'ok', fatal: false, detail: pair.detail })
      } else {
        record({ name: 'pairlink', status: 'warn', fatal: false, detail: pair.detail })
      }
      url = pair.url
    } catch (err) {
      record({ name: 'pairlink', status: 'warn', fatal: false, detail: (err as Error).message })
    }
  }

  return { ok: true, id, record: store.get(id) ?? merged, plan, steps, link, expiresAt, url, dryRun }
}
