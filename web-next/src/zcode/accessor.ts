// zcode/accessor.ts — N0 ghost IServiceAccessor.
// ZCode 的 UI 全部经单一 IServiceAccessor（39 服务字段）取数。N0 用「幽灵服务」
// 先让 Root/壳渲染：方法调用返回永不 resolve 的 Promise（组件停留加载态，绝不
// 用 undefined 数据崩 canvas），订阅类方法返回可 dispose 句柄；只有
// settingService 给最小真实现（intl/locale 引导需要）。N1+ 逐服务用 ocrc 的
// REST/WS 填实。
import type { IServiceAccessor } from '@zcode/services'

const SUBSCRIBE_RE = /^(on[A-Z_]|onMessage|subscribe|add|listen|watch)/

function ghostMethod(name: string): any {
  return (..._args: unknown[]) => {
    if (SUBSCRIBE_RE.test(name)) {
      const un: any = () => {}
      un.dispose = () => {}
      return un
    }
    return new Promise(() => {}) // never resolves → loading state, never garbage data
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
        method = ghostMethod(String(prop))
        cache.set(key, method)
      }
      return method
    },
  })
  cache.set(`svc:${name}`, svc)
  return svc
}

/** Minimal real settingService — ZCodeIntlProvider blocks the whole shell on it. */
const minimalSettingService: any = {
  get: async () => ({ locale: 'zh-CN', localePreference: 'zh-CN' }),
  update: async () => {},
  onChange: () => ({ dispose: () => {} }),
}

export function createGhostAccessor(): IServiceAccessor {
  const cache = new Map<string, any>()
  return new Proxy(
    { settingService: minimalSettingService } as Record<string, unknown>,
    {
      get(target, prop) {
        if (prop === 'settingService') return target.settingService
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
