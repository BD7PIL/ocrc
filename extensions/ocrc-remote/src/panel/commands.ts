/** 斜杠命令：把被控机的现状**交给模型**，而不是再做一个面板页。
 *
 * 动线裁决（见 docs/handoff/panel-fusion-and-provisioning.md）：openchamber 的
 * 项目/传输 API 对 guest 完全不开放，所以「连接我们通道」的入口只能走它已经开放
 * 的那几面。`contributes.commands` + `host.onResolve` 是其中最贴近原生动线的一
 * 面：用户在 composer 里敲 `/ocrc-host`，宿主把它变成一个 chip（和 issue/pull
 * 请求同一个形态）贴进对话——模型随后就能读到「这台主机现在是什么状态、还差什
 * 么」，并接着安排动作。真正的写操作仍然发生在面板上（一次确认，D3）。
 *
 * 契约要点（`@openchamber/sdk/dist/contract.d.ts`）：
 *   · chip 五个必填字段 providerId/id/title/url/text 齐全，`providerId` 必须匹配
 *     `/^[a-z][a-z0-9-]*$/`；text/title 由 SDK 按上限截断。
 *   · `onResolve` 同一时刻只能有一个处理者——**所以绝不能加 `background.entry`**：
 *     那会把 onResolve 交给隐藏帧（API.md:281），面板里这份注册就静默失效。
 *   · 抛异常 = 用户看到一条报错 toast；返回 null = 宿主只给一条短提示。凡是用户
 *     需要知道原因的（服务没起、档案不存在、没连上）都走抛异常。
 */
import type { AttachIssueRequest, HostClient, StartSessionResult } from '@openchamber/sdk'
import type { CapabilityReport, DetectReport, ReadinessReport } from '../shared/provision.js'
import type { ServiceApiShape, SshProfile, TunnelStatus } from '../shared/protocol.js'
import { call, post, type RequestFn } from '../shared/service-client.js'

export const HOST_COMMAND = 'ocrc-host'
export const PLAN_COMMAND = 'ocrc-plan'

/** `ocrc-host` 说现状；`ocrc-plan` 说「还差什么、按什么顺序」。同一份事实，两种讲法。 */
export type HostSummaryMode = 'status' | 'plan'

