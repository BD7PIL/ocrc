// zcode-services/ghost.ts — 幽灵服务/方法的统一形状（N6 批次 0）。
//
// 未接入的 ZCode 服务面必须**可预测地失败**：Root 的启动门以「hydrate 完成或
// 出错」放行，挂起的 promise 会让白屏；裸对象缺方法则是调用点 TypeError，在
// promise 链里极难定位。
//
// 分类按语义而非名字前缀：只有 on* 是事件订阅，其余全按命令 reject。曾经的前缀
// 启发式（on|subscribe|add|listen|watch）把命令当事件静默"成功"——addMarketplace
// 返回一个函数（UI 以为装上了）、watch(...).then 直接 TypeError（文件树崩）、
// subscribeSessionsIndexV4 的 await 拿到函数再取 .ack 崩。

const EVENT_RE = /^on[A-Z_]/

/** 事件方法要同时满足两种调用形状：`onMessage(cb)` 直接返回 disposable，
 *  `onDynamicChange(id)(cb)` 先取 Event 再订阅。所以返回值既可调用、又自带
 *  `.dispose`。 */
export function ghostEventMethod(): any {
  const subscribe: any = () => ({ dispose: () => {} })
  subscribe.dispose = () => {}
  return subscribe
}

/** 方法形状的幽灵：事件返回可订阅句柄，命令返回 rejected promise。 */
export function ghostMethod(service: string, name: string, hint = ''): any {
  if (EVENT_RE.test(name)) return () => ghostEventMethod()
  return () => Promise.reject(new Error(`[ocrc-fork] ${service}.${name} 尚未接入 ocrc${hint}`))
}

/**
 * 给已实现的服务套上幽灵兜底：命中的方法用真实现，未命中的走 ghostMethod。
 * 同时保证同名服务/方法返回同一实例——Root 的 useMemo/useEffect 依赖
 * `services.xxxService` 的引用相等性，每次新建会触发无限重渲染（#185）。
 */
export function withGhosts(serviceName: string, impl: Record<string, any>, hint = ''): any {
  const cache = new Map<string, any>()
  return new Proxy(impl, {
    get(target, prop) {
      if (prop in target) return target[prop as string]
      if (prop === 'then' || prop === 'toJSON') return undefined
      const key = String(prop)
      let method = cache.get(key)
      if (!method) {
        method = ghostMethod(serviceName, key, hint)
        cache.set(key, method)
      }
      return method
    },
  })
}
