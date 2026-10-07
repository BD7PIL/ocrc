// zcode/accessor.ts — N0/N1 ghost IServiceAccessor.
// ZCode 的 UI 全部经单一 IServiceAccessor（39 服务字段）取数。
//
// 幽灵策略（反直觉但对）：方法默认返回 **rejected** promise，而不是永不
// resolve——Root 的启动门（isProviderStartupSyncPending 等）以「hydrate 完成
// 或出错」放行，挂起的 promise 会让启动永远停在门内（实测：oauth 恢复、
// modelSelection hydrate 双双卡死→白屏）。rejected 让门槛走 error 分支继续
// 引导；未接 catch 的调用点以 unhandledrejection 现形，就是 N1 的接线清单。
// 订阅类方法返回可 dispose 句柄。已填实的服务见 real map。
import type { IServiceAccessor } from '@zcode/services'
import { appSettingsSchema } from '@zcode/shared'
import { createOcrcTaskService } from '../zcode-services/zcodeTaskService.js'
import { createOcrcModelSelectionService } from '../zcode-services/modelSelectionService.js'
import { createOcrcFileService } from '../zcode-services/fileService.js'
import { createOcrcCommandsService } from '../zcode-services/commandsService.js'
import { createOcrcZcodeAgentService } from '../zcode-services/zcodeAgentService.js'
import { createOcrcZcodeSessionService } from '../zcode-services/zcodeSessionService.js'
import { createOcrcBotsService } from '../zcode-services/botsService.js'
import { createOcrcOffPeakTaskService } from '../zcode-services/offPeakTaskService.js'

const SUBSCRIBE_RE = /^(on[A-Z_]|onMessage|subscribe|add|listen|watch)/

function ghostMethod(service: string, name: string): any {
  return (..._args: unknown[]) => {
    if (SUBSCRIBE_RE.test(name)) {
      const un: any = () => {}
      un.dispose = () => {}
      return un
    }
    return Promise.reject(new Error(`[ocrc-fork] ${service}.${name} 尚未接入 ocrc`))
  }
}

// 同名服务/方法必须返回同一实例——Root 的 useMemo/useEffect 依赖
// services.xxxService 的引用相等性，每次新建 ghost 会触发无限重渲染（#185）。
function ghostService(name: string, cache: Map<string, any>): any {
  let svc = cache.get(`svc:${name}`)
  if (svc) return svc
  svc = new Proxy(function ghostService() {} as any, {
    get(_t, prop) {
      if (prop === 'then' || prop === 'toJSON') return undefined
      const key = `m:${name}:${String(prop)}`
      let method = cache.get(key)
      if (!method) {
        method = ghostMethod(name, String(prop))
        cache.set(key, method)
      }
      return method
    },
  })
  cache.set(`svc:${name}`, svc)
  return svc
}

/** settingService：用他们的 appSettingsSchema.parse({}) 出完整默认值——
    向导/恢复门/主题等一切都读 settings，空对象会让各处退回「未完成」态。 */
const minimalSettingService: any = (() => {
  let current: any = {
    ...appSettingsSchema.parse({}),
    // providerFamilyDomain 缺省 → 登录门无条件打开（shouldOpenLoginEntry =
    // !providerFamilyDomain || ...），壳永远停在欢迎页。ocrc 无账号体系，固定 zai。
    providerFamilyDomain: 'zai',
    locale: 'zh-CN',
    localePreference: 'zh-CN',
  }
  return {
    get: async () => current,
    update: async (patch: any) => {
      current = { ...current, ...(patch ?? {}) }
      return current
    },
    onChange: () => ({ dispose: () => {} }),
    updateDataBaseDir: async () => {},
    ensureDefaultProject: async () => ({ path: '/home/demo/develop/opencode-plugin/ocrc', created: false }),
  }
})()

/** onboarding 完成：ocrc 用户不需要 ZCode 的首次引导。 */
const ocrcOnboardingService: any = {
  shouldOnboard: async () => false,
  dismissOnboarding: async () => {},
  appendRecord: async () => {},
  claimAnonymousRecord: async () => {},
  getLatestEntry: async () => null,
  syncSettingsFromRecord: async () => null,
}

/** 登录态：ocrc 无 ZCode 账号体系——返回 ocrc 本地身份（复用面板已有的 token 鉴权）。 */
const ocrcOAuthService: any = {
  restoreCachedSessionState: async () => ({
    status: 'authenticated',
    userInfo: { id: 'ocrc-local', username: 'ocrc', displayName: 'ocrc' },
  }),
  getActiveProvider: async () => null,
  getProviders: async () => [],
}

/** Provider 设置视图：空 hydrated 面（N3 设置页接入 /api/settings 时填实）。 */
const ocrcProviderSettingsService: any = {
  onDidChange: () => ({ dispose: () => {} }),
  getView: async () => ({ revision: 0, providers: [] }),
  refresh: async () => ({ revision: 0, providers: [] }),
}

export function createGhostAccessor(): IServiceAccessor {
  const cache = new Map<string, any>()
  const real: Record<string, unknown> = {
    settingService: minimalSettingService,
    onboardingRecordService: ocrcOnboardingService,
    oauthService: ocrcOAuthService,
    modelSelectionService: createOcrcModelSelectionService(),
    providerSettingsService: ocrcProviderSettingsService,
    fileService: createOcrcFileService(),
    commandsService: createOcrcCommandsService(),
    zcodeAgentService: createOcrcZcodeAgentService(),
    zcodeSessionService: createOcrcZcodeSessionService(),
    botsService: createOcrcBotsService(),
    offPeakTaskService: createOcrcOffPeakTaskService(),
    zcodeTaskService: createOcrcTaskService(),
  }
  return new Proxy(
    real as Record<string, unknown>,
    {
      get(target, prop) {
        if (prop in target) return target[prop as string]
        if (prop === 'then' || prop === 'toJSON') return undefined
        const key = String(prop)
        let svc = cache.get(key)
        if (!svc) {
          svc = ghostService(key, cache)
          cache.set(key, svc)
        }
        return svc
      },
    },
  ) as unknown as IServiceAccessor
}
