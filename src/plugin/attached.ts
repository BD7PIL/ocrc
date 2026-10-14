import { tool } from '@opencode-ai/plugin'
import type { Hooks } from '@opencode-ai/plugin'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { formatScheduleList, parseScheduleCreate, scheduleCreatedMessage, type ScheduleCreateArgs } from './schedule-tool.js'
import { createWorkflowTools, skillGateHook } from './workflow-tools.js'
import { createRemoteToolsV1 } from './remote-tools.js'
import type { Schedule } from '../core/scheduler.js'
import { ocrcHome } from '../utils/paths.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('attached')

/**
 * ATTACHED mode (P0-3): an ocrc plugin loaded inside an engine whose ocrc HOST
 * already owns the primary lock.
 *
 * In this shape the plugin must own nothing: no web listener, no Telegram poller,
 * no scheduler, no state file — and it needs no bot token either, because the host
 * owns the bot. Its entire job is to put ocrc's tools in front of the model, and
 * every tool is a thin HTTP call back to the host's token-guarded API.
 *
 * Two reasons the tools must be stateless and idempotent:
 *  - opencode keeps duplicate tool names on its list and lets the LAST registration
 *    win at the model face (see docs/workflow-p0-tool-registration.md), so whichever
 *    plugin instance's copy the model reaches must behave identically;
 *  - several workspaces in one engine process each load the plugin, and they all
 *    attach to the same host.
 * That is why ids are assigned by the host, never by the plugin.
 */
export interface AttachedOpts {
  /** Host web base URL, taken from the primary lock the host wrote. */
  baseUrl: string
  /**
   * The host's web token, resolved per call. Lazy on purpose: the host writes the
   * token while it is starting up, so a plugin that attached inside that window
   * must still succeed once the file appears.
   */
  resolveToken: () => string | undefined
  version: string
  /** P0 gate only: expose the `wf_echo` round-trip probe. */
  probe?: boolean
}

export interface AttachedHandle extends Hooks {
  dispose(): Promise<void>
}

/**
 * Read the host's token from the shared token file. Never GENERATES one: an
 * attached plugin must present the HOST's token, and minting a fresh one would
 * only 401 against the host (and could race the host's own write).
 */
export function hostTokenFromDisk(): string | undefined {
  try {
    const t = readFileSync(join(ocrcHome(), 'token'), 'utf-8').trim()
    return t || undefined
  } catch { return undefined }
}

