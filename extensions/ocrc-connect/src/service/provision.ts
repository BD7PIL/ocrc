/** provisioning 编排——把探测、取件、安装串成一次可预演、可确认、可回滚的动作。
 *
 * 分工：`detect` 说现状，`artifact` 说取哪个件，`install` 说怎么落盘，
 * `runtime` 说能力要的运行时，`tunnels`/`capabilities` 说还差什么。这里只做决定
 * 顺序与串联，并保证一件事：**预演看到的动作就是执行的那个**（D3：安装与写配置
 * 需要一次显式确认）。
 *
 * 所有外部依赖（ssh exec、fetch、面板宿主 home、缓存目录）都是注入的，所以
 * 这个编排在 vitest 里可以完整跑，不需要真机。
 */
import { homedir } from 'node:os'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import type { DetectReport, ProvisionPlan, ReadinessReport, RuntimePlan, RuntimePlanItem, TargetPlatform } from '../shared/provision.js'
import { installDirFor, isSupportedEngineVersion, platformPackage } from '../shared/provision.js'
import { buildDetectScript, normalizeVersion, toDetectReport, toReadiness } from './detect.js'
import { cachedArtifactPath, defaultCacheDir, fetchArtifactToCache, resolveArtifact, type ArtifactRef } from './artifact.js'
import {
  buildIdentityScript, buildInstallScript, buildRollbackScript, buildUninstallScript,
  decideInstall, parseIdentityOutput, parseInstallOutput, type InstallOutcome,
} from './install.js'
import {
  buildRuntimeDiscoverScript, buildRuntimeInstallScript, buildRuntimePlan, buildRuntimeRemoveScript,
  factsFromDetect, parseRuntimeDiscoverOutput, parseRuntimeInstallOutput, type RuntimeOutcome,
} from './runtime.js'
import type { RuntimeNeed } from '../shared/provision.js'
import type { SshProfile } from '../shared/protocol.js'

export interface ProvisionDeps {
  /** 目标机执行一条 sh 脚本（service 注入 remote-fs 的 sshExec）。 */
  exec: (profile: SshProfile, script: string, options?: { timeoutMs?: number; stdin?: string }) => Promise<{ code: number | null; stdout: string; stderr: string }>
  /** 面板宿主本地跑一条命令（读面板引擎版本用）。 */
  execLocal?: (command: string, args: string[]) => Promise<string>
  fetchImpl?: typeof fetch
  /** 面板宿主的 home（缓存与 `~/.opencode/bin` 都在这下面）。 */
  home?: string
  cacheDir?: string
  /** registry 基址——只给测试/验收用；产品路径固定是官方 registry。 */
  registry?: string
}

const SSH_TIMEOUT_MS = 60_000
const INSTALL_TIMEOUT_MS = 15 * 60_000

