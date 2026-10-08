// zcode-services/providerSettingsService.ts — ocrc-backed IProviderSettingsService（N6 批次 1）。
//
// ZCode「设置 → 模型设置」的数据面。两个数据源分工必须分清：
//   · **编辑面以引擎配置文件为准**（GET /api/settings/opencode-config 的只读摘要：
//     baseURL / hasKey / keyHint / models）。刚新建、引擎尚未重载的供应商必须立刻
//     可见，否则 UI 走「创建成功但列表没有」的裂脑。
//   · /api/models 只是**运行时目录**，用来补显示名与 variants（推理档位）。
//
// 写路径就是 host 既有的结构化 patch（POST /api/settings/opencode-config/provider，
// JSONC 校验 + *.ocrc-bak 备份 + 原子写）——旧 rc.2 面板走的是同一条，不是新能力。
// API key 只进不出：UI 只拿到 hasKey/keyHint，连测由 host 侧发起（test-provider）。
import { withGhosts } from './ghost.js'

interface OcrcConfigProvider {
  id: string
  name?: string
  baseURL?: string
  hasKey: boolean
  keyHint?: string
  models: Array<{ id: string; name?: string }>
}
interface OcrcConfigSummary {
  path: string
  raw: string
  parsed: boolean
  providers: OcrcConfigProvider[]
  error?: string
}
interface OcrcRuntimeModel { id: string; name?: string; variants?: string[] }
interface OcrcRuntimeProvider { id: string; name?: string; models?: OcrcRuntimeModel[] }

/** ZCode 的 apiFormat 枚举里与 ocrc 引擎（OpenAI 兼容面）对应的那一项。 */
const API_TYPE = 'openai-chat-completions'

function token(): string {
  try { return localStorage.getItem('ocrc.token') ?? '' } catch { return '' }
}