async function call<T>(opts: AttachedOpts, path: string, init?: RequestInit): Promise<T> {
  const token = opts.resolveToken()
  if (!token) throw new Error('host token not readable yet — the host may still be starting')
  const res = await fetch(`${opts.baseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(15000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`ocrc host ${path} → ${res.status}: ${text.slice(0, 200)}`)
  return (text ? JSON.parse(text) : {}) as T
}

/** The error text a tool returns when the host is gone. Tools never throw into
 *  the model — a dead host must read as a plain tool failure, not a crash. */
function hostDown(opts: AttachedOpts, toolName: string, err: unknown): string {
  log.warn(`${toolName}: host call failed: ${(err as Error).message}`)
  return `${toolName} failed: ocrc host unreachable at ${opts.baseUrl} (${(err as Error).message}). The host that owned this session may have stopped; restart ocrc and retry.`
}

export function createAttachedHooks(opts: AttachedOpts): AttachedHandle {
  const tools: Record<string, ReturnType<typeof tool>> = {
    'rc-status': tool({
      description: 'Show ocrc plugin status',
      args: {},
      async execute() {
        try {
          const s = await call<{ version: string; mode: string; pid: number; webPort: number; telegram: { connected: boolean; username?: string } | null; uptimeSeconds: number }>(opts, '/api/attach/status')
          return [
            `ocrc v${s.version} (host ${s.mode}, attached)`,
            `Host pid:   ${s.pid}`,
            `Web:        listening :${s.webPort}`,
            `Telegram:   ${s.telegram?.connected ? `active${s.telegram.username ? ` (@${s.telegram.username})` : ''}` : 'inactive'}`,
            `Uptime:     ${Math.round(s.uptimeSeconds / 60)} min`,
          ].join('\n')
        } catch (err) {
          return hostDown(opts, 'rc-status', err)
        }
      },
    }),
    notify: tool({
      description: 'Send the user a push notification (e.g. when a long task or tests finish).',
      args: { message: tool.schema.string().describe('The notification text to push to the user') },
      async execute(args: { message: string }, context: any) {
        try {
          await call(opts, '/api/attach/notify', {
            method: 'POST',
            body: JSON.stringify({ message: args.message, sessionId: context?.sessionID }),
          })
          return 'notification sent'
        } catch (err) {
          return hostDown(opts, 'notify', err)
        }
      },
    }),
    'schedule_create': tool({
      description:
        'Create a scheduled prompt that runs automatically on a repeating schedule (cron-like). ' +
        'ONLY use when the user EXPLICITLY asks for something to run repeatedly or on a schedule ' +
        '(e.g. "每天9点巡检失败用例", "every 30 minutes check the queue"). Never use for one-off requests. ' +
        'The prompt must be self-contained: each fire starts a fresh context with no memory of this conversation.',
      args: {
        prompt: tool.schema.string().describe('The complete prompt to execute at every fire — self-contained'),
        every_minutes: tool.schema.number().optional().describe('Run every N minutes (e.g. 30). Provide this OR daily_time, not both'),
        daily_time: tool.schema.string().optional().describe('Run daily at HH:MM local time (e.g. "09:00"). Provide this OR every_minutes, not both'),
        title: tool.schema.string().optional().describe('Short human-readable name; defaults to the trimmed prompt'),
      },
      async execute(args: ScheduleCreateArgs) {
        const parsed = parseScheduleCreate(args)
        if (!parsed.ok) return parsed.error
        try {
          const res = await call<{ schedule?: { id: string }; error?: string }>(opts, '/api/schedules', {
            method: 'POST',
            body: JSON.stringify({ name: parsed.name, prompt: parsed.prompt, spec: parsed.spec, enabled: true }),
          })
          if (!res.schedule) return `schedule_create failed: ${res.error ?? 'could not persist the schedule'}`
          return scheduleCreatedMessage(res.schedule, parsed.prompt, parsed.human)
        } catch (err) {
          return hostDown(opts, 'schedule_create', err)
        }
      },
    }),
    'schedule_list': tool({
      description: 'List the scheduled prompts (recurring tasks) with id, schedule and enabled state.',
      args: {},
      async execute() {
        try {
          const res = await call<{ schedules: Schedule[] }>(opts, '/api/schedules')
          return formatScheduleList(res.schedules ?? [])
        } catch (err) {
          return hostDown(opts, 'schedule_list', err)
        }
      },
    }),
  }

  if (opts.probe) {
    // P0 gate probe. The run id comes BACK from the host, which is the point:
    // it proves the call went to the host and that ids are host-assigned.
    tools.wf_echo = tool({
      description: 'P0 probe: round-trip a value through the ocrc host and return the host-assigned run id.',
      args: { value: tool.schema.string().describe('Value to echo back') },
      async execute(args: { value: string }) {
        try {
          const res = await call<{ value: string; runId: string; hostPid: number }>(opts, '/api/attach/echo', {
            method: 'POST',
            body: JSON.stringify({ value: args.value }),
          })
          return `wf_echo ok: value=${res.value} runId=${res.runId} hostPid=${res.hostPid}`
        } catch (err) {
          return hostDown(opts, 'wf_echo', err)
        }
      },
    })
  }

  // P3: the workflow tool face (author-side + actor-side) is part of the attached
  // set — an engine session is both the place workflows are authored and the place
  // their subagents run, so both halves must be visible to the same model.
  Object.assign(tools, createWorkflowTools(opts))

  // Batch 3 (2.0.0-alpha.3): the remote-channel four-tool face — every handler
  // proxies to the host's token-guarded API (the host owns the manager), same
  // stateless-and-idempotent contract as every other attached tool.
  Object.assign(tools, createRemoteToolsV1({ attached: opts }))

  log.info(`ATTACHED to ${opts.baseUrl} — ${Object.keys(tools).length} tool(s), no transports`)

  return {
    tool: tools,
    // The skill gate: opencode's own `skill` tool is how the model loads the
    // authoring contract, so this hook is what opens it. A hook owns no resources
    // (no listener, no poller, no state file) — ATTACHED's promise is intact.
    'tool.execute.before': skillGateHook(),
    async dispose() {
      // Nothing to tear down: we own no listener, no poller, no timers, and we do
      // not hold the primary lock (the host does).
      log.info('attached plugin disposing (no owned resources)')
    },
  }
}