export function createProvisioner(deps: ProvisionDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch
  const home = deps.home ?? homedir()
  // 缓存目录可以单独指（验收/多档共存）——**不要靠改 HOME 来挪它**：Windows 的
  // ssh 从 HOME 找私钥，改 HOME 会连带把认证打断（accept-provision 实测）。
  const cacheDir = deps.cacheDir ?? process.env.OCRC_CACHE_DIR?.trim() ?? defaultCacheDir(home)
  const execLocal = deps.execLocal ?? defaultExecLocal

  /** 面板宿主的引擎版本——**唯一版本源**（D6）。读不到就如实说读不到，
   *  绝不退化成「跟 latest」。 */
  async function anchorVersion(override?: string): Promise<{ version?: string; source: string }> {
    if (override) return { version: override, source: '档案（面板宿主未提供引擎）' }
    const fromEnv = process.env.OCRC_ENGINE_VERSION?.trim()
    if (fromEnv) return { version: normalizeVersion(fromEnv), source: 'OCRC_ENGINE_VERSION' }
    const binary = installDirFor(home) + '/opencode'
    const stdout = await execLocal(binary, ['--version']).catch(() => '')
    const version = stdout ? normalizeVersion(stdout) : ''
    if (version && isSupportedEngineVersion(version)) return { version, source: `面板宿主 ${binary}` }
    return { source: '面板宿主没有可用的 opencode v2' }
  }

  /** 一次探测 + 四档就绪。 */
  async function inspect(profile: SshProfile, options: { anchor?: string } = {}): Promise<{
    detect: DetectReport
    readiness: ReadinessReport
    anchor?: string
    anchorSource: string
  }> {
    const { code, stdout, stderr } = await deps.exec(profile, buildDetectScript(), { timeoutMs: SSH_TIMEOUT_MS })
    const detect = toDetectReport(stdout, { reachable: code === 0, stderr })
    const anchor = await anchorVersion(options.anchor ?? profile.engineVersion)
    return {
      detect,
      readiness: toReadiness(detect, { projectPath: profile.projects?.[0]?.path, anchorVersion: anchor.version }),
      anchor: anchor.version,
      anchorSource: anchor.source,
    }
  }

  /** 预演：要装什么、从哪取、多少字节、为什么。确认框里显示的就是这个。 */
  async function plan(profile: SshProfile, report: DetectReport, options: { anchor?: string } = {}): Promise<
    { plan: ProvisionPlan; artifact: ArtifactRef } | { error: string }
  > {
    if (!report.reachable || !report.platform) {
      return { error: report.unsupportedReason ?? report.error ?? '目标机不可达，无法规划部署' }
    }
    const anchor = await anchorVersion(options.anchor ?? profile.engineVersion)
    if (!anchor.version) {
      return { error: `${anchor.source}——面板宿主必须有一份可用的 opencode v2 作为版本源（D6：镜像面板宿主，不 follow latest）` }
    }
    if (report.unsupportedReason) return { error: report.unsupportedReason }

    // baseline 只在官方发了这个变体时才选（arm64 没有 baseline）。
    const variant: 'default' | 'baseline' = report.baseline && report.platform.endsWith('x64') ? 'baseline' : 'default'
    let artifact: ArtifactRef
    try {
      artifact = await resolveArtifact(report.platform, variant, anchor.version, { fetchImpl, registry: deps.registry })
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }

    const identity = parseIdentityOutput(
      (await deps.exec(profile, buildIdentityScript(report.home ?? ''), { timeoutMs: SSH_TIMEOUT_MS })).stdout,
    )
    const decision = decideInstall(identity, { version: anchor.version, integrity: artifact.integrity })
    const source: 'remote' | 'push' = report.outbound ? 'remote' : 'push'
    const remoteHome = report.home ?? '/home/unknown'
    return {
      plan: {
        action: decision.action === 'none' ? 'none' : decision.action === 'install' ? 'install' : decision.action,
        target: report.platform,
        variant,
        package: platformPackage(report.platform, variant),
        version: anchor.version,
        integrity: artifact.integrity,
        source,
        installDir: installDirFor(remoteHome),
        home: remoteHome,
        currentVersion: identity.version,
        reason: `${decision.reason}；取件方式：${source === 'remote' ? `被控端自己下载（出网可达，${anchor.source}）` : '从面板推送缓存工件（被控端不出网）'}`,
        anchorVersion: anchor.version,
      },
      artifact,
    }
  }

  /** 执行：推送前先确保缓存里有校验过的工件；安装后复核版本。 */
  async function apply(profile: SshProfile, plan: ProvisionPlan, artifact: ArtifactRef): Promise<InstallOutcome & { rolledBack?: boolean }> {
    if (plan.action === 'none') return { ok: true, version: plan.currentVersion }

    let uploadedTar: string | undefined
    if (plan.source === 'push') {
      // air-gapped 推送不许在这一刻联网：缓存没有就明说，而不是偷偷去下载。
      const cached = await cachedArtifactPath(artifact, cacheDir)
      if (!cached) {
        return { ok: false, error: '本地缓存里没有这份工件——先在面板侧联网执行一次「下载工件」，再推给不出网的被控机' }
      }
      // 上传走 `base64 -d` 管道（被控端只需要 sh + base64，不需要 sftp/scp）。
      const remoteTar = `$HOME/.ocrc-upload-${artifact.version}.tgz`
      const bytes = await readFile(cached)
      const upload = await deps.exec(
        profile,
        `mkdir -p "$HOME/.ocrc" && base64 -d > ${remoteTar} && echo OCRC_UPLOADED=1`,
        { timeoutMs: INSTALL_TIMEOUT_MS, stdin: bytes.toString('base64') },
      ).catch((error: unknown) => ({ code: null, stdout: '', stderr: error instanceof Error ? error.message : String(error) }))
      if (upload.code !== 0 || !upload.stdout.includes('OCRC_UPLOADED=1')) {
        return { ok: false, error: `推送工件失败：${upload.stderr.trim().split('\n')[0] || 'ssh 中断'}` }
      }
      uploadedTar = remoteTar
    }

    const script = buildInstallScript({
      home: plan.home,
      version: plan.version,
      integrity: plan.integrity,
      packageName: plan.package,
      platform: plan.target,
      uploadedTar,
      downloadUrl: plan.source === 'remote' ? artifact.tarballUrl : undefined,
    })
    const { stdout, stderr } = await deps.exec(profile, script, { timeoutMs: INSTALL_TIMEOUT_MS })
    const outcome = parseInstallOutput(stdout, plan.integrity)
    if (!outcome.ok) {
      // 脚本一个字都没说时，`ssh` 自己那句话才是原因（超时/拒绝/主机不可达）——
      // 用它替换掉「脚本没有给出结果」这种无从下手的说法。
      const sshSaid = stderr.trim().split('\n')[0]
      const silent = !stdout.includes('OCRC_ERR=') && !stdout.includes('OCRC_OK=')
      return {
        ...outcome,
        error: silent && sshSaid ? `安装没有落盘：${sshSaid}` : outcome.error,
      }
    }
    return outcome
  }

  async function rollback(profile: SshProfile, platform: TargetPlatform, homeDir: string): Promise<boolean> {
    const { stdout } = await deps.exec(profile, buildRollbackScript(homeDir, platform), { timeoutMs: SSH_TIMEOUT_MS })
    return stdout.includes('OCRC_ROLLED_BACK=1')
  }

  async function uninstall(profile: SshProfile, homeDir: string): Promise<boolean> {
    const { stdout } = await deps.exec(profile, buildUninstallScript(homeDir), { timeoutMs: SSH_TIMEOUT_MS })
    return stdout.includes('OCRC_UNINSTALLED=1')
  }

  /** 把工件拉进面板缓存（联网路；air-gapped 场景由用户在能上网的地方先跑一次）。 */
  async function prefetch(artifact: ArtifactRef): Promise<{ path: string }> {
    return { path: await fetchArtifactToCache(artifact, { dir: cacheDir, fetchImpl }) }
  }

  /** 运行时计划：先一条 ssh 问完现状，再逐项决定 install/present/impossible。
   *  `detect` 可复用调用方手里的那一份（面板刚探过），避免两次探测之间出现窗口。 */
  async function planRuntime(
    profile: SshProfile,
    needs: Array<{ need: RuntimeNeed; neededBy: string[] }>,
    options: { detect?: DetectReport; anchor?: string } = {},
  ): Promise<RuntimePlan> {
    const detect = options.detect ?? (await inspect(profile, { anchor: options.anchor })).detect
    const home = detect.home ?? ''
    if (needs.length === 0) return buildRuntimePlan([], factsFromDetect(detect, home), new Map())
    const discovery = await deps.exec(profile, buildRuntimeDiscoverScript(home, needs.map((n) => n.need)), { timeoutMs: SSH_TIMEOUT_MS })
    return buildRuntimePlan(needs, factsFromDetect(detect, home), parseRuntimeDiscoverOutput(discovery.stdout, needs.map((n) => n.need)))
  }

  /** 装一项运行时。计划里那一项原样执行（预演看到的动作就是执行的那个）；落点由
   *  调用方按目标机的 home 复核过，这里只负责跑脚本与解析结果。 */
  async function applyRuntime(
    profile: SshProfile,
    item: RuntimePlanItem,
    options: { home: string; registry?: string; force?: boolean },
  ): Promise<RuntimeOutcome> {
    if (item.action !== 'install') {
      return {
        ok: false,
        error: item.action === 'present'
          ? '这一项在目标机上已经就位，无需安装'
          : `这一项装不了：${item.reason ?? '原因未知'}`,
      }
    }
    const script = buildRuntimeInstallScript({
      home: options.home,
      need: item.need,
      // 验收用本地 fixture registry；产品路径固定是官方 registry。
      registry: options.registry ?? deps.registry,
      force: options.force,
    })
    const { code, stdout, stderr } = await deps.exec(profile, script, { timeoutMs: INSTALL_TIMEOUT_MS })
    const outcome = parseRuntimeInstallOutput(stdout, item.need.raw)
    if (!outcome.ok) {
      const said = stderr.trim().split('\n')[0]
      const silent = !stdout.includes('OCRC_ERR=') && !stdout.includes('RUNTIME_DONE=1')
      return { ...outcome, error: silent && said ? `安装没有落盘：${said}` : (outcome.error ?? `ssh exit ${code}`) }
    }
    return outcome
  }

  async function removeRuntime(profile: SshProfile, dir: string): Promise<boolean> {
    const { stdout } = await deps.exec(profile, buildRuntimeRemoveScript(dir), { timeoutMs: SSH_TIMEOUT_MS })
    return stdout.includes('OCRC_REMOVED=1')
  }

  return {
    inspect, plan, apply, rollback, uninstall, prefetch,
    planRuntime, applyRuntime, removeRuntime,
    anchorVersion, cacheDir,
  }
}

function defaultExecLocal(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(stdout.trim()) : reject(new Error(`exit ${code}`))))
  })
}

export type Provisioner = ReturnType<typeof createProvisioner>