function auth(): Record<string, string> {
  return { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' }
}

function slug(input: string): string {
  return input.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
}

function uniqueId(base: string, taken: readonly string[]): string {
  const seed = base || 'provider'
  if (!taken.includes(seed)) return seed
  for (let i = 2; i < 1000; i++) {
    const candidate = `${seed}-${i}`
    if (!taken.includes(candidate)) return candidate
  }
  return `${seed}-${Date.now()}`
}

export function createOcrcProviderSettingsService(): any {
  const listeners = new Set<(view: any) => void>()
  let revision = 0

  async function readConfig(): Promise<OcrcConfigSummary> {
    const res = await fetch('/api/settings/opencode-config', { headers: auth() }).catch(() => null)
    if (!res?.ok) {
      const body = (await res?.json().catch(() => ({}))) as { error?: string } | undefined
      throw new Error(`读取引擎配置失败：${body?.error ?? res?.status ?? '网络错误'}`)
    }
    return (await res.json()) as OcrcConfigSummary
  }

  async function runtimeCatalog(): Promise<OcrcRuntimeProvider[]> {
    const res = await fetch('/api/models', { headers: auth() }).catch(() => null)
    if (!res?.ok) return []
    const body = (await res.json()) as OcrcRuntimeProvider[] | { providers?: OcrcRuntimeProvider[] }
    return Array.isArray(body) ? body : body.providers ?? []
  }

  async function post(path: string, body: unknown): Promise<void> {
    const res = await fetch(path, { method: 'POST', headers: auth(), body: JSON.stringify(body) }).catch((e) => {
      throw new Error(`${path} 网络失败：${(e as Error).message}`)
    })
    if (!res.ok) {
      const detail = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(`${path} ${res.status}${detail.error ? `：${detail.error}` : ''}`)
    }
    const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
    // 结构化写路径以 200 + {ok:false} 报业务失败（不出 console 资源噪音）——必须当失败处理
    if (payload.ok === false) throw new Error(payload.error ?? `${path} 写入被拒绝`)
  }

  function emit(view: any): void {
    for (const listener of listeners) {
      try { listener(view) } catch { /* 监听器自身异常不影响写入结果 */ }
    }
  }

  /** 写后重取视图并广播（ZCode 的 onDidChange 在 ocrc 里就是「我们写完推一次」）。 */
  async function afterWrite(): Promise<any> {
    const view = await getView()
    emit(view)
    return view
  }

  async function getView(): Promise<any> {
    const [config, runtime] = await Promise.all([readConfig(), runtimeCatalog()])
    const runtimeById = new Map(runtime.map((p) => [p.id, p]))
    const providers = config.providers.map((p) => buildProviderView(p, runtimeById.get(p.id)))
    revision += 1
    return {
      revision,
      // ocrc 没有 ZCode 的供应商模板库：新建走「创建自定义供应商」表单。
      providerTemplates: [],
      providerOrder: providers.map((p: any) => p.providerId),
      providers,
    }
  }

  function buildProviderView(p: OcrcConfigProvider, runtime?: OcrcRuntimeProvider): any {
    const providerName = p.name || runtime?.name || p.id
    const runtimeModels = runtime?.models ?? []
    const runtimeModelById = new Map(runtimeModels.map((m) => [m.id, m]))
    // 有 models 白名单 = 只有白名单里的模型可用；没有 = 该供应商目录全开（opencode 语义）。
    const hasWhitelist = p.models.length > 0
    const enabledIds = hasWhitelist ? p.models.map((m) => m.id) : runtimeModels.map((m) => m.id)
    const orderedIds = [...enabledIds, ...runtimeModels.map((m) => m.id).filter((id) => !enabledIds.includes(id))]
    return {
      providerId: p.id,
      providerName,
      templateId: p.id,
      enabled: true,
      // executable = 运行时目录里有它（引擎真能跑）；刚建好还没进目录的供应商不算。
      executable: !!runtime,
      effectiveConfig: {
        providerId: p.id,
        providerName,
        // 分区键：设置页把 group==='standard-personal' 的供应商归入「自定义供应商」，
        // 缺失 group 的会被整段过滤掉（新建的供应商在列表里彻底消失）。
        group: 'standard-personal',
        api: { type: API_TYPE, baseUrl: p.baseURL },
        // apiKey 只回 hint——真实 key 永不出 host（写入是 write-only）。
        access: { type: 'api-key', apiKey: p.keyHint ?? null },
        builtinModelIds: runtimeModels.map((m) => m.id),
        personalModelIds: hasWhitelist ? p.models.map((m) => m.id) : undefined,
        modelOrder: orderedIds,
      },
      // 可编辑覆盖层 = 引擎配置里该供应商的真实内容；保存时 UI 回传的就是这一层
      // （providerPersonalSave 会剥掉 model 列表字段后调 savePersonalProviderOverlay）。
      personalConfig: {
        group: 'standard-personal',
        api: p.baseURL ? { type: API_TYPE, baseUrl: p.baseURL } : undefined,
        access: { type: 'api-key' },
      },
      issues: [],
      models: orderedIds.map((id) => {
        const rt = runtimeModelById.get(id)
        const configured = p.models.find((m) => m.id === id)
        const displayName = configured?.name ?? rt?.name ?? id
        const variants = rt?.variants ?? []
        return {
          kind: 'candidate',
          modelId: id,
          builtin: !!rt,
          effectiveBuiltinConfig: { displayName: rt?.name ?? displayName },
          effectiveConfig: {
            displayName,
            optionSpecs: { reasoningLevel: { values: variants } },
            variants,
          },
          enabled: enabledIds.includes(id),
          executable: !!rt,
          selectable: !!rt,
          issues: [],
        }
      }),
    }
  }

  /** 当前启用集合（白名单语义）：无白名单时以运行时目录为底，做增删的起点。 */
  async function currentEnabledIds(providerId: string): Promise<string[]> {
    const [config, runtime] = await Promise.all([readConfig(), runtimeCatalog()])
    const p = config.providers.find((x) => x.id === providerId)
    if (!p) throw new Error(`供应商 ${providerId} 不存在`)
    if (p.models.length > 0) return p.models.map((m) => m.id)
    return (runtime.find((x) => x.id === providerId)?.models ?? []).map((m) => m.id)
  }

  async function writeModels(providerId: string, ids: readonly string[], nameOf: (id: string) => string | undefined): Promise<any> {
    await post('/api/settings/opencode-config/provider', {
      providerId,
      models: ids.map((id) => ({ id, ...(nameOf(id) ? { name: nameOf(id) } : {}) })),
    })
    return afterWrite()
  }

  return withGhosts('providerSettingsService', {
    onDidChange: (listener: (view: any) => void) => {
      listeners.add(listener)
      return { dispose: () => { listeners.delete(listener) } }
    },
    getView,
    refresh: (_reason?: string) => getView(),

    /** ZCode 的自定义供应商创建：ocrc 侧生成 providerId 并写入引擎配置。 */
    createPersonalProvider: async (input?: {
      templateId?: string
      providerName?: string
      initialConfig?: { api?: { baseUrl?: string }; access?: { apiKey?: string } }
    }) => {
      const config = await readConfig()
      const existing = config.providers.map((p) => p.id)
      const providerName = input?.providerName?.trim() || input?.templateId || 'provider'
      const providerId = uniqueId(slug(providerName) || slug(input?.templateId ?? ''), existing)
      const baseURL = input?.initialConfig?.api?.baseUrl
      const apiKey = input?.initialConfig?.access?.apiKey
      await post('/api/settings/opencode-config/provider', {
        providerId,
        name: providerName,
        ...(typeof baseURL === 'string' && baseURL ? { baseURL } : {}),
        ...(typeof apiKey === 'string' && apiKey ? { apiKey } : {}),
      })
      return { providerId, view: await afterWrite() }
    },

    /** 供应商覆盖层保存：baseUrl / apiKey 直写（key 空 = 不动）。 */
    savePersonalProviderOverlay: async (
      providerId: string,
      config: { api?: { baseUrl?: string }; access?: { apiKey?: string } | null },
      metadata?: { providerName?: string; enabled?: boolean },
    ) => {
      const baseURL = config?.api?.baseUrl
      const rawKey = config?.access && typeof config.access === 'object' ? config.access.apiKey : undefined
      // 视图里的 apiKey 是 host 给的 keyHint（sk-a…1234 形态，供 UI 显示「已配置」）。
      // 那是提示不是凭证——真被回写就等于用占位符覆盖真 key，必须挡住。
      const apiKey = typeof rawKey === 'string' && rawKey.includes('…') ? undefined : rawKey
      const name = metadata?.providerName
      await post('/api/settings/opencode-config/provider', {
        providerId,
        ...(typeof name === 'string' && name ? { name } : {}),
        ...(typeof baseURL === 'string' ? { baseURL } : {}),
        ...(typeof apiKey === 'string' && apiKey ? { apiKey } : {}),
      })
      return afterWrite()
    },

    deletePersonalProvider: async (providerId: string) => {
      await post('/api/settings/opencode-config/provider', { providerId, delete: true })
      return afterWrite()
    },

    reorderPersonalProviders: async (providerIds: readonly string[]) => {
      await post('/api/settings/opencode-config/reorder', { providerIds })
      return afterWrite()
    },

    reorderPersonalModels: async (providerId: string, modelIds: readonly string[]) => {
      await post('/api/settings/opencode-config/reorder', { providerId, modelIds })
      return afterWrite()
    },

    addPersonalModel: async (providerId: string, modelId: string, config?: { displayName?: string }) => {
      const ids = await currentEnabledIds(providerId)
      if (ids.includes(modelId)) return afterWrite()
      const next = [...ids, modelId]
      return writeModels(providerId, next, (id) => (id === modelId ? config?.displayName : undefined))
    },

    renamePersonalModel: async (providerId: string, currentModelId: string, nextModelId: string) => {
      const config = await readConfig()
      const p = config.providers.find((x) => x.id === providerId)
      const renamed = (p?.models ?? []).map((m) => (m.id === currentModelId ? { ...m, id: nextModelId } : m))
      const ids = renamed.length ? renamed.map((m) => m.id) : (await currentEnabledIds(providerId)).map((id) => (id === currentModelId ? nextModelId : id))
      const nameOf = (id: string) => renamed.find((m) => m.id === id)?.name
      return writeModels(providerId, ids, nameOf)
    },

    deletePersonalModel: async (providerId: string, modelId: string) => {
      const ids = (await currentEnabledIds(providerId)).filter((id) => id !== modelId)
      return writeModels(providerId, ids, () => undefined)
    },

    /** 草稿保存 = 把 nextModelId 落进白名单（改名时替换原 id）。 */
    savePersonalModelDraft: async (input: {
      providerId: string
      originalModelId: string
      nextModelId: string
      personalConfig?: { displayName?: string }
    }) => {
      const ids = await currentEnabledIds(input.providerId)
      const next = ids.map((id) => (id === input.originalModelId ? input.nextModelId : id))
      if (!next.includes(input.nextModelId)) next.push(input.nextModelId)
      return writeModels(input.providerId, next, (id) => (id === input.nextModelId ? input.personalConfig?.displayName : undefined))
    },

    setPersonalModelEnabled: async (providerId: string, modelId: string, enabled: boolean) => {
      const ids = await currentEnabledIds(providerId)
      const next = enabled ? (ids.includes(modelId) ? ids : [...ids, modelId]) : ids.filter((id) => id !== modelId)
      return writeModels(providerId, next, () => undefined)
    },

    /** 连通性连测走 host（key 不出 host）；失败如实回 error，不假装 ok。 */
    testModelConnectivity: async (input: { providerId: string }) => {
      const res = await fetch('/api/settings/test-provider', {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ providerId: input.providerId }),
      }).catch((e) => { throw new Error(`连通性测试请求失败：${(e as Error).message}`) })
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; latencyMs?: number }
      if (body.ok) return { success: true, latencyMs: body.latencyMs }
      return { success: false, error: { message: body.error ?? `HTTP ${res.status}`, code: 'provider-unavailable' } }
    },

    resolveModelConfig: async (input: { providerId: string; modelId: string; personalConfig?: Record<string, unknown> }) => {
      const [config, runtime] = await Promise.all([readConfig(), runtimeCatalog()])
      const p = config.providers.find((x) => x.id === input.providerId)
      const rt = runtime.find((x) => x.id === input.providerId)
      const rtModel = rt?.models?.find((m) => m.id === input.modelId)
      const inherited = {
        providerId: input.providerId,
        providerName: p?.name ?? rt?.name ?? input.providerId,
        api: { type: API_TYPE, baseUrl: p?.baseURL },
        access: { type: 'api-key', apiKey: p?.keyHint ?? null },
      }
      return {
        inheritedConfig: inherited,
        effectiveConfig: {
          ...inherited,
          ...(input.personalConfig ?? {}),
          displayName: (input.personalConfig?.displayName as string) ?? rtModel?.name ?? input.modelId,
        },
        issues: [],
      }
    },
  })
}