export interface HostFacts {
  profile: SshProfile
  /** 这份档案当前是不是连接中的那一份——不是的话，现状探不到，只能报档案本身。 */
  active: boolean
  tunnel?: TunnelStatus
  readiness?: ReadinessReport
  detect?: DetectReport
  /** 面板宿主锚定的引擎版本（D6：镜像面板宿主，不 follow latest）。 */
  anchor?: string
  anchorSource?: string
  projectPath?: string
  caps?: CapabilityReport
  /** 探测失败的原因（服务未运行 / ssh 不通）；如实写进摘要，不假装是「就绪」。 */
  probeError?: string
  /** 能力盘点失败的原因（配置读不到、路径不存在…）。 */
  capsError?: string
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

const address = (p: SshProfile) => `${p.user}@${p.host}:${p.port}`

const transport = (p: SshProfile) => `面板宿主 127.0.0.1:${p.localPort} → 被控端 127.0.0.1:${p.remotePort}`

function tunnelLine(status: TunnelStatus | undefined): string {
  if (!status) return '未知'
  const up = status.tunnel === 'up' ? '已连接' : status.tunnel === 'starting' ? '建立中' : '未连接'
  const engine = status.tunnel !== 'up' ? ''
    : status.engine === 'reachable' ? ' · 引擎可达' : status.engine === 'unreachable' ? ' · 引擎不可达' : ''
  return `${up}${engine}${status.detail ? ` · ${status.detail}` : ''}`
}

function systemLine(detect: DetectReport): string {
  const parts = [
    detect.os,
    detect.kernel ? `kernel ${detect.kernel}` : '',
    detect.glibc ? `glibc ${detect.glibc}` : '',
    detect.container && detect.container !== 'none' ? `容器（${detect.container}）` : '物理机/VM',
    detect.platform ?? '平台未识别',
    detect.baseline ? '无 AVX2 → 需要 baseline 构建' : '',
    detect.outbound === true ? '可出网（被控端能自己取件）' : detect.outbound === false ? '不出网（走面板推送）' : '出网未知',
    // 运行时补齐全靠这两个——缺了就说缺了，别让模型以为能装。
    detect.node ? `node ${detect.node}${detect.nodeOk ? '' : '（低于运行时下限）'}` : '没有 node',
    detect.npm ? `npm ${detect.npm}` : '没有 npm',
  ]
  return parts.filter(Boolean).join(' · ')
}

/** 就绪四档逐档一行；缺的那档把「能做的事」也带上（readinessAction 的话）。 */
function readinessBlock(readiness: ReadinessReport | undefined): string[] {
  if (!readiness) return ['（没探到——先看上面的原因）']
  const lines = readiness.steps.map((s) => `  ${s.ok ? '✓' : '✗'} ${s.label} — ${s.detail}`)
  for (const s of readiness.steps) {
    if (!s.ok && s.action) lines.push(`      → ${s.action}`)
  }
  return lines
}

function capabilityLines(caps: CapabilityReport): string[] {
  if (caps.capabilities.length === 0) return ['（这份项目配置里没有可盘点的 MCP 能力）']
  return caps.capabilities.map((c) => {
    const needs = [
      c.needs.runtime?.length ? `运行时 ${c.needs.runtime.join(', ')}` : '',
      c.needs.network?.length ? `网络 ${c.needs.network.join(', ')}` : '',
      c.needs.secrets?.length ? `密钥 ${c.needs.secrets.join(', ')}（只引用名字，值不进配置文件）` : '',
    ].filter(Boolean).join(' · ')
    return `  · ${c.label}（${c.where === 'remote' ? '远端' : '面板'}）— ${needs || '无额外需求'}`
  })
}

/** 纯函数：同样的现状 + 同样的讲法 → 同样的文本。测试与 CDP 断言都对着它写。 */
export function buildHostSummary(facts: HostFacts, mode: HostSummaryMode = 'status'): { title: string; text: string } {
  const { profile } = facts
  const pending = (facts.readiness?.steps ?? []).filter((s) => !s.ok)
  const name = profile.name || address(profile)

  const title = mode === 'plan'
    ? `ocrc 主机待办 · ${name}${pending.length ? `（${pending.length} 项）` : '（无待办）'}`
    : `ocrc 远端主机 ${name}${pending.length ? `（${pending.length} 项待办）` : facts.readiness ? '（四档就绪）' : ''}`

  const head = mode === 'plan' ? '【ocrc 远端主机待办】' : '【ocrc 远端主机现状】'
  const lines: string[] = [head, `档案：${name}（${address(profile)}）`, `隧道：${transport(profile)} · ${tunnelLine(facts.tunnel)}`]

  if (!facts.active) {
    lines.push(
      '',
      `档案「${name}」当前不是连接中的那一份——现状探测需要一条活的 ssh。`,
      '先在面板 ocrc Connect → 连接 里连上它，再重新提交这个命令。',
    )
    return { title, text: lines.join('\n') }
  }

  if (facts.detect) lines.push(`系统：${systemLine(facts.detect)}`)
  if (facts.probeError) lines.push(`探测失败：${facts.probeError}`)

  if (facts.detect?.legacyEngine) {
    lines.push(`用户既有安装：${facts.detect.legacyEngine.version || '（版本未知）'} @ ${facts.detect.legacyEngine.path}（ocrc 不覆盖它）`)
  }
  lines.push(`工作目录：${facts.projectPath ?? '（档案还没有绑定工作目录）'}`)

  if (facts.readiness) {
    const okCount = facts.readiness.steps.filter((s) => s.ok).length
    lines.push('', `就绪四档（${okCount}/${facts.readiness.steps.length}${facts.readiness.ready ? '，全部就绪' : ''}）：`, ...readinessBlock(facts.readiness))
  } else {
    // 探不到就写探不到：空着会被读成「没问题」。
    lines.push('', '就绪四档：（没探到——先看上面的原因）')
  }

  const engine = facts.detect?.engine
  lines.push('', '引擎：' + (engine
    ? `${engine.path} → ${engine.version}${facts.anchor ? (engine.version === facts.anchor ? `（面板宿主锚点 ${facts.anchor}，一致）` : `（面板宿主锚点 ${facts.anchor}，**版本漂移**）`) : ''}`
    : '~/.opencode/bin 里还没有引擎——可在主机视图「部署引擎」把面板宿主的那一份装过去'))
  if (facts.anchorSource) lines.push(`锚点来源：${facts.anchorSource}`)

  if (facts.projectPath) {
    lines.push('', `能力盘点（${facts.projectPath}）：`)
    if (facts.caps) {
      lines.push(...capabilityLines(facts.caps))
      if (facts.caps.forwards.length) {
        lines.push(`  需要补 ${facts.caps.forwards.length} 条转发（与主隧道同一个 ssh 进程）：`)
        for (const f of facts.caps.forwards) {
          lines.push(`    ${f.direction === 'local' ? '-L' : '-R'} 127.0.0.1:${f.port} → ${f.peerHost}:${f.peerPort}　(${f.reason})`)
        }
      }
      for (const r of facts.caps.rewrites) lines.push(`  URL 改写：${r.from} → ${r.to}`)
      for (const n of facts.caps.notes) lines.push(`  说明：${n}`)
      if (facts.caps.config.parseError) lines.push(`  注意：${facts.caps.config.targetPath} 解析失败（${facts.caps.config.parseError}）`)
    } else {
      lines.push(`  （盘点失败：${facts.capsError ?? '未知原因'}）`)
    }
  }

  lines.push('', mode === 'plan'
    ? '请按这份现状安排「先补什么、后补什么」，并指出哪几步我不能替你自动做。'
    : '请基于这份现状给出判断与建议；需要写被控端的动作都在面板上执行（一次显式确认）。')
  lines.push('（本段由 ocrc-remote 的主机视图探测生成；写被控端的动作都要在面板上确认，传输凭据不离开面板宿主。）')

  return { title, text: lines.join('\n') }
}

/** chip 的机器可读尾巴：模型与面板都不必去 parse 上面那段人话。 */
export function buildHostChip(facts: HostFacts, mode: HostSummaryMode = 'status'): AttachIssueRequest {
  const { title, text } = buildHostSummary(facts, mode)
  const steps = facts.readiness?.steps ?? []
  return {
    providerId: 'ocrc',
    id: `host:${facts.profile.id}`,
    title,
    url: `http://127.0.0.1:${facts.profile.localPort}/`,
    text,
    author: 'ocrc-remote',
    data: {
      profileId: facts.profile.id,
      host: `${facts.profile.host}:${facts.profile.port}`,
      user: facts.profile.user,
      projectPath: facts.projectPath ?? null,
      ready: facts.readiness?.ready ?? null,
      pendingSteps: steps.filter((s) => !s.ok).map((s) => s.id),
      engineVersion: facts.detect?.engine?.version ?? null,
      anchorVersion: facts.anchor ?? null,
      capabilities: (facts.caps?.capabilities ?? []).map((c) => ({ id: c.id, where: c.where })),
      forwards: (facts.caps?.forwards ?? []).length,
    },
  }
}

/** 探测三件事：档案现状 / 四档就绪与引擎 / 项目能力。跨 ssh 的失败都落成事实字段，
 *  只有「连服务都问不到」才抛——那说明扩展没在跑，用户必须知道。 */
export async function collectHostFacts(
  request: RequestFn,
  args = '',
  options: { projectPath?: string } = {},
): Promise<HostFacts> {
  let state: ServiceApiShape
  try {
    state = await call<ServiceApiShape>(request, '/status')
  } catch (e) {
    throw new Error(`ocrc 服务没有应答（${message(e)}）——openchamber 里 ocrc Connect 扩展是否在运行？`)
  }

  const wanted = args.trim()
  const known = () => state.profiles.map((p) => p.name).join('、') || '（一个都没有）'
  // 三档解析：点名 > 连接中的那一份 > 唯一的一份（没连上也能报档案本身，摘要会说
  // 明「不是连接中的那一份」）。多份且都没连 = 有歧义，必须让用户点名。
  const profile = (wanted
    ? state.profiles.find((p) => p.id === wanted || p.name === wanted)
    : state.profiles.find((p) => p.id === state.status.profileId))
    ?? (!wanted && state.profiles.length === 1 ? state.profiles[0] : undefined)
  if (!profile) {
    if (wanted) throw new Error(`没有叫「${wanted}」的档案。现有：${known()}`)
    throw new Error(state.profiles.length
      ? `还没有连接任何档案，而现有档案不止一份（${known()}）——用 /ocrc-host <档案名> 指定一台，或先在 ocrc Connect → 连接 里连上。`
      : '还没有档案——先在 ocrc Connect → 连接 里添加一个 SSH 目标（被控机）。')
  }

  const facts: HostFacts = {
    profile,
    active: state.status.profileId === profile.id && state.status.tunnel === 'up',
    tunnel: state.status,
    projectPath: options.projectPath ?? profile.projects?.[0]?.path,
  }
  if (!facts.active) return facts

  try {
    const inspected = await post<{ detect: DetectReport; readiness: ReadinessReport; anchor?: string; anchorSource: string }>(request, '/detect')
    facts.detect = inspected.detect
    facts.readiness = inspected.readiness
    facts.anchor = inspected.anchor
    facts.anchorSource = inspected.anchorSource
  } catch (e) {
    facts.probeError = message(e)
  }

  if (facts.projectPath) {
    try {
      facts.caps = await post<CapabilityReport>(request, '/capabilities', { projectPath: facts.projectPath })
    } catch (e) {
      facts.capsError = message(e)
    }
  }
  return facts
}

/** `startSession` 的四态如实翻译（`sent` 不是任务状态，是「首条消息发没发出去」）。 */
export function describeStartResult(result: StartSessionResult, label: string): string {
  if (result.sessionId === null) {
    return `会话没有建起来（${result.failure === 'bootstrap-failed' ? '项目目录初始化失败' : '会话创建失败'}）：${result.directory}`
  }
  const sent = result.sent === 'sent'
    ? '首条消息已发给模型'
    : result.sent === 'no-model'
      ? '会话已建，但模型侧没有可用凭据——消息没发出去（会话还在，可以在里面手动发）'
      : result.sent === 'failed'
        ? '会话已建，但首条消息发送失败（会话还在）'
        : '会话已建，但没有可发送的正文'
  return `已在项目「${label}」新建会话 ${result.sessionId}——${sent}`
}

/** 在 connectHost 的同一个 effect 里同步注册（契约：onResolve 越早注册越好，
 *  隐藏帧弹出时命令必须已经有处理者）。返回的函数注销它。 */
export function registerGuestCommands(host: HostClient): () => void {
  const request: RequestFn = (path, method = 'GET', body) =>
    host.serviceRequest({ method, path, body: body === undefined ? undefined : JSON.stringify(body) })

  return host.onResolve(async (submitted) => {
    if (submitted.command !== HOST_COMMAND && submitted.command !== PLAN_COMMAND) return null
    const mode: HostSummaryMode = submitted.command === PLAN_COMMAND ? 'plan' : 'status'
    return buildHostChip(await collectHostFacts(request, submitted.args), mode)
  })
}
